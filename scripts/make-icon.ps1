# Extracts the After Effects application icon from the local install and writes
# assets/icon-256.png, icon-64.png, icon-32.png. MCP clients show this icon next
# to the server and its tool calls. Falls back to assets/icon.svg when AE is not found.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root "assets"
New-Item -ItemType Directory -Force $assets | Out-Null

$exe = $env:AE_MCP_AE_PATH
if ($exe -and (Test-Path $exe -PathType Container)) { $exe = Join-Path $exe "Support Files\AfterFX.exe" }
if (-not $exe -or -not (Test-Path $exe)) {
  $exe = Get-ChildItem "$env:ProgramFiles\Adobe" -Directory -Filter "Adobe After Effects*" -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName "Support Files\AfterFX.exe" } |
    Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $exe) { Write-Host "After Effects not found - keeping assets/icon.svg"; exit 0 }

# Ask the shell for the large (256px) icon via SHGetFileInfo / IShellItemImageFactory
Add-Type @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public static class ShellIcon {
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory { void GetImage(SIZE size, int flags, out IntPtr phbm); }
  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx; public int cy; public SIZE(int x,int y){cx=x;cy=y;} }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItemImageFactory ppv);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  public static Bitmap Get(string path, int size) {
    Guid g = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
    IShellItemImageFactory f; SHCreateItemFromParsingName(path, IntPtr.Zero, ref g, out f);
    IntPtr h; f.GetImage(new SIZE(size,size), 0x1 /*BIGGERSIZEOK*/ | 0x0 , out h);
    Bitmap src = Image.FromHbitmap(h);
    // FromHbitmap drops alpha: rebuild a 32bpp ARGB bitmap from the DIB bits
    var bmpData = src.LockBits(new Rectangle(0,0,src.Width,src.Height), System.Drawing.Imaging.ImageLockMode.ReadOnly, src.PixelFormat);
    Bitmap dst = new Bitmap(src.Width, src.Height, bmpData.Stride, System.Drawing.Imaging.PixelFormat.Format32bppArgb, bmpData.Scan0);
    Bitmap copy = new Bitmap(dst);
    src.UnlockBits(bmpData); DeleteObject(h);
    return copy;
  }
}
"@ -ReferencedAssemblies System.Drawing

$big = [ShellIcon]::Get($exe, 256)
foreach ($s in 256, 64, 32) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($big, 0, 0, $s, $s)
  $g.Dispose()
  $out = Join-Path $assets "icon-$s.png"
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "wrote $out"
}
