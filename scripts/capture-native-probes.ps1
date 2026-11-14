<#
.SYNOPSIS
  Capture native Rust visual probes for R1.43 at the planned widths and themes.
.DESCRIPTION
  Starts a fresh CHEF_E2E_PROBE window for each theme/width pair and saves WGC BMP captures plus
  capture-index.json outside the repository and temporary directory. These are Rust candidates;
  they are not Electron references and do not count as R1.43 comparison results.
  Requires Windows, PowerShell 7, chef-app.exe and its adjacent pdfium.dll.
#>
param(
    [string]$Exe,
    [string]$OutputDirectory,
    [int[]]$Widths = @(800, 1184, 1484),
    [string[]]$Themes = @('light', 'dark'),
    [switch]$VisibleProbe,
    [switch]$MeasurePointer
)

$ErrorActionPreference = 'Stop'
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot '..\apps\native\target\debug\chef-app.exe' }
$Exe = (Resolve-Path -LiteralPath $Exe).Path
if (-not $OutputDirectory) {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required; pass an external OutputDirectory.' }
    $OutputDirectory = Join-Path $env:LOCALAPPDATA 'ChefPDF/visual-candidates/R1.43'
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { throw "chef-app.exe not found: $Exe" }
if (-not (Test-Path -LiteralPath (Join-Path (Split-Path $Exe) 'pdfium.dll') -PathType Leaf)) {
    throw "pdfium.dll must be beside chef-app.exe: $Exe"
}
if ($Widths.Count -lt 1 -or @($Widths | Where-Object { $_ -lt 800 -or $_ -gt 2400 }).Count -gt 0) {
    throw 'Widths must be between 800 and 2400 logical pixels.'
}
if ($Themes.Count -lt 1 -or @($Themes | Where-Object { $_ -notin @('light', 'dark') }).Count -gt 0) {
    throw 'Themes must contain only light and/or dark.'
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd([IO.Path]::DirectorySeparatorChar)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
if ($OutputDirectory.Equals($repoRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $OutputDirectory.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDirectory must be outside the repository: $OutputDirectory"
}
if ($OutputDirectory.Equals($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $OutputDirectory.StartsWith($tempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDirectory must be outside the temporary directory: $OutputDirectory"
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$previous = @{
    E2E = $env:CHEF_E2E
    Probe = $env:CHEF_E2E_PROBE
    VisualOnly = $env:CHEF_E2E_PROBE_VISUAL_ONLY
    Width = $env:CHEF_E2E_PROBE_WIDTH
    VisibleProbe = $env:CHEF_E2E_PROBE_VISIBLE
    Theme = $env:CHEF_THEME
    UserData = $env:CHEF_USER_DATA_DIR
}
$captures = [Collections.Generic.List[object]]::new()
$cursorChecks = [Collections.Generic.List[object]]::new()
$process = $null
$currentUserData = $null
$pipe = $null
$token = $null
$originalCursor = $null

if ($MeasurePointer) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class NativeCursorProbe {
    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetCursorInfo(ref CURSORINFO info);

    [DllImport("user32.dll", EntryPoint = "LoadCursorW", CharSet = CharSet.Unicode)]
    private static extern IntPtr LoadCursor(IntPtr instance, IntPtr name);

    public static string MoveToControlAndRead(long hwndValue, float[] bounds, double scale) {
        if (bounds == null || bounds.Length != 4) throw new ArgumentException("Expected x,y,width,height bounds.");
        var origin = new POINT { X = 0, Y = 0 };
        if (!ClientToScreen(new IntPtr(hwndValue), ref origin)) throw new InvalidOperationException("ClientToScreen failed.");
        int x = origin.X + (int)Math.Round((bounds[0] + bounds[2] / 2.0) * scale);
        int y = origin.Y + (int)Math.Round((bounds[1] + bounds[3] / 2.0) * scale);
        if (!SetCursorPos(x, y)) throw new InvalidOperationException("SetCursorPos failed.");
        System.Threading.Thread.Sleep(180);
        var info = new CURSORINFO { cbSize = Marshal.SizeOf<CURSORINFO>() };
        if (!GetCursorInfo(ref info)) throw new InvalidOperationException("GetCursorInfo failed.");
        if ((info.flags & 1) == 0) return "hidden";
        if (info.hCursor == LoadCursor(IntPtr.Zero, new IntPtr(32649))) return "hand";
        if (info.hCursor == LoadCursor(IntPtr.Zero, new IntPtr(32512))) return "arrow";
        return "other";
    }
}
'@
}

function Restore-Env([string]$Name, $Value) {
    if ($null -eq $Value) { Remove-Item "Env:$Name" -ErrorAction SilentlyContinue }
    else { Set-Item "Env:$Name" $Value }
}

function Send([string]$Command) {
    if (-not $script:pipe -or -not $script:token) { throw 'Debug pipe/token are not ready.' }
    $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $script:pipe, [System.IO.Pipes.PipeDirection]::InOut)
    try {
        $client.Connect(5000)
        $writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false))
        $writer.AutoFlush = $true
        $reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false))
        $writer.WriteLine("$script:token $Command")
        $line = $reader.ReadLine()
        if (-not $line -and $Command -eq 'quit') { return }
        if (-not $line) { throw "No response for debug command: $Command" }
        $response = $line | ConvertFrom-Json
        if ($response.PSObject.Properties['ok'] -and $response.ok -eq $false) {
            throw "Debug command failed: $Command -- $($response.error)"
        }
        return $response
    } finally { $client.Dispose() }
}

