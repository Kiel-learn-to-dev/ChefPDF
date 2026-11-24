<#
Capture native viewer screenshots for R2.32 at the same CSS size as the Electron R1.21 "main:view" references
(menu_pages.pdf, both themes). Output goes outside the repository and %TEMP%.
DPR is the Windows display scale of this machine (1.75 here); the script refuses to write a file whose
client size does not match CSS size x DPR.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$Pdf,
    [Parameter(Mandatory = $true)] [string]$OutputDirectory,
    [string]$Exe,
    [int]$Width = 1269,
    [int]$Height = 786,
    [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot '..\apps\native\target\debug\chef-app.exe' }
$Exe = (Resolve-Path -LiteralPath $Exe).Path
$Pdf = (Resolve-Path -LiteralPath $Pdf).Path
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd([IO.Path]::DirectorySeparatorChar)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
foreach ($root in @($repoRoot, $tempRoot)) {
    if ($OutputDirectory.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or
        $OutputDirectory.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "OutputDirectory must be outside the repository and temporary directory: $OutputDirectory"
    }
}
if (-not (Test-Path -LiteralPath (Join-Path (Split-Path $Exe) 'pdfium.dll') -PathType Leaf)) {
    throw "pdfium.dll must be beside chef-app.exe: $Exe"
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

if (-not ('NativeViewerCrop' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeViewerCrop {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public static int[] ClientBox(long hwndValue) {
    IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    if (previous == IntPtr.Zero) throw new InvalidOperationException("Cannot set per-monitor DPI context.");
    try {
      IntPtr hwnd = new IntPtr(hwndValue);
      RECT frame, client; POINT origin = new POINT { X = 0, Y = 0 };
      if (DwmGetWindowAttribute(hwnd, 9, out frame, Marshal.SizeOf(typeof(RECT))) != 0 ||
          !GetClientRect(hwnd, out client) || !ClientToScreen(hwnd, ref origin))
        throw new InvalidOperationException("Could not resolve the native client rectangle.");
      return new int[] { origin.X - frame.L, origin.Y - frame.T, client.R - client.L, client.B - client.T };
    } finally { SetThreadDpiAwarenessContext(previous); }
  }
}
'@
}
Add-Type -AssemblyName System.Drawing

function Send([string]$Command) {
    $client = [IO.Pipes.NamedPipeClientStream]::new('.', $script:pipe, [IO.Pipes.PipeDirection]::InOut)
    try {
        $client.Connect(5000)
        $writer = [IO.StreamWriter]::new($client, [Text.UTF8Encoding]::new($false))
        $writer.AutoFlush = $true
        $reader = [IO.StreamReader]::new($client, [Text.UTF8Encoding]::new($false))
        $writer.WriteLine("$script:token $Command")
        $line = $reader.ReadLine()
        if (-not $line -and $Command -eq 'quit') { return }
        if (-not $line) { throw "No response to '$Command'." }
        return $line | ConvertFrom-Json
    } finally { $client.Dispose() }
}

foreach ($theme in @('light', 'dark')) {
    $work = Join-Path $env:TEMP ("chef-native-viewer-" + [guid]::NewGuid().ToString('N'))
    $userData = Join-Path $work 'userdata'
    New-Item -ItemType Directory -Path $userData -Force | Out-Null
    $settings = @{ version = 1; language = 'vi'; theme = $theme; defaultSaveDir = $work; recentFiles = @() }
    [IO.File]::WriteAllText((Join-Path $userData 'settings.json'), ($settings | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    $log = Join-Path $work 'app.log'
    $saved = @{ E2E = $env:CHEF_E2E; UserData = $env:CHEF_USER_DATA_DIR }
    $proc = $null
    $script:pipe = $null; $script:token = $null
    try {
        $env:CHEF_E2E = '1'
        $env:CHEF_USER_DATA_DIR = $userData
        try { $proc = Start-Process -FilePath $Exe -ArgumentList @("`"$Pdf`"") -PassThru -RedirectStandardError $log -WindowStyle Hidden }
        finally {
            if ($null -eq $saved.E2E) { Remove-Item Env:CHEF_E2E -ErrorAction SilentlyContinue } else { $env:CHEF_E2E = $saved.E2E }
            if ($null -eq $saved.UserData) { Remove-Item Env:CHEF_USER_DATA_DIR -ErrorAction SilentlyContinue } else { $env:CHEF_USER_DATA_DIR = $saved.UserData }
        }
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        $ready = $false
        do {
            if ($proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)): $log" }
            if (Test-Path -LiteralPath $log) {
                $text = [string](Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue)
                $script:pipe = [regex]::Match($text, 'chef-native-\d+').Value
                $script:token = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
                if ($script:pipe -and $script:token) {
                    try {
                        $state = Send 'state'
                        # Ready when the first page is rendered and nothing is pending.
                        if ($null -ne $state.view -and [int]$state.cached -gt 0 -and [int]$state.pending -eq 0) { $ready = $true; break }
                    } catch { }
                }
            }
            Start-Sleep -Milliseconds 200
        } while ([DateTime]::UtcNow -lt $deadline)
        if (-not $ready) { throw "Viewer did not render within ${TimeoutSeconds}s: $log" }

        $resize = Send "resize $Width $Height"
        if ($resize.ok -eq $false) { throw "Resize failed: $($resize.error)" }
        Start-Sleep -Milliseconds 800
        $state = Send 'state'
        $bmp = Join-Path $OutputDirectory "tmp_view_${theme}.bmp"
        $png = Join-Path $OutputDirectory "native_view_${theme}_${Width}x${Height}.png"
        $capture = Send "screenshot $bmp"
        if (-not $capture.ok -or -not (Test-Path -LiteralPath $bmp)) { throw "Screenshot failed: $($capture | ConvertTo-Json -Compress)" }
        $box = [NativeViewerCrop]::ClientBox([long]$state.hwnd)
        $source = [System.Drawing.Bitmap]::FromFile($bmp)
        try {
            if ($box[0] -lt 0 -or $box[1] -lt 0 -or $box[0] + $box[2] -gt $source.Width -or $box[1] + $box[3] -gt $source.Height) {
                throw "Client rectangle is outside the WGC frame for $theme."
            }
            $cropped = $source.Clone([System.Drawing.Rectangle]::new($box[0], $box[1], $box[2], $box[3]), [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        } finally { $source.Dispose() }
        try { $cropped.Save($png, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $cropped.Dispose() }
        $actual = [System.Drawing.Bitmap]::FromFile($png)
        try {
            $expectedW = [int][math]::Round($Width * [double]$state.scale)
            $expectedH = [int][math]::Round($Height * [double]$state.scale)
            if ($actual.Width -ne $expectedW -or $actual.Height -ne $expectedH) {
                throw "Unexpected client size for ${theme}: $($actual.Width)x$($actual.Height), expected ${expectedW}x${expectedH} at DPR $($state.scale)."
            }
            Write-Output "CAPTURED $theme ${Width}x${Height} CSS @ DPR $($state.scale): $png"
        } finally { $actual.Dispose() }
        Remove-Item -LiteralPath $bmp -Force
        Send 'quit' | Out-Null
        $proc.WaitForExit(10000) | Out-Null
    } finally {
        if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}
