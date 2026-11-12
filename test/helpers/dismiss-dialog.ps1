# Closes modal dialogs (alert / message boxes) owned by After Effects by clicking their
# default button. Used only by the live test that opens an alert on purpose.
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class AeDlg {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, P f, IntPtr l);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static List<string> Close(uint pid) {
    var done = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      if (cls.ToString() != "#32770") return true;
      var title = new StringBuilder(256); GetWindowText(h, title, 256);
      EnumChildWindows(h, (c, l2) => {
        var cc = new StringBuilder(256); GetClassName(c, cc, 256);
        if (cc.ToString() == "Button") { SendMessage(c, 0x00F5, IntPtr.Zero, IntPtr.Zero); done.Add(title.ToString()); return false; }
        return true;
      }, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
    return done;
  }
}
"@
$p = Get-Process AfterFX -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p) { [AeDlg]::Close([uint32]$p.Id) | ForEach-Object { "closed: $_" } }