try {
    foreach ($theme in $Themes) {
        foreach ($width in $Widths) {
            $key = "probe_${theme}_w$width"
            $log = Join-Path $OutputDirectory "$key.log"
            $capturePath = Join-Path $OutputDirectory "$key.bmp"
            $userData = Join-Path $env:TEMP ("chef-probe-capture-" + [guid]::NewGuid().ToString('N'))
            $currentUserData = $userData
            $state = $null
            $env:CHEF_E2E = '1'
            $env:CHEF_E2E_PROBE = '1'
            $env:CHEF_E2E_PROBE_VISUAL_ONLY = '1'
            $env:CHEF_E2E_PROBE_WIDTH = [string]$width
            $env:CHEF_E2E_PROBE_VISIBLE = if ($VisibleProbe -or $MeasurePointer) { '1' } else { '0' }
            $env:CHEF_THEME = $theme
            $env:CHEF_USER_DATA_DIR = $userData
            try {
                $process = Start-Process -FilePath $Exe -PassThru -RedirectStandardError $log -WindowStyle Hidden
            } finally {
                Restore-Env 'CHEF_E2E' $previous.E2E
                Restore-Env 'CHEF_E2E_PROBE' $previous.Probe
                Restore-Env 'CHEF_E2E_PROBE_VISUAL_ONLY' $previous.VisualOnly
                Restore-Env 'CHEF_E2E_PROBE_WIDTH' $previous.Width
                Restore-Env 'CHEF_E2E_PROBE_VISIBLE' $previous.VisibleProbe
                Restore-Env 'CHEF_THEME' $previous.Theme
                Restore-Env 'CHEF_USER_DATA_DIR' $previous.UserData
            }

            $deadline = [DateTime]::UtcNow.AddSeconds(60)
            do {
                if ($process.HasExited) { throw "chef-app exited ($($process.ExitCode)); log: $log" }
                if (Test-Path -LiteralPath $log) {
                    $text = [string](Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue)
                    $script:pipe = [regex]::Match($text, 'chef-native-\d+').Value
                    $script:token = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
                    if ($script:pipe -and $script:token) {
                        try {
                            $state = Send 'state'
                            if ([int]$state.renders -gt 0 -and $state.visible -and $state.controls.controls.Count -gt 0) { break }
                        } catch { }
                    }
                }
                Start-Sleep -Milliseconds 200
            } while ([DateTime]::UtcNow -lt $deadline)
            if (-not $state -or [int]$state.renders -le 0) { throw "Probe did not render: $key; log: $log" }

            if ($MeasurePointer) {
                if (-not $state.cursor.ok) { throw "GetCursorInfo unavailable while measuring $key" }
                if ($null -eq $originalCursor) { $originalCursor = @{ x = [int]$state.cursor.x; y = [int]$state.cursor.y } }
                [NativeCursorProbe]::SetCursorPos(0, 0) | Out-Null
            }
            Start-Sleep -Milliseconds 200
            $capture = Send "screenshot $capturePath"
            if (-not $capture.ok -or -not (Test-Path -LiteralPath $capturePath -PathType Leaf)) {
                throw "Probe screenshot failed for ${key}: $($capture | ConvertTo-Json -Compress)"
            }
            $captures.Add([pscustomobject]@{
                name = $key
                theme = $theme
                logicalWidth = $width
                logicalHeight = 1600
                devicePixelRatio = [double]$state.controls.scale
                widthPx = [int]$capture.width
                heightPx = [int]$capture.height
                format = 'bmp'
                visible = [bool]$VisibleProbe
                file = [IO.Path]::GetFileName($capturePath)
                sha256 = (Get-FileHash -LiteralPath $capturePath -Algorithm SHA256).Hash.ToLowerInvariant()
            })
            Write-Output "CAPTURED $key $($capture.width)x$($capture.height)"

            if ($MeasurePointer) {
                $button = $state.controls.controls | Where-Object { $_.id -eq 'probe-primary' } | Select-Object -First 1
                if (-not $button -or -not $button.bounds) { throw "probe-primary bounds unavailable for cursor check: $key" }
                try {
                    $cursorType = [NativeCursorProbe]::MoveToControlAndRead(
                        [long]$state.hwnd,
                        [single[]]@($button.bounds),
                        [double]$state.controls.scale
                    )
                } finally {
                    [NativeCursorProbe]::SetCursorPos($originalCursor.x, $originalCursor.y) | Out-Null
                }
                if ($cursorType -ne 'hand') { throw "Expected hand cursor over probe-primary, got '$cursorType' for $key" }
                $cursorChecks.Add([pscustomobject]@{ capture = $key; cursor = $cursorType })
                Write-Output "CURSOR $key $cursorType"
            }

            try { Send 'quit' | Out-Null } catch {}
            if (-not $process.WaitForExit(5000)) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                if (-not $process.WaitForExit(5000)) { throw "chef-app did not exit after capture: $key" }
            }
            $process = $null
            Remove-Item -LiteralPath $userData -Recurse -Force -ErrorAction SilentlyContinue
            $currentUserData = $null
            $state = $null
        }
    }
    $index = [pscustomobject]@{
        generatedAt = [DateTime]::UtcNow.ToString('o')
        source = 'Chef PDF native Rust probe; captures are not Electron references'
        visualOnly = $true
        captures = @($captures.ToArray())
        cursorChecks = @($cursorChecks.ToArray())
    }
    $index | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'capture-index.json') -Encoding utf8
    Write-Output "Capture index: $(Join-Path $OutputDirectory 'capture-index.json')"
} finally {
    if ($process -and -not $process.HasExited) {
        try { Send 'quit' | Out-Null } catch {}
        if (-not $process.WaitForExit(3000)) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            [void]$process.WaitForExit(5000)
        }
    }
    if ($currentUserData) { Remove-Item -LiteralPath $currentUserData -Recurse -Force -ErrorAction SilentlyContinue }
    if ($MeasurePointer -and $originalCursor) {
        [NativeCursorProbe]::SetCursorPos($originalCursor.x, $originalCursor.y) | Out-Null
    }
    Restore-Env 'CHEF_E2E' $previous.E2E
    Restore-Env 'CHEF_E2E_PROBE' $previous.Probe
    Restore-Env 'CHEF_E2E_PROBE_VISUAL_ONLY' $previous.VisualOnly
    Restore-Env 'CHEF_E2E_PROBE_WIDTH' $previous.Width
    Restore-Env 'CHEF_E2E_PROBE_VISIBLE' $previous.VisibleProbe
    Restore-Env 'CHEF_THEME' $previous.Theme
    Restore-Env 'CHEF_USER_DATA_DIR' $previous.UserData
}
