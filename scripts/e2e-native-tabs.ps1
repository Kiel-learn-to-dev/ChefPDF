<#
.SYNOPSIS
  R2.15 host tab E2E: open three PDF argv files, switch, reject a dirty close, close a clean tab,
  and assert that inactive viewers retain no page bitmaps.
.DESCRIPTION
  Windows only. Requires chef-app.exe, pdfium.dll, and core/.venv. Uses the authenticated debug
  pipe for state/setup. Set CHEF_E2E_OS_INPUT=1 to bring the app forward and send real Ctrl+Tab,
  Ctrl+Shift+Tab, Ctrl+W, and tab clicks. It does not exercise the OS file picker.
#>
param([string]$Exe)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path $Exe)) { throw "chef-app.exe not found: $Exe" }
$work = Join-Path $env:TEMP ('chef-native-tabs-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
$paths = 1..3 | ForEach-Object { Join-Path $work "doc-$_.pdf" }
$fixture = @'
import pikepdf, sys
p = pikepdf.Pdf.new()
p.add_blank_page(page_size=(612, 792))
p.save(sys.argv[1])
'@
Push-Location (Join-Path $repo 'core')
try {
    foreach ($path in $paths) {
        & uv run --no-project python -c $fixture $path
        if ($LASTEXITCODE) { throw 'fixture generation failed' }
    }
} finally { Pop-Location }

$previousE2E = $env:CHEF_E2E
$previousUserDataDir = $env:CHEF_USER_DATA_DIR
$previousSaveAsPath = $env:CHEF_E2E_SAVE_AS_PATH
$dataDir = Join-Path $work 'userdata'
$env:CHEF_USER_DATA_DIR = $dataDir
$env:CHEF_E2E = '1'
$env:CHEF_E2E_SAVE_AS_PATH = $null
$log = Join-Path $work 'app.log'
$proc = $null
$passed = $false
try {
    $arguments = ($paths | ForEach-Object { '"' + $_ + '"' }) -join ' '
    try { $proc = Start-Process -FilePath $Exe -ArgumentList $arguments -PassThru -RedirectStandardError $log -WindowStyle Hidden }
    finally {
        $env:CHEF_E2E = $previousE2E
        $env:CHEF_USER_DATA_DIR = $previousUserDataDir
        $env:CHEF_E2E_SAVE_AS_PATH = $previousSaveAsPath
    }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $log)) {
        if ($proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)) before creating its startup log" }
        Start-Sleep -Milliseconds 100
    }
    while ((Get-Date) -lt $deadline -and ((Get-Content $log -Raw -ErrorAction SilentlyContinue) -notmatch 'CHEF_DEBUG_TOKEN=')) {
        if ($proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)): $(Get-Content $log -Raw -ErrorAction SilentlyContinue)" }
        Start-Sleep -Milliseconds 200
    }
    if (-not (Test-Path -LiteralPath $log)) { throw 'chef-app startup log was not created' }
    $logText = Get-Content -LiteralPath $log -Raw
    $pipe = [regex]::Match($logText, 'chef-native-\d+').Value
    $token = [regex]::Match($logText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    if (-not $pipe -or -not $token) { throw 'debug pipe/token missing from app log' }
    function Send([string]$command) {
        $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipe, [System.IO.Pipes.PipeDirection]::InOut)
        try {
            $client.Connect(5000)
            $writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false)); $writer.AutoFlush = $true
            $reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false))
            $writer.WriteLine("$token $command")
            $line = $reader.ReadLine()
            if (-not $line -and $command -eq 'quit') { return }
            if (-not $line) { throw "debug command returned no response: $command" }
            $response = $line | ConvertFrom-Json
            if ($response.PSObject.Properties['ok'] -and $response.ok -eq $false) {
                throw "debug command failed: $command -- $($response.error)"
            }
            return $line
        } finally { $client.Dispose() }
    }
    function State() { return (Send 'state' | ConvertFrom-Json) }
    function WaitFor([scriptblock]$predicate, [string]$what) {
        $end = (Get-Date).AddSeconds(45)
        while ((Get-Date) -lt $end) {
            if ($proc -and $proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)) while waiting for $what. Log: $log" }
            if (& $predicate) { return }
            Start-Sleep -Milliseconds 250
        }
        throw "Timed out waiting for $what"
    }

    if (-not ('ChefTabsWindowInput' -as [type])) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct ChefTabsPoint { public int X; public int Y; }
