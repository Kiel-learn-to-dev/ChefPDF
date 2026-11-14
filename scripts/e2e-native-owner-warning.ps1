#requires -Version 7.0
<#
.SYNOPSIS
  Native R3.12 E2E for the owner-password warning shown after Save As.
.DESCRIPTION
  Creates an encrypted PDF with distinct user and owner passwords, opens it in an isolated native
  app process, rotates a page, then saves to a deterministic path. The authenticated debug pipe is
  used for UI actions and state; the saved PDF is reopened independently with pikepdf.
  Requires Windows, chef-app.exe, core/.venv, and pdfium.dll. This script has not been run on Windows
  unless invoked there with a working native build and interactive app runtime.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-owner-warning-' + [guid]::NewGuid().ToString('N'))
$source = Join-Path $work 'locked.pdf'
$saved = Join-Path $work 'saved.pdf'
$dataDir = Join-Path $work 'userdata'
$log = Join-Path $work 'app.log'
$secret = 'thu123'
$oldE2E = $env:CHEF_E2E
$oldUserData = $env:CHEF_USER_DATA_DIR
$oldSaveAs = $env:CHEF_E2E_SAVE_AS_PATH
$proc = $null
$passed = $false
$script:pipe = $null
$script:token = $null

function Restore-Env([string]$Name, [AllowNull()][string]$Value) {
    if ($null -eq $Value) { Remove-Item "Env:$Name" -ErrorAction SilentlyContinue }
    else { Set-Item "Env:$Name" $Value }
}

function Send([string]$Command) {
    if (-not $script:pipe -or -not $script:token) { throw 'Debug pipe/token are not ready.' }
    $client = [System.IO.Pipes.NamedPipeClientStream]::new(
        '.', $script:pipe, [System.IO.Pipes.PipeDirection]::InOut
    )
    try {
        $client.Connect(5000)
        $writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false))
        $writer.AutoFlush = $true
        $reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false))
        $writer.WriteLine("$script:token $Command")
        $line = $reader.ReadLine()
        if (-not $line) { throw "No response to debug command '$Command'." }
        return $line
    } finally { $client.Dispose() }
}

function State() { return (Send 'state' | ConvertFrom-Json) }

function WaitFor([scriptblock]$Predicate, [string]$What, [int]$Seconds = 45) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($proc -and $proc.HasExited) {
            throw "chef-app exited ($($proc.ExitCode)) while waiting for $What. Log: $(Get-Content $log -Raw -ErrorAction SilentlyContinue)"
        }
        if (& $Predicate) { return }
        Start-Sleep -Milliseconds 200
    }
    throw "Timed out waiting for $What. Log: $(Get-Content $log -Raw -ErrorAction SilentlyContinue)"
}

function Click-Control([string]$Id) {
    $snapshot = State
    $control = $snapshot.controls.controls | Where-Object { $_.id -eq $Id } | Select-Object -First 1
    if ($null -eq $control) { throw "Control not found: $Id" }
    $scale = [double]$snapshot.controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $scale)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $scale)
    Send "mouse move $x $y" | Out-Null
    Start-Sleep -Milliseconds 60
    Send "mouse down $x $y" | Out-Null
    Start-Sleep -Milliseconds 40
    Send "mouse up $x $y" | Out-Null
}

function Pdf-State([string]$Path) {
    Push-Location (Join-Path $repo 'core')
    try {
        $json = & uv run --no-project python -c 'import json,pikepdf,sys; p=pikepdf.open(sys.argv[1],password=sys.argv[2]); print(json.dumps({"pages":len(p.pages),"rotation":int(p.pages[0].get("/Rotate",0)),"encrypted":p.is_encrypted}))' $Path $secret
        if ($LASTEXITCODE -ne 0) { throw "pikepdf could not open $Path with the user password." }
        return $json | ConvertFrom-Json
    } finally { Pop-Location }
}

try {
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    Push-Location (Join-Path $repo 'core')
    try {
        & uv run --no-project python (Join-Path $PSScriptRoot 'gen-native-password-fixture.py') $source | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'encrypted fixture generation failed' }
    } finally { Pop-Location }
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash

    $env:CHEF_E2E = '1'
    $env:CHEF_USER_DATA_DIR = $dataDir
    $env:CHEF_E2E_SAVE_AS_PATH = $saved
    $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $source + '"') -PassThru `
        -RedirectStandardError $log -WindowStyle Hidden
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Restore-Env 'CHEF_E2E_SAVE_AS_PATH' $oldSaveAs

    WaitFor {
        if (-not (Test-Path -LiteralPath $log)) { return $false }
        $text = Get-Content -LiteralPath $log -Raw
        $script:pipe = [regex]::Match($text, 'chef-native-\d+').Value
        $script:token = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
        if (-not $script:pipe -or -not $script:token) { return $false }
        try { return (State).password.open -eq $true } catch { return $false }
    } 'password prompt and authenticated debug pipe' 60

    Click-Control 'password-input'
    Send "char $secret" | Out-Null
    Start-Sleep -Milliseconds 120
    Send 'key 13' | Out-Null
    WaitFor { $snapshot = State; ($null -ne $snapshot.view) -and ($snapshot.password.open -eq $false) } 'document opens with the user password'

    Send 'action rotatepage' | Out-Null
    WaitFor {
        (Get-ChildItem -LiteralPath (Join-Path $dataDir 'sessions') -Filter 'rev-0001.pdf' -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
    } 'page.rotate creates revision 1'
    WaitFor { (State).controls.controls | Where-Object { $_.id -eq 'viewer-undo' -and -not $_.disabled } } 'viewer marks the document dirty'

    Send 'action saveeditas' | Out-Null
    WaitFor {
        if (-not (Test-Path -LiteralPath $saved)) { return $false }
        $snapshot = State
        $tab = $snapshot.tabs | Where-Object { $_.active } | Select-Object -First 1
        return ($tab -and -not $tab.dirty -and $snapshot.message)
    } 'Save As completes and clears dirty state'

    $state = State
    $warning = [string]$state.message
    if ($warning -notmatch 'The original owner password could not be preserved|Không thể giữ mật khẩu chủ sở hữu ban đầu') {
        throw "Save As did not show the owner-password warning. Actual message: [$warning]"
    }
    $savedPdf = Pdf-State $saved
    if ($savedPdf.pages -ne 1 -or $savedPdf.rotation -ne 90 -or -not $savedPdf.encrypted) {
        throw "Saved PDF did not retain the rotated, encrypted one-page document: $($savedPdf | ConvertTo-Json -Compress)"
    }
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $sourceHash) {
        throw 'Save As changed the original encrypted source.'
    }
    $sourcePdf = Pdf-State $source
    if ($sourcePdf.pages -ne 1 -or $sourcePdf.rotation -ne 0 -or -not $sourcePdf.encrypted) {
        throw "Original source integrity check failed: $($sourcePdf | ConvertTo-Json -Compress)"
    }
    Write-Output "PASS R3.12 owner-password warning: $warning"
    Write-Output 'PASS R3.12 Save As produced a readable encrypted PDF with the rotation and preserved the source bytes.'
    $passed = $true
} finally {
    if ($proc -and -not $proc.HasExited) {
        if ($script:pipe -and $script:token) { try { Send 'quit' | Out-Null } catch {} }
        if (-not $proc.WaitForExit(3000)) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    }
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Restore-Env 'CHEF_E2E_SAVE_AS_PATH' $oldSaveAs
    if ($passed) {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Write-Warning "E2E artifacts retained for diagnosis: $work"
    }
}
