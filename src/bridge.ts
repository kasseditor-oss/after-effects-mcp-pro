import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { aePids, aeReady, bridgeDir, findInstalls, isMac, isWin } from "./env.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_VERSION = "2.0.1";

export class AEError extends Error {
  constructor(message: string, public hint?: string, public code: string = "AE_ERROR") {
    super(message);
  }
}

export type Mode = "listener" | "direct";

export interface CallOptions {
  timeoutMs?: number;
  /** Wrap the call in one After Effects undo group (default true). */
  undo?: boolean;
  /** The tool accepts timeoutSeconds, so timeout errors can suggest it. */
  timeoutParam?: boolean;
  /** Called when the AE side reports progress (batch). */
  onProgress?: (done: number, total: number, message?: string) => void;
  /** Client cancellation (MCP request signal). Only calls that have not started in AE can be cancelled. */
  signal?: AbortSignal;
  /** Internal: this call is the automatic resend after an I/O error. */
  isRetry?: boolean;
}

interface Heartbeat {
  time: number;
  version: string;
  ae: string;
  paused: boolean;
  executed: number;
  project: string;
}

function loadRuntimeSource(): string {
  const candidates = [path.join(here, "jsx", "runtime.jsx"), path.join(here, "..", "src", "jsx", "runtime.jsx")];
  for (const c of candidates) if (fs.existsSync(c)) return fs.readFileSync(c, "utf8");
  throw new Error("runtime.jsx not found next to the server build");
}

/** Escape a string so it is a valid ExtendScript (ES3) string literal. */
export function jsString(s: string): string {
  // split/join instead of a regex literal: some compilers emit the raw U+2028 char inside the regex
  return JSON.stringify(s).split(String.fromCharCode(0x2028)).join("\\u2028").split(String.fromCharCode(0x2029)).join("\\u2029");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Transport between the MCP server and After Effects.
 *
 * - listener mode: the Startup listener inside AE polls `<bridge>/queue` every
 *   120 ms. Fast, no window focus changes. Used when its heartbeat is fresh.
 * - direct mode: `AfterFX.exe -r script.jsx` (Windows) or AppleScript
 *   `DoScriptFile` (macOS) asks the running AE to execute the script. Works
 *   with zero setup when the listener is missing.
 *
 * Each call gets a unique id and its own result file, so concurrent calls can
 * never read each other's results (a bug in file-based bridges that share a
 * single result file).
 */
export class Bridge {
  readonly dir = bridgeDir();
  readonly runtimeHash: string;
  private runtimePath: string;
  private runningCache: { at: number; value: boolean } = { at: 0, value: false };
  private chain: Promise<unknown> = Promise.resolve();
  lastMode: Mode | null = null;
  private pids: number[] = [];
  private readyPids = new Set<number>();
  private lastAliveCheck = 0;
  readonly stats = { calls: 0, timeouts: 0, ioErrors: 0, latencies: [] as number[] };

  constructor() {
    for (const sub of ["queue", "results", "direct", "frames", "runtime"]) fs.mkdirSync(path.join(this.dir, sub), { recursive: true });
    const src = loadRuntimeSource();
    this.runtimeHash = crypto.createHash("sha1").update(src).update(SERVER_VERSION).digest("hex").slice(0, 12);
    this.runtimePath = path.join(this.dir, "runtime", `runtime-${this.runtimeHash}.jsx`);
    if (!fs.existsSync(this.runtimePath)) {
      const body = src.replace(/__AEMCP_VERSION__/g, SERVER_VERSION).replace(/__AEMCP_HASH__/g, this.runtimeHash);
      fs.writeFileSync(this.runtimePath, body, "utf8");
    }
    this.cleanup();
  }