public static class ChefTabsWindowInput {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref ChefTabsPoint point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
    }
    function FocusViewerCanvas {
        if ($env:CHEF_E2E_OS_INPUT -ne '1') { return }
        $snapshot = State
        $hwnd = [IntPtr]::new([long]$snapshot.hwnd)
        [void][ChefTabsWindowInput]::ShowWindow($hwnd, 9) # SW_RESTORE
        [void][ChefTabsWindowInput]::SetWindowPos($hwnd, [IntPtr]::Zero, 100, 100, 1280, 900, 0x0040) # SWP_SHOWWINDOW
        Start-Sleep -Milliseconds 200
        [void][ChefTabsWindowInput]::SetForegroundWindow($hwnd)
        WaitFor { (State).foreground } 'tab window foreground'
        $snapshot = State
        $x = [int]($snapshot.rect.left + ($snapshot.rect.right - $snapshot.rect.left) * 0.58)
        $y = [int]($snapshot.rect.top + ($snapshot.rect.bottom - $snapshot.rect.top) * 0.55)
        [void][ChefTabsWindowInput]::SetCursorPos($x, $y)
        [ChefTabsWindowInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [ChefTabsWindowInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 80
    }
    function Send-CtrlTab([switch]$Shift) {
        if ($env:CHEF_E2E_OS_INPUT -ne '1') {
            if ($Shift) { Send 'action tabprev' | Out-Null } else { Send 'action tabnext' | Out-Null }
            return
        }
        [ChefTabsWindowInput]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero) # Ctrl down
        if ($Shift) { [ChefTabsWindowInput]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero) }
        [ChefTabsWindowInput]::keybd_event(0x09, 0, 0, [UIntPtr]::Zero) # Tab down
        [ChefTabsWindowInput]::keybd_event(0x09, 0, 2, [UIntPtr]::Zero) # Tab up
        if ($Shift) { [ChefTabsWindowInput]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero) }
        [ChefTabsWindowInput]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero) # Ctrl up
    }
    function Send-CtrlKey([byte]$key) {
        if ($env:CHEF_E2E_OS_INPUT -ne '1') {
            if ($key -eq 0x57) { Send 'action closetab' | Out-Null; return }
            throw "unsupported non-OS Ctrl key: $key"
        }
        [ChefTabsWindowInput]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
        [ChefTabsWindowInput]::keybd_event($key, 0, 0, [UIntPtr]::Zero)
        [ChefTabsWindowInput]::keybd_event($key, 0, 2, [UIntPtr]::Zero)
        [ChefTabsWindowInput]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
    }
    function Click-TabById([int]$id) {
        $snapshot = State
        if ($env:CHEF_E2E_OS_INPUT -ne '1') {
            $target = -1; $active = -1
            for ($index = 0; $index -lt $snapshot.tabs.Count; $index++) {
                if ($snapshot.tabs[$index].id -eq $id) { $target = $index }
                if ($snapshot.tabs[$index].active) { $active = $index }
            }
            if ($target -lt 0) { throw "tab id $id is missing" }
            if ($active -lt 0) { throw 'no active tab found' }
            for ($step = 0; $step -lt $snapshot.tabs.Count -and $active -ne $target; $step++) {
                Send 'action tabnext' | Out-Null
                $active = ($active + 1) % $snapshot.tabs.Count
            }
            return
        }
        $control = $snapshot.controls.controls | Where-Object { $_.id -eq "doc-tab-$id" } | Select-Object -First 1
        if ($null -eq $control -or $null -eq $control.bounds) { throw "tab control bounds are missing for id $id" }
        $scale = [double]$snapshot.controls.scale
        $point = [ChefTabsPoint]::new()
        $point.X = [int](($control.bounds[0] + $control.bounds[2] / 2) * $scale)
        $point.Y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $scale)
        $hwnd = [IntPtr]::new([long]$snapshot.hwnd)
        if (-not [ChefTabsWindowInput]::ClientToScreen($hwnd, [ref]$point)) { throw "ClientToScreen failed for tab $id" }
        [void][ChefTabsWindowInput]::SetCursorPos($point.X, $point.Y)
        Start-Sleep -Milliseconds 60
        [ChefTabsWindowInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [ChefTabsWindowInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    }

    WaitFor { $s = State; $s.tabs.Count -eq 3 -and $s.tabs[2].active -and $s.tabs[2].cachedPages -gt 0 } 'three argv tabs, last active, and rendered bitmap'
    FocusViewerCanvas
    Send-CtrlTab
    WaitFor { $s = State; $s.tabs[0].active -and @($s.tabs | Where-Object { -not $_.active -and $_.cachedPages -gt 0 }).Count -eq 0 } 'Ctrl+Tab wraps to first tab and evicts inactive bitmaps'
    Click-TabById ([int](State).tabs[2].id)
    WaitFor { (State).tabs[2].active } 'tab control selects third tab'
    FocusViewerCanvas
    Send-CtrlTab -Shift
    WaitFor { $s = State; $s.tabs[1].active -and @($s.tabs | Where-Object { -not $_.active -and $_.cachedPages -gt 0 }).Count -eq 0 } 'Ctrl+Shift+Tab selects second tab and clears inactive caches'
    Send-CtrlTab -Shift
    WaitFor { $s = State; $s.tabs[0].active -and @($s.tabs | Where-Object { -not $_.active -and $_.cachedPages -gt 0 }).Count -eq 0 } 'Ctrl+Shift+Tab selects first tab'

    Send 'action rotatepage' | Out-Null
    WaitFor { $s = State; $s.tabs[0].dirty } 'first tab becomes dirty after edit'
    FocusViewerCanvas
    Send-CtrlKey 0x57 # Ctrl+W
    WaitFor { $s = State; $s.tabs.Count -eq 3 -and $s.tabs[0].active -and $s.tabs[0].dirty -and $s.tabMessage -match 'Lưu thay đổi' } 'dirty active tab close is rejected'

    Send-CtrlTab
    WaitFor { $s = State; $s.tabs[1].active } 'switch away while retaining the dirty tab'
    FocusViewerCanvas
    Send-CtrlKey 0x57 # Ctrl+W
    WaitFor { $s = State; $s.tabs.Count -eq 2 -and $s.tabs[1].active } 'clean active tab closes and selects its next neighbor'
    $final = State
    if (@($final.tabs | Where-Object { -not $_.active -and $_.cachedPages -gt 0 }).Count -gt 0) { throw 'inactive tab retained page bitmap cache' }
    Send 'quit' | Out-Null
    if (-not $proc.WaitForExit(5000)) { throw 'chef-app did not exit after quit.' }
    Write-Output 'PASS R2.15 tab host: argv tabs, switch/cache eviction, dirty close guard, clean close selection'
    $passed = $true
}
finally {
    $env:CHEF_E2E = $previousE2E
    $env:CHEF_USER_DATA_DIR = $previousUserDataDir
    $env:CHEF_E2E_SAVE_AS_PATH = $previousSaveAsPath
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        if (-not $proc.WaitForExit(5000)) { Write-Warning "chef-app process $($proc.Id) did not exit during cleanup." }
    }
    if ($passed) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    else { Write-Warning "E2E artifacts retained for diagnosis: $work" }
}
