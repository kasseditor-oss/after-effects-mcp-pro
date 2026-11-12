import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, execFileSync, execSync, spawn } from "node:child_process";
import type { ComposeSpec } from "../imaging.js";
import { sortInstalls, type AEInstall, type Platform } from "./types.js";
import { appEnv } from "./appenv.js";

// One PowerShell process does every resize, the grid and the encoding:
// starting PowerShell costs ~0.5-1 s, so doing it per frame was the bottleneck.
const PS_SCRIPT = String.raw`
param([string]$specPath)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$spec = Get-Content -Raw -Encoding UTF8 $specPath | ConvertFrom-Json
$imgs = @(); foreach ($f in $spec.files) { $imgs += [System.Drawing.Image]::FromFile($f) }
$w0 = $imgs[0].Width; $h0 = $imgs[0].Height
$k = [Math]::Min(1.0, $spec.maxSize / [Math]::Max($w0, $h0))
$cw = [int][Math]::Max(1, [Math]::Round($w0 * $k)); $ch = [int][Math]::Max(1, [Math]::Round($h0 * $k))
$cols = [int][Math]::Min($spec.columns, $imgs.Count); $rows = [int][Math]::Ceiling($imgs.Count / $cols)
$gap = if ($imgs.Count -gt 1) { 4 } else { 0 }
$W = $cols * $cw + ($cols - 1) * $gap; $H = $rows * $ch + ($rows - 1) * $gap
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = "HighQualityBicubic"; $g.SmoothingMode = "AntiAlias"; $g.TextRenderingHint = "AntiAliasGridFit"
$g.Clear([System.Drawing.Color]::FromArgb(255, 24, 24, 28))
$fontSize = [Math]::Max(9, [Math]::Round($ch / 14))
$font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$bgType = if ($spec.background) { $spec.background.type } else { "none" }
if ($bgType -eq "none" -and $imgs.Count -eq 1) { $g.Clear([System.Drawing.Color]::Transparent) }
for ($i = 0; $i -lt $imgs.Count; $i++) {
  $x = ($i % $cols) * ($cw + $gap); $y = [Math]::Floor($i / $cols) * ($ch + $gap)
  if ($bgType -eq "color") {
    $c = $spec.background.rgb
    $bb = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, [int]$c[0], [int]$c[1], [int]$c[2]))
    $g.FillRectangle($bb, $x, $y, $cw, $ch); $bb.Dispose()
  } elseif ($bgType -eq "checker") {
    $sq = [Math]::Max(6, [int]($ch / 24))
    $light = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 204, 204, 204))
    $dark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 153, 153, 153))
    for ($yy = 0; $yy -lt $ch; $yy += $sq) { for ($xx = 0; $xx -lt $cw; $xx += $sq) {
      $br = if ((([int]($xx / $sq) + [int]($yy / $sq)) % 2) -eq 0) { $light } else { $dark }
      $g.FillRectangle($br, $x + $xx, $y + $yy, [Math]::Min($sq, $cw - $xx), [Math]::Min($sq, $ch - $yy))
    } }
    $light.Dispose(); $dark.Dispose()
  }
  $g.DrawImage($imgs[$i], $x, $y, $cw, $ch)
  if ($spec.labels -and $spec.labels[$i]) {
    $sz = $g.MeasureString($spec.labels[$i], $font)
    $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(170, 0, 0, 0))
    $g.FillRectangle($bg, $x + 4, $y + 4, $sz.Width + 8, $sz.Height + 2)
    $g.DrawString($spec.labels[$i], $font, [System.Drawing.Brushes]::White, $x + 8, $y + 5)
  }
}
foreach ($im in $imgs) { $im.Dispose() }
$g.Dispose()
if ($spec.format -eq "jpeg") {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$spec.quality)
  $bmp.Save($spec.output, $codec, $ep)
} else { $bmp.Save($spec.output, [System.Drawing.Imaging.ImageFormat]::Png) }
$bmp.Dispose()
Write-Output "$W,$H"
`;

let psPath: string | null = null;
let dlgScript: string | null = null;
function writeDialogScript(): string {
  const p = path.join(os.tmpdir(), "aemcp-dialogs-v1.ps1");
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, `param([int]$aePid)
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class AeModal {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  public static void List(uint pid) {
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (c.ToString() == "#32770") { var t = new StringBuilder(256); GetWindowText(h, t, 256); Console.WriteLine(t.ToString()); }
      return true;
    }, IntPtr.Zero);
  }
}
"@
[AeModal]::List([uint32]$aePid)
`, "utf8");
  }
  return p;
}

