import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export const isWin = process.platform === "win32";
export const isMac = process.platform === "darwin";

/** Same folder ExtendScript sees as `Folder.userData + "/ae-mcp-pro"`. */
export function bridgeDir(): string {
  if (process.env.AE_MCP_BRIDGE_DIR) return process.env.AE_MCP_BRIDGE_DIR;
  const userData = isWin
    ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    : isMac
      ? path.join(os.homedir(), "Library", "Application Support")
      : path.join(os.homedir(), ".config");
  return path.join(userData, "ae-mcp-pro");
}

export interface AEInstall {
  version: string; // e.g. "2026"
  appDir: string;
  executable: string; // AfterFX.exe on Windows, .app bundle on macOS
  aerender: string | null;
}

/** Finds installed After Effects versions, newest first. AE_MCP_AE_PATH overrides. */
export function findInstalls(): AEInstall[] {
  const out: AEInstall[] = [];
  const override = process.env.AE_MCP_AE_PATH;
  if (isWin) {
    const roots = [process.env.ProgramFiles || "C:\\Program Files", "C:\\Program Files"];
    const seen = new Set<string>();
    const dirs: string[] = [];
    if (override) dirs.push(override);
    for (const root of roots) {
      const adobe = path.join(root, "Adobe");
      if (!fs.existsSync(adobe)) continue;
      for (const d of fs.readdirSync(adobe)) {
        if (/^Adobe After Effects/i.test(d)) dirs.push(path.join(adobe, d));
      }
    }
    for (const dir of dirs) {
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const sf = path.join(dir, "Support Files");
      const exe = path.join(sf, "AfterFX.exe");
      if (!fs.existsSync(exe)) continue;
      const aer = path.join(sf, "aerender.exe");
      out.push({ version: (dir.match(/(\d{4}|CC \d{4}|Beta)/i) || ["?"])[0], appDir: dir, executable: exe, aerender: fs.existsSync(aer) ? aer : null });
    }
  } else if (isMac) {
    const dirs: string[] = override ? [override] : [];
    if (fs.existsSync("/Applications")) {
      for (const d of fs.readdirSync("/Applications")) if (/^Adobe After Effects/i.test(d)) dirs.push(path.join("/Applications", d));
    }
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const app = fs.readdirSync(dir).find((f) => /^Adobe After Effects.*\.app$/i.test(f));
      if (!app) continue;
      const aer = path.join(dir, "aerender");
      out.push({ version: (dir.match(/(\d{4}|Beta)/i) || ["?"])[0], appDir: dir, executable: path.join(dir, app), aerender: fs.existsSync(aer) ? aer : null });
    }
  }
  out.sort((a, b) => b.version.localeCompare(a.version));
  return out;
}

/** True if an After Effects process is running. */
export function isAERunning(): boolean {
  try {
    if (isWin) {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq AfterFX.exe", "/NH"], { encoding: "utf8", windowsHide: true });
      return /AfterFX\.exe/i.test(out);
    }
    if (isMac) {
      const out = execFileSync("pgrep", ["-f", "After Effects"], { encoding: "utf8" });
      return out.trim().length > 0;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Windows only: title of the main After Effects window, or null.
 * During startup (splash / Home screen) the title has no " - <project>" part,
 * and sending `AfterFX.exe -r` at that moment can hang AE, so we wait for it.
 */
export function aeWindowTitle(): string | null {
  if (!isWin) return null;
  try {
    const out = execFileSync("tasklist", ["/V", "/FI", "IMAGENAME eq AfterFX.exe", "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
    const titles = out
      .split(/\r?\n/)
      .filter((l) => /AfterFX\.exe/i.test(l))
      .map((l) => (l.match(/"([^"]*)"\s*$/) || [])[1] || "");
    return titles.find((t) => / - /.test(t)) ?? titles[0] ?? null;
  } catch {
    return null;
  }
}

export function aeReady(): boolean {
  if (!isWin) return true;
  const t = aeWindowTitle();
  return !!t && /After Effects/i.test(t) && / - /.test(t);
}
