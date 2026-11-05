# B2 helper: moves the real cursor to (X, Y) and sends one OS wheel gesture (Delta, 120 per notch).
# Unlike Playwright's synthetic wheel, this goes to whichever window is under the cursor.
param([int]$X, [int]$Y, [int]$Delta)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ChefWheel {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
}
"@
[ChefWheel]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 150
[ChefWheel]::mouse_event([ChefWheel]::MOUSEEVENTF_WHEEL, 0, 0, $Delta, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 300