  /** Remove stale result/command files older than 1 hour. */
  private cleanup() {
    const cutoff = Date.now() - 3600_000;
    for (const sub of ["results", "direct", "frames"]) {
      const d = path.join(this.dir, sub);
      for (const f of fs.readdirSync(d)) {
        try {
          const p = path.join(d, f);
          if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
    // stale queue entries would run unexpectedly on next AE start: drop them
    const q = path.join(this.dir, "queue");
    for (const f of fs.readdirSync(q)) {
      try {
        const p = path.join(q, f);
        if (fs.statSync(p).mtimeMs < Date.now() - 300_000) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
    for (const f of fs.readdirSync(path.join(this.dir, "runtime"))) {
      if (f !== path.basename(this.runtimePath)) {
        try {
          fs.unlinkSync(path.join(this.dir, "runtime", f));
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Latency of the last 50 calls plus error counters, for bridge_status. */
  diagnostics() {
    const l = [...this.stats.latencies].sort((a, b) => a - b);
    const pick = (q: number) => (l.length ? l[Math.min(l.length - 1, Math.floor(q * l.length))] : null);
    return {
      calls: this.stats.calls,
      lastMode: this.lastMode,
      latencyMs: { samples: l.length, avg: l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : null, p50: pick(0.5), p95: pick(0.95) },
      timeouts: this.stats.timeouts,
      ioErrorsRetried: this.stats.ioErrors,
    };
  }

  /** Warning text when the installed listener is older/newer than this server. */
  listenerVersionWarning(): string | null {
    const hb = this.heartbeat();
    if (!hb || hb.ageMs > 10_000 || hb.version === SERVER_VERSION) return null;
    return `The After Effects listener is version ${hb.version} but the server is ${SERVER_VERSION}. Run "npm run install-ae" in the server folder to update it.`;
  }

  heartbeat(): (Heartbeat & { ageMs: number }) | null {
    try {
      const hb = JSON.parse(fs.readFileSync(path.join(this.dir, "heartbeat.json"), "utf8")) as Heartbeat;
      return { ...hb, ageMs: Date.now() - hb.time };
    } catch {
      return null;
    }
  }

  aeRunning(): boolean {
    if (Date.now() - this.runningCache.at < 2000) return this.runningCache.value;
    this.pids = aePids();
    const value = this.pids.length > 0;
    this.runningCache = { at: Date.now(), value };
    return value;
  }

  chooseMode(): Mode {
    const forced = process.env.AE_MCP_MODE as Mode | undefined;
    if (forced === "listener" || forced === "direct") return forced;
    const hb = this.heartbeat();
    if (hb && hb.ageMs < 4000 && !hb.paused) return "listener";
    if (hb && hb.ageMs < 4000 && hb.paused) {
      throw new AEError("The AE MCP Pro bridge is paused inside After Effects", "Click 'Resume' in Window > AE MCP Pro.jsx.", "PAUSED");
    }
    if (!this.aeRunning()) {
      throw new AEError("After Effects is not running", "Open After Effects, or call the launch_after_effects tool.", "AE_NOT_RUNNING");
    }
    // once AE has been seen ready, skip the (slow) window-title check for 60 s
    // The window-title check (tasklist /V) is slow: once an AE process has been
    // seen ready it stays ready, so only re-check when the PID changes.
    if (!this.pids.some((p) => this.readyPids.has(p))) {
      if (!aeReady()) throw new AEError("After Effects is still starting up", "Wait until the main window shows a project, then retry (launch_after_effects waits for you).", "AE_STARTING");
      for (const p of this.pids) this.readyPids.add(p);
    }
    return "direct";
  }

  private commandScript(payload: object, resultPath: string): string {
    const rp = resultPath.replace(/\\/g, "/");
    const rtp = this.runtimePath.replace(/\\/g, "/");
    // If loading the runtime itself fails, still write a result so the server never waits for nothing.
    return [
      "(function(){",
      "  try {",
      `    if (!$.global.AEMCP || $.global.AEMCP.hash !== ${jsString(this.runtimeHash)}) $.evalFile(new File(${jsString(rtp)}));`,
      `    $.global.AEMCP.run(${jsString(JSON.stringify(payload))}, ${jsString(rp)});`,
      "  } catch (e) {",
      `    var f = new File(${jsString(rp)}); f.encoding = "UTF-8";`,
      `    if (f.open("w")) { f.write('{"ok":false,"error":"Bridge failure: ' + String(e).replace(/[\\\\"\\r\\n]/g, " ") + ' (line ' + e.line + ')"}'); f.close(); }`,
      "  }",
      "})();",
    ].join("\n");
  }

  /** Runs one runtime handler in After Effects and returns its data. Calls are serialized. */
  call<T = any>(tool: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
    const run = this.chain.then(() => this.callNow<T>(tool, args, opts));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async callNow<T>(tool: string, args: Record<string, unknown>, opts: CallOptions): Promise<T> {
    if (opts.signal?.aborted) throw new AEError("Cancelled before it was sent to After Effects", "Nothing was changed.", "CANCELLED");
    const mode = this.chooseMode();
    this.lastMode = mode;
    const id = crypto.randomBytes(6).toString("hex");
    const resultPath = path.join(this.dir, "results", `${id}.json`);
    const script = this.commandScript({ id, tool, args, undo: opts.undo !== false }, resultPath);
    const timeoutMs = opts.timeoutMs ?? 60_000;

    if (mode === "listener") {
      const name = `${Date.now()}-${id}.jsx`;
      const tmp = path.join(this.dir, "queue", name + ".tmp");
      fs.writeFileSync(tmp, script, "utf8");
      fs.renameSync(tmp, path.join(this.dir, "queue", name));
    } else {
      const file = path.join(this.dir, "direct", `${id}.jsx`);
      fs.writeFileSync(file, script, "utf8");
      await this.runDirect(file);
    }

    const t0 = Date.now();
    this.stats.calls++;
    const raw = await this.waitForResult(resultPath, timeoutMs, mode, id, !!opts.timeoutParam, opts.signal, opts.onProgress);
    this.stats.latencies.push(Date.now() - t0);
    if (this.stats.latencies.length > 50) this.stats.latencies.shift();
    let res: any;
    try {
      res = JSON.parse(raw);
    } catch {
      throw new AEError(`After Effects returned an unreadable result: ${raw.slice(0, 200)}`);
    } finally {
      fs.rmSync(resultPath, { force: true });
      fs.rmSync(path.join(this.dir, "direct", `${id}.jsx`), { force: true });
    }
    // The listener reports I/O errors from loading the command file, before the command ran: safe to resend once.
    if (!res.ok && /^Script error: IOError|^Script error: .*I\/O error/i.test(res.error || "") && !opts.isRetry) {
      this.stats.ioErrors++;
      return this.callNow<T>(tool, args, { ...opts, isRetry: true });
    }
    if (!res.ok) throw new AEError(res.error || "Unknown After Effects error", res.hint, "SCRIPT_ERROR");
    return res.data as T;
  }

  private runDirect(file: string): Promise<void> {
    const installs = findInstalls();
    return new Promise((resolve, reject) => {
      if (isWin) {
        if (!installs.length) return reject(new AEError("AfterFX.exe not found", "Set AE_MCP_AE_PATH to your After Effects folder."));
        // AfterFX.exe -r silently ignores paths with spaces (e.g. user names like "John Smith"): use the 8.3 short path
        let target = file;
        if (/\s/.test(file)) {
          try {
            target = execSync(`for %A in ("${path.win32.normalize(file)}") do @echo %~sA`, { encoding: "utf8", windowsHide: true }).trim();
          } catch {
            /* keep long path */
          }
          if (/\s/.test(target)) return reject(new AEError("The bridge folder path contains spaces and has no 8.3 short name", "Set AE_MCP_BRIDGE_DIR to a folder without spaces, e.g. C:\\ae-mcp."));
        }
        execFile(installs[0].executable, ["-r", target], { windowsHide: true, timeout: 30_000 }, (err) => {
          if (err && (err as any).killed) return reject(new AEError("AfterFX.exe -r did not return", "After Effects may be showing a modal dialog."));
          resolve();
        });
      } else if (isMac) {
        const appName = installs.length ? path.basename(installs[0].executable, ".app") : "Adobe After Effects 2026";
        const as = `tell application "${appName}" to DoScriptFile "${file.replace(/"/g, '\\"')}"`;
        execFile("osascript", ["-e", as], { timeout: 30_000 }, (err) => (err ? reject(new AEError(`osascript failed: ${err.message}`)) : resolve()));
      } else reject(new AEError("Unsupported platform: After Effects runs on Windows and macOS only"));
    });
  }

  private async waitForResult(resultPath: string, timeoutMs: number, mode: Mode, id: string, timeoutParam = false, signal?: AbortSignal, onProgress?: CallOptions["onProgress"]): Promise<string> {
    const progressPath = resultPath.replace(/\.json$/, ".progress.json");
    let lastDone = -1;
    try {
      return await this.waitLoop(resultPath, timeoutMs, mode, id, timeoutParam, signal, () => {
        if (!onProgress || !fs.existsSync(progressPath)) return;
        try {
          const p = JSON.parse(fs.readFileSync(progressPath, "utf8"));
          if (p.done !== lastDone) {
            lastDone = p.done;
            onProgress(p.done, p.total, p.message);
          }
        } catch {
          /* being written */
        }
      });
    } finally {
      fs.rmSync(progressPath, { force: true });
    }
  }

  private async waitLoop(resultPath: string, timeoutMs: number, mode: Mode, id: string, timeoutParam: boolean, signal: AbortSignal | undefined, poll: () => void): Promise<string> {
    const start = Date.now();
    let delay = 15;
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(resultPath)) {
        try {
          const txt = fs.readFileSync(resultPath, "utf8");
          if (txt.length) return txt;
        } catch {
          /* being written */
        }
      }
      await sleep(delay);
      delay = Math.min(100, delay + 10);
      poll();
      if (signal?.aborted) {
        const qdir = path.join(this.dir, "queue");
        const queued = fs.readdirSync(qdir).filter((f) => f.includes(id) && f.endsWith(".jsx"));
        if (mode === "listener" && queued.length) {
          for (const f of queued) fs.rmSync(path.join(qdir, f), { force: true });
          throw new AEError("Cancelled: the command was removed from the queue before After Effects started it", "Nothing was changed.", "CANCELLED");
        }
        // ExtendScript cannot be interrupted once it runs: stop waiting, AE finishes on its own
        throw new AEError("Cancelled while After Effects was already running the command", "AE will finish it and apply the change; check the project state.", "CANCELLED");
      }
      // AE closed mid-wait: fail fast. A stale heartbeat alone is NOT death: the listener
      // cannot beat while AE executes a long command (ExtendScript is single-threaded).
      if (Date.now() - start > 3000 && Date.now() - this.lastAliveCheck > 2000) {
        this.lastAliveCheck = Date.now();
        this.runningCache.at = 0;
        if (!this.aeRunning()) {
          for (const f of fs.readdirSync(path.join(this.dir, "queue"))) if (f.includes(id)) fs.rmSync(path.join(this.dir, "queue", f), { force: true });
          throw new AEError("After Effects was closed while waiting for this command", "Reopen After Effects (or call launch_after_effects), check what was applied, then retry.", "AE_CLOSED");
        }
      }
    }
    this.stats.timeouts++;
    const qdir = path.join(this.dir, "queue");
    const files = fs.readdirSync(qdir).filter((f) => f.includes(id));
    const running = files.some((f) => f.endsWith(".run"));
    // not started yet: drop it so it can never run later
    for (const f of files) if (!f.endsWith(".run")) fs.rmSync(path.join(qdir, f), { force: true });
    const secs = Math.round(timeoutMs / 1000);
    let message: string, hint: string;
    if (mode === "listener" && files.length && !running) {
      message = `Timed out after ${secs}s: After Effects never started this command (it was removed from the queue)`;
      hint = "AE is busy with an earlier operation or a dialog. Nothing was changed by this call.";
    } else {
      message = `Timed out after ${secs}s waiting for After Effects` + (running ? " - the command is still running in AE" : "");
      hint = "After Effects may still be running this operation and apply it later. Call get_project_info / list_layers before retrying to avoid duplicates." + (timeoutParam ? " Pass timeoutSeconds for long operations." : "");
    }
    throw new AEError(message, hint, "TIMEOUT");
  }

  /** Launch After Effects (if needed) and wait until it accepts scripts. */
  async launch(waitSeconds = 180): Promise<{ alreadyRunning: boolean; seconds: number }> {
    const t0 = Date.now();
    if (this.aeRunning()) return { alreadyRunning: true, seconds: 0 };
    const installs = findInstalls();
    if (!installs.length) throw new AEError("No After Effects installation found", "Set AE_MCP_AE_PATH.");
    if (isWin) spawn(installs[0].executable, [], { detached: true, stdio: "ignore" }).unref();
    else spawn("open", ["-a", installs[0].executable], { detached: true, stdio: "ignore" }).unref();
    while (Date.now() - t0 < waitSeconds * 1000) {
      await sleep(3000);
      this.runningCache.at = 0;
      if (!this.aeRunning() || !aeReady()) continue;
      try {
        await this.call("ping", {}, { timeoutMs: 8000, undo: false });
        return { alreadyRunning: false, seconds: Math.round((Date.now() - t0) / 1000) };
      } catch {
        /* still starting */
      }
    }
    throw new AEError(`After Effects did not become ready within ${waitSeconds}s`);
  }
}
