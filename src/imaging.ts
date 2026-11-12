import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export type ImageFormat = "png" | "jpeg";

export interface ComposeSpec {
  files: string[];
  labels?: string[];
  /** Longest side of each cell (or of the single image). */
  maxSize: number;
  /** Columns of the grid; 1 file with columns 1 = plain resize/convert. */
  columns: number;
  format: ImageFormat;
  quality: number;
  output: string;
  /** What shows through transparent pixels: the comp color, a checkerboard, or nothing (PNG alpha). */
  background?: { type: "color"; rgb: number[] } | { type: "checker" } | { type: "none" };
}

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

/**
 * Resize / convert / tile frames into one image. Returns its size, or null when
 * no image tool is available (the caller then sends the original files).
 */
export function compose(spec: ComposeSpec, workDir: string): { width: number; height: number } | null {
  if (process.platform === "win32") {
    if (!psPath) {
      psPath = path.join(workDir, "compose-v2.ps1");
      if (!fs.existsSync(psPath)) fs.writeFileSync(psPath, "﻿" + PS_SCRIPT, "utf8");
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
  }
  if (process.platform === "darwin" && spec.files.length === 1) {
    try {
      const args = ["-Z", String(spec.maxSize)];
      if (spec.format === "jpeg") args.push("-s", "format", "jpeg", "-s", "formatOptions", String(spec.quality));
      execFileSync("sips", [...args, spec.files[0], "--out", spec.output], { timeout: 30_000 });
      const info = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", spec.output], { encoding: "utf8" });
      return { width: Number(/pixelWidth: (\d+)/.exec(info)?.[1]), height: Number(/pixelHeight: (\d+)/.exec(info)?.[1]) };
    } catch {
      return null;
    }
  }
  return null;
}
