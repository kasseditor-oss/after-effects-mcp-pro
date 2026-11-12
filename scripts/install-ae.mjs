#!/usr/bin/env node
// Installs the After Effects side of AE MCP Pro. No administrator rights needed:
//  1. copies the listener to the bridge folder (<userData>/ae-mcp-pro)
//  2. adds a tiny Startup script to every After Effects version's *user* Scripts
//     folder, so the bridge starts automatically with AE (no panel to open)
//  3. adds the optional status panel (Window > AE MCP Pro.jsx)
//  4. turns on "Allow Scripts to Write Files and Access Network" if AE is closed
//  5. starts the listener right away if AE is already running
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const uninstall = process.argv.includes("--uninstall");

const userData = isWin ? process.env.APPDATA : path.join(os.homedir(), "Library", "Application Support");
const bridge = process.env.AE_MCP_BRIDGE_DIR || path.join(userData, "ae-mcp-pro");
// "After Effects" and, for the Creative Cloud Beta, "After Effects (Beta)" (any sibling named After Effects*)
const adobePrefs = isWin ? path.join(process.env.APPDATA, "Adobe") : path.join(os.homedir(), "Library", "Preferences", "Adobe");
const prefsRoots = fs.existsSync(adobePrefs) ? fs.readdirSync(adobePrefs).filter((d) => /^After Effects/i.test(d)).map((d) => path.join(adobePrefs, d)) : [];

const STARTUP_NAME = "ae-mcp-pro-startup.jsx";
const PANEL_NAME = "AE MCP Pro.jsx";
const listenerDst = path.join(bridge, "ae-mcp-pro-listener.jsx");

function aeRunning() {
  try {
    if (isWin) return /AfterFX\.exe/i.test(execFileSync("tasklist", ["/FI", "IMAGENAME eq AfterFX.exe", "/NH"], { encoding: "utf8" }));
    return execFileSync("pgrep", ["-x", "After Effects|After Effects \\(Beta\\)"], { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}

// one entry per AE version folder: { label, dir }
const versions = [];
for (const r of prefsRoots) for (const d of fs.readdirSync(r)) if (/^\d+\.\d+$/.test(d)) versions.push({ label: path.basename(r) === "After Effects" ? d : `${d} (${path.basename(r)})`, dir: path.join(r, d) });
if (!versions.length) {
  console.error(`No After Effects preference folders found in ${adobePrefs}. Open After Effects once, then run this again.`);
  process.exit(1);
}

const running = aeRunning();
const report = [];

if (uninstall) {
  for (const v of versions) {
    for (const f of [path.join(v.dir, "Scripts", "Startup", STARTUP_NAME), path.join(v.dir, "Scripts", "ScriptUI Panels", PANEL_NAME)]) {
      if (fs.existsSync(f)) {
        fs.rmSync(f);
        report.push(`removed ${f}`);
      }
    }
  }
  console.log(report.join("\n") || "nothing to remove");
  process.exit(0);
}

fs.mkdirSync(bridge, { recursive: true });
fs.copyFileSync(path.join(root, "bridge", "ae-mcp-pro-listener.jsx"), listenerDst);
report.push(`listener   -> ${listenerDst}`);

const stub = `// AE MCP Pro: starts the MCP bridge listener with After Effects.\n(function(){ var f = new File(Folder.userData.fsName + "/ae-mcp-pro/ae-mcp-pro-listener.jsx"); if (f.exists) { try { $.evalFile(f); } catch (e) {} } })();\n`;

for (const v of versions) {
  const scripts = path.join(v.dir, "Scripts");
  const startup = path.join(scripts, "Startup");
  const panels = path.join(scripts, "ScriptUI Panels");
  fs.mkdirSync(startup, { recursive: true });
  fs.mkdirSync(panels, { recursive: true });
  fs.writeFileSync(path.join(startup, STARTUP_NAME), stub, "utf8");
  fs.copyFileSync(path.join(root, "bridge", PANEL_NAME), path.join(panels, PANEL_NAME));
  report.push(`AE ${v.label}: startup + panel installed in ${scripts}`);

  // Scripting permission. AE rewrites its prefs on quit, so only edit while closed.
  for (const pf of fs.readdirSync(v.dir).filter((f) => /Prefs\.txt$/.test(f) && !/-/.test(f))) {
    const p = path.join(v.dir, pf);
    let txt = fs.readFileSync(p, "utf8");
    const m = txt.match(/"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "(\d)"/);
    if (m && m[1] === "1") report.push(`AE ${v.label}: scripting file/network access already enabled`);
    else if (running) report.push(`AE ${v.label}: enable Edit > Preferences > Scripting & Expressions > "Allow Scripts to Write Files and Access Network"`);
    else if (m) {
      fs.writeFileSync(p + ".bak-aemcp", txt);
      txt = txt.replace(/"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "\d"/, '"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "1"');
      fs.writeFileSync(p, txt);
      report.push(`AE ${v.label}: enabled scripting file/network access (backup: ${pf}.bak-aemcp)`);
    } else report.push(`AE ${v.label}: enable "Allow Scripts to Write Files and Access Network" in Preferences > Scripting & Expressions`);
  }
}

// Start the listener in the running instance so no restart is needed. Sending a
// script while AE is still on its splash screen can hang it, so only do this
// once AE is fully loaded; otherwise the listener starts with AE next time.
if (running) {
  let plat = null;
  try {
    plat = (await import(pathToFileURL(path.join(root, "build", "platform", "index.js")).href)).platform();
  } catch {
    report.push("build/ not found (run npm run build): the listener will start next time AE opens");
  }
  const install = plat?.findInstalls()[0];
  if (plat && !plat.aeReady()) report.push("After Effects is still starting: the listener will start next time AE opens (or restart AE)");
  else if (plat && install) {
    try {
      // Windows: AfterFX.exe -r (8.3 short path); macOS: AppleScript DoScriptFile
      await plat.runScriptFile(listenerDst, install);
      report.push("listener started in the running After Effects");
    } catch (e) {
      report.push(`could not start listener now (${e.message}); it will start next time AE opens`);
    }
  }
}

const server = path.join(root, "build", "index.js").replace(/\\/g, "/");
console.log("AE MCP Pro installed\n  " + report.join("\n  "));
console.log(`
Add the server to your MCP client:

  Claude Code:     claude mcp add after-effects -- node "${server}"
  Claude Desktop:  "mcpServers": { "after-effects": { "command": "node", "args": ["${server}"] } }
`);
