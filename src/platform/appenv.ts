import * as os from "node:os";
import * as path from "node:path";

/**
 * Environment for processes the server starts for After Effects (AfterFX, aerender).
 *
 * MCP clients start servers with a reduced environment (the SDK's default keeps only a
 * dozen variables such as PATH, TEMP and USERPROFILE). After Effects and aerender then
 * hang at startup: AfterFX stays at ~26 MB with no window, and aerender never gets past
 * "aerender version ...". The standard Windows folders (Common Files, ProgramData...)
 * are filled in when missing; variables that exist are never changed.
 */
export function appEnv(base: NodeJS.ProcessEnv = process.env, plat: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  // Windows variable names are case-insensitive: never add "TEMP" next to an existing "Temp"
  const keys = new Set(Object.keys(env).map((k) => k.toLowerCase()));
  const get = (k: string) => Object.entries(env).find(([n]) => n.toLowerCase() === k.toLowerCase())?.[1];
  const fill = (k: string, v: string | undefined) => {
    if (v && !keys.has(k.toLowerCase())) {
      env[k] = v;
      keys.add(k.toLowerCase());
    }
  };
  const home = get("USERPROFILE") || get("HOME") || os.homedir();
  if (plat === "win32") {
    const w = path.win32;
    const drive = get("SystemDrive") || (home.match(/^[A-Za-z]:/)?.[0] ?? "C:");
    const root = get("SystemRoot") || w.join(drive + "\\", "Windows");
    const pf = get("ProgramFiles") || w.join(drive + "\\", "Program Files");
    const pf86 = get("ProgramFiles(x86)") || w.join(drive + "\\", "Program Files (x86)");
    const data = get("ProgramData") || w.join(drive + "\\", "ProgramData");
    fill("SystemDrive", drive);
    fill("SystemRoot", root);
    fill("windir", root);
    fill("ProgramFiles", pf);
    fill("ProgramFiles(x86)", pf86);
    fill("ProgramW6432", pf);
    fill("CommonProgramFiles", w.join(pf, "Common Files"));
    fill("CommonProgramFiles(x86)", w.join(pf86, "Common Files"));
    fill("CommonProgramW6432", w.join(pf, "Common Files"));
    fill("ProgramData", data);
    fill("ALLUSERSPROFILE", data);
    fill("PUBLIC", w.join(drive + "\\", "Users", "Public"));
    fill("USERPROFILE", home);
    fill("HOMEDRIVE", home.slice(0, 2));
    fill("HOMEPATH", home.slice(2));
    fill("APPDATA", w.join(home, "AppData", "Roaming"));
    fill("LOCALAPPDATA", w.join(home, "AppData", "Local"));
    const tmp = get("TEMP") || get("TMP") || w.join(home, "AppData", "Local", "Temp");
    fill("TEMP", tmp);
    fill("TMP", tmp);
    fill("ComSpec", w.join(root, "System32", "cmd.exe"));
    fill("PATHEXT", ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC");
    fill("OS", "Windows_NT");
    fill("COMPUTERNAME", os.hostname());
    fill("USERNAME", safeUser());
    fill("NUMBER_OF_PROCESSORS", String(os.cpus().length || 1));
  } else {
    fill("HOME", home);
    fill("USER", safeUser());
    fill("TMPDIR", os.tmpdir());
  }
  return env;
}

function safeUser(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}