/** AfterFX.exe -r silently ignores paths with spaces: use the 8.3 short path. */
export function shortPath(file: string): string {
  if (!/\s/.test(file)) return file;
  try {
    return execSync(`for %A in ("${path.win32.normalize(file)}") do @echo %~sA`, { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return file;
  }
}

/** Title of the main After Effects window ("Adobe After Effects 2026 - project.aep"), or null. */
export function aeWindowTitle(): string | null {
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

/** Installed versions under <root>/Adobe (parameter so tests can use a fake tree). Beta builds are flagged. */
export function findWindowsInstallsIn(roots: string[], override?: string): AEInstall[] {
  const out: AEInstall[] = [];
  const seen = new Set<string>();
  const dirs: string[] = [];
  if (override) dirs.push(override);
  for (const root of roots) {
    const adobe = path.join(root, "Adobe");
    if (!fs.existsSync(adobe)) continue;
    for (const d of fs.readdirSync(adobe)) if (/^Adobe After Effects/i.test(d)) dirs.push(path.join(adobe, d));
  }
  for (const dir of dirs) {
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const sf = path.join(dir, "Support Files");
    const exe = path.join(sf, "AfterFX.exe");
    if (!fs.existsSync(exe)) continue;
    const aer = path.join(sf, "aerender.exe");
    const base = path.basename(dir);
    out.push({ version: (base.match(/(\d{4}|CC \d{4}|Beta)/i) || ["?"])[0], appDir: dir, executable: exe, aerender: fs.existsSync(aer) ? aer : null, beta: /beta/i.test(base) });
  }
  return sortInstalls(out);
}

export const windows: Platform = {
  name: "windows",
  userDataDir: () => process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),

  findInstalls() {
    return findWindowsInstallsIn([process.env.ProgramFiles || "C:\\Program Files", "C:\\Program Files"], process.env.AE_MCP_AE_PATH);
  },

  aePids() {
    try {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq AfterFX.exe", "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
      return out
        .split(/\r?\n/)
        .filter((l) => /AfterFX\.exe/i.test(l))
        .map((l) => Number((l.split('","')[1] || "").replace(/"/g, "")))
        .filter((n) => n > 0);
    } catch {
      return [];
    }
  },

  // During startup (splash / Home screen) the title has no " - <project>" part, and
  // sending AfterFX.exe -r at that moment can hang AE.
  aeReady() {
    const t = aeWindowTitle();
    return !!t && /After Effects/i.test(t) && / - /.test(t);
  },

  runScriptFile(file, install) {
    return new Promise((resolve, reject) => {
      if (!install) return reject(Object.assign(new Error("AfterFX.exe not found"), { hint: "Set AE_MCP_AE_PATH to your After Effects folder." }));
      const target = shortPath(file);
      if (/\s/.test(target)) return reject(Object.assign(new Error("The bridge folder path contains spaces and has no 8.3 short name"), { hint: "Set AE_MCP_BRIDGE_DIR to a folder without spaces, e.g. C:\\ae-mcp." }));
      execFile(install.executable, ["-r", target], { windowsHide: true, timeout: 30_000, env: appEnv() }, (err) => {
        if (err && (err as any).killed) return reject(Object.assign(new Error("AfterFX.exe -r did not return"), { hint: "After Effects may be showing a modal dialog." }));
        resolve();
      });
    });
  },

  // Modal dialogs are Win32 "#32770" windows; AE's own "Executing Script..." progress box is not one we report.
  modalDialog() {
    const pid = windows.aePids()[0];
    if (!pid) return null;
    if (!dlgScript) dlgScript = writeDialogScript();
    try {
      const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", dlgScript, String(pid)], { encoding: "utf8", windowsHide: true, timeout: 15_000 }).trim();
      const title = out.split(/\r?\n/).find((t) => t && !/^Executing Script/i.test(t));
      return title === undefined ? null : title || "(untitled dialog)";
    } catch {
      return null;
    }
  },

  launch(install) {
    spawn(install.executable, [], { detached: true, stdio: "ignore", env: appEnv() }).unref();
  },

  // One PowerShell process does every resize, background fill, label and the encoding.
  compose(spec: ComposeSpec, workDir: string) {
    if (!psPath) {
      psPath = path.join(workDir, "compose-v2.ps1");
      if (!fs.existsSync(psPath)) fs.writeFileSync(psPath, "\ufeff" + PS_SCRIPT, "utf8");
    }
    const specPath = path.join(workDir, `compose-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(specPath, JSON.stringify(spec), "utf8");
    try {
      const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", psPath, specPath], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
      const [w, h] = out.trim().split(/\r?\n/).pop()!.split(",").map(Number);
      return { width: w, height: h };
    } catch {
      return null;
    } finally {
      fs.rmSync(specPath, { force: true });
    }
  },
};
