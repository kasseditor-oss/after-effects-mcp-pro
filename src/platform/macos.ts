import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import type { ComposeSpec } from "../imaging.js";
import { sortInstalls, type AEInstall, type Platform } from "./types.js";
import { appEnv } from "./appenv.js";

/** Installed versions under an Applications folder (parameter so tests can use a fake tree). */
export function findInstallsIn(appsRoot: string, override?: string): AEInstall[] {
  const dirs: string[] = override ? [override] : [];
  if (fs.existsSync(appsRoot)) {
    for (const d of fs.readdirSync(appsRoot)) if (/^Adobe After Effects/i.test(d)) dirs.push(path.join(appsRoot, d));
  }
  const out: AEInstall[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    const app = fs.readdirSync(dir).find((f) => /^Adobe After Effects.*\.app$/i.test(f));
    if (!app) continue;
    const aer = path.join(dir, "aerender");
    out.push({ version: (path.basename(dir).match(/(\d{4}|Beta)/i) || ["?"])[0], appDir: dir, executable: path.join(dir, app), aerender: fs.existsSync(aer) ? aer : null, beta: /beta/i.test(path.basename(dir)) });
  }
  return sortInstalls(out);
}

/** AppleScript that makes After Effects run a script file (AE's DoScriptFile command). */
export function appleScriptFor(file: string, appName: string): string {
  const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `tell application "${q(appName)}" to DoScriptFile "${q(file)}"`;
}

export const macos: Platform = {
  name: "macos",
  userDataDir: () => path.join(os.homedir(), "Library", "Application Support"),

  findInstalls: () => findInstallsIn("/Applications", process.env.AE_MCP_AE_PATH),

  aePids() {
    try {
      // exact process name: "-f After Effects" also matched aerender and anything mentioning it
      // the Beta's process is "After Effects (Beta)"
      const out = execFileSync("pgrep", ["-x", "After Effects|After Effects \\(Beta\\)"], { encoding: "utf8" });
      return out.split(/\s+/).map(Number).filter((n) => n > 0);
    } catch {
      return [];
    }
  },

  // There is no cheap, permission-free way to read AE's window title on macOS.
  aeReady: () => true,

  runScriptFile(file, install) {
    const appName = install ? path.basename(install.executable, ".app") : "Adobe After Effects 2026";
    return new Promise((resolve, reject) => {
      execFile("osascript", ["-e", appleScriptFor(file, appName)], { timeout: 30_000 }, (err) =>
        err ? reject(Object.assign(new Error(`osascript failed: ${err.message}`), { hint: "Allow your terminal/Claude to control After Effects in System Settings > Privacy & Security > Automation." })) : resolve(),
      );
    });
  },

  // No permission-free way to inspect another app's windows on macOS.
  modalDialog: () => null,

  launch(install) {
    spawn("open", ["-a", install.executable], { detached: true, stdio: "ignore", env: appEnv() }).unref();
  },

  // sips can resize and convert one image; grids and background fill are Windows-only,
  // so several frames come back as separate images.
  compose(spec: ComposeSpec) {
    if (spec.files.length !== 1) return null;
    try {
      const args = ["-Z", String(spec.maxSize)];
      if (spec.format === "jpeg") args.push("-s", "format", "jpeg", "-s", "formatOptions", String(spec.quality));
      execFileSync("sips", [...args, spec.files[0], "--out", spec.output], { timeout: 30_000 });
      const info = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", spec.output], { encoding: "utf8" });
      return { width: Number(/pixelWidth: (\d+)/.exec(info)?.[1]), height: Number(/pixelHeight: (\d+)/.exec(info)?.[1]) };
    } catch {
      return null;
    }
  },
};
