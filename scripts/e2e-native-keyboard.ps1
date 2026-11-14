<# R2.31 focus-priority E2E: PageUp/PageDown must edit a focused one-line query, not navigate the PDF. #>
param([string]$Exe)
$ErrorActionPreference = 'Stop'
if ($env:CHEF_E2E_OS_INPUT -ne '1') {
    Write-Output 'SKIP physical key check; set CHEF_E2E_OS_INPUT=1 to opt in'
    exit 0
}
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path $Exe)) { throw "chef-app.exe not found: $Exe" }
$work = Join-Path $env:TEMP ('chef-native-keyboard-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
$pdf = Join-Path $work 'three-pages.pdf'
$fixture = @'
import pikepdf, sys
pdf = pikepdf.Pdf.new()
for _ in range(3): pdf.add_blank_page(page_size=(612, 792))
pdf.save(sys.argv[1])
'@
Push-Location (Join-Path $repo 'core')
try {
    & uv run --no-project python -c $fixture $pdf
    if ($LASTEXITCODE) { throw 'PDF fixture generation failed' }
} finally { Pop-Location }

$oldE2E = $env:CHEF_E2E
$oldUserData = $env:CHEF_USER_DATA_DIR
$env:CHEF_E2E = '1'
$env:CHEF_USER_DATA_DIR = Join-Path $work 'userdata'
$log = Join-Path $work 'app.log'
$proc = $null
try {
    try { $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $pdf + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden }
    finally { $env:CHEF_E2E = $oldE2E; $env:CHEF_USER_DATA_DIR = $oldUserData }

    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and ((-not (Test-Path $log)) -or ((Get-Content $log -Raw) -notmatch 'CHEF_DEBUG_TOKEN='))) { Start-Sleep -Milliseconds 200 }
    if (-not (Test-Path $log)) { throw 'app log was not created' }
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
            if ($proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)) while waiting for $what. Log: $log" }
            if (& $predicate) { return }
            Start-Sleep -Milliseconds 150
        }
        throw "Timed out waiting for $what"
    }
    if (-not ('ChefKeyboardFocusInput' -as [type])) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ChefKeyboardFocusInput {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
    }
    function Key([byte]$key) {
        [ChefKeyboardFocusInput]::keybd_event($key, 0, 0, [UIntPtr]::Zero)
        [ChefKeyboardFocusInput]::keybd_event($key, 0, 2, [UIntPtr]::Zero)
    }
    function Type-Ascii([string]$text) {
        foreach ($character in $text.ToCharArray()) { Key ([byte][char]::ToUpperInvariant($character)) }
    }

    WaitFor { $null -ne (State).view } 'initial viewer render'
    $snapshot = State
    $hwnd = [IntPtr]::new([long]$snapshot.hwnd)
    [void][ChefKeyboardFocusInput]::ShowWindow($hwnd, 9) # SW_RESTORE
    [void][ChefKeyboardFocusInput]::SetWindowPos($hwnd, [IntPtr]::Zero, 100, 100, 1280, 900, 0x0040) # SWP_SHOWWINDOW
    Start-Sleep -Milliseconds 200
    [void][ChefKeyboardFocusInput]::SetForegroundWindow($hwnd)
    WaitFor { (State).foreground } 'app foreground'

    Send 'action nextpage' | Out-Null
    WaitFor { (State).view.firstPage -eq 1 } 'viewer advances to page 2 before input receives focus'
    Send 'action focussearch' | Out-Null
    WaitFor { (State).input.focused } 'search input focus'
    Type-Ascii 'abc'
    WaitFor { $s = State; $s.input.text -eq 'abc' -and $s.input.selStart -eq 3 } 'query typed with caret at end'
    $pageBefore = [int](State).view.firstPage

    Key 0x21 # PageUp; TextInput context maps it to Home
    WaitFor { $s = State; $s.input.selStart -eq 0 -and $s.view.firstPage -eq $pageBefore } 'PageUp moves query caret to start without changing PDF page'
    Key 0x22 # PageDown; TextInput context maps it to End
    WaitFor { $s = State; $s.input.selStart -eq 3 -and $s.view.firstPage -eq $pageBefore } 'PageDown moves query caret to end without changing PDF page'
    Write-Output 'PASS R2.31: physical PageUp/PageDown respect focused TextInput and do not navigate the PDF'
    Send 'quit' | Out-Null
    if (-not $proc.WaitForExit(5000)) { throw 'chef-app did not exit after quit.' }
}
finally {
    $env:CHEF_E2E = $oldE2E
    $env:CHEF_USER_DATA_DIR = $oldUserData
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
