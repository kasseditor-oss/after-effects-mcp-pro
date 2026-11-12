import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { aePids, aeReady, bridgeDir, findInstalls } from "./env.js";
import { platform } from "./platform/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_VERSION = "2.1.0";
/** Version of bridge/ae-mcp-pro-listener.jsx this server expects (bump both together). */
export const LISTENER_VERSION = "2.0.3";

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
  private lastDialogCheck = 0;
  private pending: { tool: string; args: Record<string, unknown>; opts: CallOptions; resolve: (v: any) => void; reject: (e: unknown) => void }[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  readonly stats = { calls: 0, groups: 0, timeouts: 0, ioErrors: 0, latencies: [] as number[] };

  constructor() {
    for (const sub of ["queue", "results", "direct", "frames", "runtime"]) fs.mkdirSync(path.join(this.dir, sub), { recursive: true });
    const src = loadRuntimeSource();
    this.runtimeHash = crypto.createHash("sha1").update(src).update(SERVER_VERSION).digest("hex").slice(0, 12);
    // One folder per server version: servers of different versions running at the same
    // time (e.g. two Claude sessions) must never overwrite each other's runtime.
    fs.mkdirSync(path.join(this.dir, "runtime", SERVER_VERSION), { recursive: true });
    this.runtimePath = path.join(this.dir, "runtime", SERVER_VERSION, `runtime-${this.runtimeHash}.jsx`);
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
    // Old runtimes: only delete files untouched for 7 days (another server may be using them).
    const week = Date.now() - 7 * 24 * 3600_000;
    const rt = path.join(this.dir, "runtime");
    for (const entry of fs.readdirSync(rt)) {
      const p = path.join(rt, entry);
      try {
        const files = fs.statSync(p).isDirectory() ? fs.readdirSync(p).map((f) => path.join(p, f)) : [p];
        for (const f of files) if (f !== this.runtimePath && fs.statSync(f).mtimeMs < week) fs.unlinkSync(f);
        if (fs.statSync(p).isDirectory() && !fs.readdirSync(p).length) fs.rmdirSync(p);
      } catch {
        /* ignore */
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
    if (!hb || hb.ageMs > 10_000 || hb.version === LISTENER_VERSION) return null;
    return `The After Effects listener is version ${hb.version} but this server (${SERVER_VERSION}) expects ${LISTENER_VERSION}. Run "npm run install-ae" in the server folder to update it.`;
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
    if (process.env.AE_MCP_ASSUME_RUNNING === "1") return true; // test hook (fake After Effects)
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
    // The listener cannot beat while AE runs a long command: if it answered recently
    // and AE is still running, it is busy, not gone. Do not fall back to direct mode.
    if (hb && !hb.paused && this.lastMode === "listener" && hb.ageMs < 120_000 && this.aeRunning()) return "listener";
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
    return this.groupScript([{ payload, resultPath }]);
  }

  /** One command file that runs several calls in order, each with its own result file and undo group. */
  private groupScript(items: { payload: object; resultPath: string }[]): string {
    const rtp = this.runtimePath.replace(/\\/g, "/");
    const runs = items.map(({ payload, resultPath }) => {
      const rp = resultPath.replace(/\\/g, "/");
      return [
        "  try {",
        `    if (!$.global.AEMCP || $.global.AEMCP.hash !== ${jsString(this.runtimeHash)}) $.evalFile(new File(${jsString(rtp)}));`,
        `    $.global.AEMCP.run(${jsString(JSON.stringify(payload))}, ${jsString(rp)});`,
        "  } catch (e) {",
        `    var f = new File(${jsString(rp)}); f.encoding = "UTF-8";`,
        `    if (f.open("w")) { f.write('{"ok":false,"error":"Bridge failure: ' + String(e).replace(/[\\\\"\\r\\n]/g, " ") + ' (line ' + e.line + ')"}'); f.close(); }`,
        "  }",
      ].join("\n");
    });
    return ["(function(){", ...runs, "})();"].join("\n");
  }

  /**
   * Runs one runtime handler in After Effects and returns its data.
   * Calls run in order. With the listener, calls that arrive together (a 20 ms
   * window, or while an earlier group is still running) share one queue file:
   * AE runs them in one pass, each with its own result file and undo step.
   * AE_MCP_NO_COALESCE=1 sends every call on its own.
   */
  call<T = any>(tool: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
    if (process.env.AE_MCP_NO_COALESCE === "1") {
      const run = this.chain.then(() => this.callNow<T>(tool, args, opts));
      this.chain = run.catch(() => undefined);
      return run;
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ tool, args, opts, resolve, reject });
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          // the group is taken when its turn comes, so calls arriving meanwhile join it
          this.chain = this.chain.then(() => this.flush()).catch(() => undefined);
        }, 20);
      }
    });
  }

  private async flush(): Promise<void> {
    const group = this.pending.splice(0);
    if (!group.length) return;
    let mode: Mode;
    try {
      mode = this.chooseMode();
    } catch (e) {
      for (const g of group) g.reject(e);
      return;
    }
    if (mode === "direct" || group.length === 1) {
      for (const g of group) await this.callNow(g.tool, g.args, g.opts).then(g.resolve, g.reject);
      return;
    }
    this.lastMode = mode;
    this.stats.groups++;
    const tag = "g" + crypto.randomBytes(5).toString("hex");
    const items = group.map((g) => {
      const id = crypto.randomBytes(6).toString("hex");
      return { g, id, resultPath: path.join(this.dir, "results", `${id}.json`) };
    });
    const live = items.filter((it) => {
      if (!it.g.opts.signal?.aborted) return true;
      it.g.reject(new AEError("Cancelled before it was sent to After Effects", "Nothing was changed.", "CANCELLED"));
      return false;
    });
    if (!live.length) return;
    const script = this.groupScript(live.map((it) => ({ payload: { id: it.id, tool: it.g.tool, args: it.g.args, undo: it.g.opts.undo !== false }, resultPath: it.resultPath })));
    const name = `${Date.now()}-${tag}.jsx`;
    const tmp = path.join(this.dir, "queue", name + ".tmp");
    fs.writeFileSync(tmp, script, "utf8");
    fs.renameSync(tmp, path.join(this.dir, "queue", name));
    await Promise.all(
      live.map(async (it) => {
        const t0 = Date.now();
        this.stats.calls++;
        try {
          const raw = await this.waitForResult(it.resultPath, it.g.opts.timeoutMs ?? 60_000, "listener", tag, !!it.g.opts.timeoutParam, it.g.opts.signal, it.g.opts.onProgress, it.id);
          this.stats.latencies.push(Date.now() - t0);
          if (this.stats.latencies.length > 50) this.stats.latencies.shift();
          let res: any;
          try {
            res = JSON.parse(raw);
          } finally {
            fs.rmSync(it.resultPath, { force: true });
          }
          if (!res.ok && /^Script error: IOError|^Script error: .*I\/O error/i.test(res.error || "")) {
            this.stats.ioErrors++;
            it.g.resolve(await this.callNow(it.g.tool, it.g.args, { ...it.g.opts, isRetry: true }));
          } else if (!res.ok) it.g.reject(new AEError(res.error || "Unknown After Effects error", res.hint, res.cancelled ? "CANCELLED" : "SCRIPT_ERROR"));
          else it.g.resolve(res.data);
        } catch (e) {
          it.g.reject(e);
        }
      }),
    );
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

  private async runDirect(file: string): Promise<void> {
    try {
      await platform().runScriptFile(file, findInstalls()[0]);
    } catch (e: any) {
      throw new AEError(e.message, e.hint);
    }
  }

  private async waitForResult(resultPath: string, timeoutMs: number, mode: Mode, id: string, timeoutParam = false, signal?: AbortSignal, onProgress?: CallOptions["onProgress"], callId?: string): Promise<string> {
    const progressPath = resultPath.replace(/\.json$/, ".progress.json");
    let lastDone = -1, lastTick = Date.now();
    const started = Date.now();
    try {
      return await this.waitLoop(resultPath, timeoutMs, mode, id, timeoutParam, signal, callId, () => {
        if (!onProgress) return;
        // No progress file (a single long AE call such as closing a big project): send a
        // heartbeat every 2 s so the client sees the call is alive.
        if (!fs.existsSync(progressPath)) {
          if (lastDone < 0 && Date.now() - lastTick >= 2000) {
            lastTick = Date.now();
            const secs = Math.round((Date.now() - started) / 1000);
            onProgress(secs, 0, `After Effects is working (${secs} s)`);
          }
          return;
        }
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

  /**
   * id: tag of the queue file. callId is set when the file is shared with other
   * calls: then a cancelled or timed-out call is skipped through a <callId>.cancel
   * marker (checked by the runtime) instead of deleting the whole file.
   */
  private async waitLoop(resultPath: string, timeoutMs: number, mode: Mode, id: string, timeoutParam: boolean, signal: AbortSignal | undefined, callId: string | undefined, poll: () => void): Promise<string> {
    const cancelMarker = () => fs.writeFileSync(resultPath.replace(/\.json$/, ".cancel"), "1");
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
        if (callId) {
          cancelMarker();
          throw new AEError("Cancelled: After Effects skips this command if it has not reached it yet", "It shared a queue file with other calls; check the project state if unsure.", "CANCELLED");
        }
        if (mode === "listener" && queued.length) {
          for (const f of queued) fs.rmSync(path.join(qdir, f), { force: true });
          throw new AEError("Cancelled: the command was removed from the queue before After Effects started it", "Nothing was changed.", "CANCELLED");
        }
        // ExtendScript cannot be interrupted once it runs: stop waiting, AE finishes on its own
        throw new AEError("Cancelled while After Effects was already running the command", "AE will finish it and apply the change; check the project state.", "CANCELLED");
      }
      // A modal dialog in AE (alert, missing font, "save changes?") stops the listener: if
      // it has been silent for 3 s and this command has not started, look for a dialog.
      if (mode === "listener" && Date.now() - start > 3000 && Date.now() - this.lastDialogCheck > 2000) {
        const hb = this.heartbeat();
        const qdir = path.join(this.dir, "queue");
        const waiting = fs.readdirSync(qdir).some((f) => f.includes(id) && f.endsWith(".jsx"));
        if (hb && hb.ageMs > 3000 && waiting) {
          this.lastDialogCheck = Date.now();
          const dialog = platform().modalDialog();
          if (dialog) {
            if (callId) fs.writeFileSync(resultPath.replace(/\.json$/, ".cancel"), "1");
            else for (const f of fs.readdirSync(qdir)) if (f.includes(id) && f.endsWith(".jsx")) fs.rmSync(path.join(qdir, f), { force: true });
            throw new AEError(`After Effects is showing a dialog ('${dialog}') and cannot run commands`, "Close the dialog in After Effects and try again. This command was not run.", "AE_DIALOG");
          }
        }
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
    // not started yet: drop it (or, in a shared file, mark it) so it can never run later
    if (callId) cancelMarker();
    else for (const f of files) if (!f.endsWith(".run")) fs.rmSync(path.join(qdir, f), { force: true });
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
    platform().launch(installs[0]);
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
