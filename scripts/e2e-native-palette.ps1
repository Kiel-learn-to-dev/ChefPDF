<#
.SYNOPSIS
  R2.18 command registry/palette Windows E2E.
.DESCRIPTION
  Searches the localized Vietnamese command titles without accents, then runs an enabled command
  with Enter and verifies the viewer zoom changed. Also verifies escape/reopen resets query state.
  Defaults to authenticated debug actions. CHEF_E2E_OS_INPUT=1 opts into physical Windows keyboard
  input. Requires chef-app.exe/pdfium.dll.
#>
param([string]$Exe)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path $Exe)) { throw "chef-app.exe not found: $Exe" }
$work = Join-Path $env:TEMP ('chef-native-palette-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
$pdf = Join-Path $work 'palette.pdf'
Push-Location (Join-Path $repo 'core')
try {
    & uv run --no-project python -c 'import pikepdf,sys; p=pikepdf.Pdf.new(); p.add_blank_page(page_size=(612,792)); p.save(sys.argv[1])' $pdf
    if ($LASTEXITCODE) { throw 'fixture generation failed' }
} finally { Pop-Location }

$previousE2E = $env:CHEF_E2E
$previousUserDataDir = $env:CHEF_USER_DATA_DIR
$previousSaveAsPath = $env:CHEF_E2E_SAVE_AS_PATH
$env:CHEF_E2E = '1'
$env:CHEF_USER_DATA_DIR = Join-Path $work 'userdata'
$env:CHEF_E2E_SAVE_AS_PATH = $null
$log = Join-Path $work 'app.log'
$proc = $null
try {
    try { $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $pdf + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden }
    finally {
        $env:CHEF_E2E = $previousE2E
        $env:CHEF_USER_DATA_DIR = $previousUserDataDir
        $env:CHEF_E2E_SAVE_AS_PATH = $previousSaveAsPath
    }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and ((-not (Test-Path $log)) -or ((Get-Content $log -Raw) -notmatch 'CHEF_DEBUG_TOKEN='))) { Start-Sleep -Milliseconds 200 }
    $logText = Get-Content $log -Raw
    $pipe = [regex]::Match($logText, 'chef-native-\d+').Value
    $token = [regex]::Match($logText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    if (-not $pipe -or -not $token) { throw 'debug pipe/token missing from app log' }
    function Send([string]$command) {
        $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipe, [System.IO.Pipes.PipeDirection]::InOut)
        $client.Connect(5000)
        try {
            $writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false)); $writer.AutoFlush = $true
            $reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false))
            $writer.WriteLine("$token $command"); return $reader.ReadLine()
        } finally { $client.Dispose() }
    }
    function State() { return (Send 'state' | ConvertFrom-Json) }
    function WaitFor([scriptblock]$predicate, [string]$what) {
        $end = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $end) {
            if ($proc -and $proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)) while waiting for $what. Log: $log" }
            if (& $predicate) { return }
            Start-Sleep -Milliseconds 150
        }
        throw "Timed out waiting for $what"
    }
    if (-not ('ChefPaletteKeyboard' -as [type])) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ChefPaletteKeyboard {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
    }
    function Focus-App {
        if ($env:CHEF_E2E_OS_INPUT -ne '1') { return }
        $snapshot = State
        $hwnd = [IntPtr]::new([long]$snapshot.hwnd)
        [void][ChefPaletteKeyboard]::ShowWindow($hwnd, 9) # SW_RESTORE
        [void][ChefPaletteKeyboard]::SetWindowPos($hwnd, [IntPtr]::Zero, 100, 100, 1280, 900, 0x0040) # SWP_SHOWWINDOW
        Start-Sleep -Milliseconds 200
        [void][ChefPaletteKeyboard]::SetForegroundWindow($hwnd)
        WaitFor { (State).foreground } 'app window foreground'
    }
    function Key([byte]$key) {
        if ($env:CHEF_E2E_OS_INPUT -ne '1') {
            switch ($key) {
                0x0D { Send 'action submit' | Out-Null; return }
                0x1B { Send 'action cancel' | Out-Null; return }
                0x08 { Send 'action backspace' | Out-Null; return }
                default { throw "unsupported non-OS key: $key" }
            }
        }
        [ChefPaletteKeyboard]::keybd_event($key, 0, 0, [UIntPtr]::Zero)
        [ChefPaletteKeyboard]::keybd_event($key, 0, 2, [UIntPtr]::Zero)
    }
    function Ctrl-Key([byte]$key) {
        if ($env:CHEF_E2E_OS_INPUT -ne '1') {
            switch ($key) {
                0x41 { Send 'action selectall' | Out-Null; return }
                0x4B { Send 'action openpalette' | Out-Null; return }
                default { throw "unsupported non-OS Ctrl key: $key" }
            }
        }
        [ChefPaletteKeyboard]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
        Key $key
        [ChefPaletteKeyboard]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
    }
    function Type-Ascii([string]$text) {
        if ($env:CHEF_E2E_OS_INPUT -ne '1') { Send "char $text" | Out-Null; return }
        foreach ($character in $text.ToCharArray()) {
            if ($character -eq ' ') { Key 0x20 }
            elseif ($character -match '[a-zA-Z]') { Key ([byte][char]::ToUpperInvariant($character)) }
            else { throw "unsupported E2E ASCII character: $character" }
        }
    }
    function ReplaceQuery([string]$query) {
        Ctrl-Key 0x41 # Ctrl+A
        Key 0x08 # Backspace
        if ($query) { Type-Ascii $query }
    }

    WaitFor { $s = State; $null -ne $s.view } 'initial document rendered'
    Focus-App
    $zoomBefore = [double](State).view.zoom
    Ctrl-Key 0x4B # Ctrl+K
    WaitFor { (State).palette.open } 'palette opens and focuses query input'
    Type-Ascii 'ky so'
    WaitFor { $s = State; $s.palette.query -eq 'ky so' -and $s.palette.results.Count -gt 0 -and $s.palette.results[0].title -eq 'Ký số' } 'accentless Ký số result'
    ReplaceQuery 'nghi dinh'
    WaitFor { $s = State; $s.palette.query -eq 'nghi dinh' -and $s.palette.results[0].title -eq 'Số trang theo Nghị định 30' } 'accentless Nghị định result'
    ReplaceQuery 'phong to'
    WaitFor { $s = State; $s.palette.query -eq 'phong to' -and $s.palette.results[0].enabled } 'enabled command selected'
    Key 0x0D # Enter
    WaitFor { $s = State; -not $s.palette.open -and $null -ne $s.view -and [double]$s.view.zoom -gt $zoomBefore -and -not $s.view.fitWidth } 'Enter runs Zoom in and closes palette'

    Ctrl-Key 0x4B # Ctrl+K
    WaitFor { $s = State; $s.palette.open -and $s.palette.query -eq '' } 'reopen starts with empty query'
    Key 0x1B # Escape
    WaitFor { -not (State).palette.open } 'Escape closes palette'
    Ctrl-Key 0x4B # Ctrl+K
    WaitFor { $s = State; $s.palette.open -and $s.palette.query -eq '' } 'palette reopens cleanly after Escape'
    Send 'quit' | Out-Null
    if (-not $proc.WaitForExit(5000)) { throw 'chef-app did not exit after quit.' }
    Write-Output 'PASS R2.18: registry additions, accentless matches, Enter command execution, close/reopen reset'
}
finally {
    $env:CHEF_E2E = $previousE2E
    $env:CHEF_USER_DATA_DIR = $previousUserDataDir
    $env:CHEF_E2E_SAVE_AS_PATH = $previousSaveAsPath
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
