#requires -Version 7.0
<#
.SYNOPSIS
  Native R3.13 E2E: crash recovery modal (list unclosed sessions, restore to last revision,
  discard with confirmation, and no chef-core launch when no unclosed sessions exist).
.DESCRIPTION
  Windows only. Requires chef-app.exe, pdfium.dll, and core/.venv.
  Uses CHEF_E2E=1 with isolated TEMP/CHEF_USER_DATA_DIR and drives UI via the authenticated debug pipe.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-recovery-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$docRestore = Join-Path $work 'restore-source.pdf'
$docDiscard = Join-Path $work 'discard-source.pdf'

$oldE2E = $env:CHEF_E2E
$oldUserData = $env:CHEF_USER_DATA_DIR
$oldSaveAs = $env:CHEF_E2E_SAVE_AS_PATH
$proc = $null
$passed = $false
$script:pipe = $null
$script:token = $null
$script:fails = 0
$script:runIndex = 0

function Restore-Env([string]$Name, [AllowNull()][string]$Value) {
    if ($null -eq $Value) { Remove-Item "Env:$Name" -ErrorAction SilentlyContinue }
    else { Set-Item "Env:$Name" $Value }
}

function Expect([string]$Name, [bool]$Condition, [string]$Detail) {
    if ($Condition) {
        Write-Output "PASS $Name"
    } else {
        $script:fails++
        Write-Output "FAIL $Name : $Detail"
    }
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
        if (-not $line -and $Command -eq 'quit') { return $null }
        if (-not $line) { throw "No response to debug command '$Command'." }
        $response = $line | ConvertFrom-Json
        if ($response.PSObject.Properties['ok'] -and $response.ok -eq $false) {
            throw "Debug command failed: $Command -- $($response.error)"
        }
        return $line
    } finally {
        $client.Dispose()
    }
}

function State() { return (Send 'state' | ConvertFrom-Json) }

function WaitFor([scriptblock]$Predicate, [string]$What, [int]$Seconds = 45) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($proc -and $proc.HasExited) {
            throw "chef-app exited ($($proc.ExitCode)) while waiting for $What."
        }
        if (& $Predicate) { return }
        Start-Sleep -Milliseconds 200
    }
    throw "Timed out waiting for $What."
}

function Click-Control([string]$Id) {
    $script:targetControl = $null
    $script:targetSnapshot = $null
    WaitFor {
        $snap = State
        $c = $snap.controls.controls | Where-Object { $_.id -eq $Id } | Select-Object -First 1
        if ($null -ne $c -and $null -ne $c.bounds) {
            $script:targetSnapshot = $snap
            $script:targetControl = $c
            return $true
        }
        return $false
    } "control bounds for $Id" 10
    $snapshot = $script:targetSnapshot
    $control = $script:targetControl
    $scale = [double]$snapshot.controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $scale)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $scale)
    Send "mouse move $x $y" | Out-Null
    Start-Sleep -Milliseconds 50
    Send "mouse down $x $y" | Out-Null
    Start-Sleep -Milliseconds 40
    Send "mouse up $x $y" | Out-Null
}

function Get-CoreProcesses([int]$RootProcessId) {
    $processes = @(Get-CimInstance Win32_Process)
    $processIds = @([int]$RootProcessId)
    do {
        $children = @($processes | Where-Object { $processIds -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId })
        $newIds = @($children | Where-Object { $processIds -notcontains $_ } | Sort-Object -Unique)
        if ($newIds.Count) { $processIds += $newIds }
    } while ($newIds.Count)
    return @($processes | Where-Object {
        $processIds -contains [int]$_.ProcessId -and $_.CommandLine -match '(?i)(?:-m\s+chef_core|chef_core)'
    })
}

function Stop-ProcessTree([int]$RootProcessId) {
    $corePids = @(Get-CoreProcesses $RootProcessId | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)
    foreach ($pidToKill in $corePids) {
        Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
}

function Start-ChefApp([string]$PdfPath = '') {
    $script:runIndex++
    $log = Join-Path $work ("app-$($script:runIndex).log")
    $script:pipe = $null
    $script:token = $null
    $env:CHEF_E2E = '1'
    $env:CHEF_USER_DATA_DIR = $dataDir
    $env:CHEF_E2E_SAVE_AS_PATH = $null
    $args = if ($PdfPath) { ('"' + $PdfPath + '"') } else { @() }
    try {
        if ($PdfPath) {
            $script:proc = Start-Process -FilePath $Exe -ArgumentList $args -PassThru -RedirectStandardError $log -WindowStyle Hidden
        } else {
            $script:proc = Start-Process -FilePath $Exe -PassThru -RedirectStandardError $log -WindowStyle Hidden
        }
    } finally {
        Restore-Env 'CHEF_E2E' $oldE2E
        Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
        Restore-Env 'CHEF_E2E_SAVE_AS_PATH' $oldSaveAs
    }
    WaitFor {
        if (-not (Test-Path -LiteralPath $log)) { return $false }
        $text = [string](Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue)
        $script:pipe = [regex]::Match($text, 'chef-native-\d+').Value
        $script:token = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
        if (-not $script:pipe -or -not $script:token) { return $false }
        try { return $null -ne (State) } catch { return $false }
    } 'debug pipe ready' 60
}

function Get-SessionDirs() {
    $sessionsRoot = Join-Path $dataDir 'sessions'
    if (-not (Test-Path -LiteralPath $sessionsRoot)) { return @() }
    return @(Get-ChildItem -LiteralPath $sessionsRoot -Directory -ErrorAction SilentlyContinue)
}

function Get-PdfRotation([string]$Path) {
    Push-Location (Join-Path $repo 'core')
    try {
        $rot = & uv run --no-project python -c 'import pikepdf,sys; p=pikepdf.Pdf.open(sys.argv[1]); print(int(p.pages[0].get("/Rotate",0)))' $Path
        if ($LASTEXITCODE -ne 0) { throw "pikepdf failed reading rotation of $Path" }
        return $rot.Trim()
    } finally {
        Pop-Location
    }
}

try {
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $fixture = @'
import pikepdf, sys
for path in sys.argv[1:]:
    p = pikepdf.Pdf.new()
    p.add_blank_page(page_size=(612, 792))
    p.save(path)
'@
    Push-Location (Join-Path $repo 'core')
    try {
        & uv run --no-project python -c $fixture $docRestore $docDiscard
        if ($LASTEXITCODE -ne 0) { throw 'fixture generation failed' }
    } finally {
        Pop-Location
    }
    $restoreHash = (Get-FileHash -LiteralPath $docRestore -Algorithm SHA256).Hash

    # 1. Simulate crash after creating an unsaved revision
    Start-ChefApp $docRestore
    WaitFor { $null -ne (State).view } 'initial viewer ready'
    Send 'action rotatepage' | Out-Null
    WaitFor {
        (Get-ChildItem -LiteralPath (Join-Path $dataDir 'sessions') -Filter 'rev-0001.pdf' -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
    } 'revision 1 persisted before simulated crash'
    Stop-ProcessTree $proc.Id
    $proc.WaitForExit(5000) | Out-Null
    $proc = $null
    Expect 'unclosed session remains on disk after crash' ((Get-SessionDirs).Count -eq 1) 'missing crashed session directory'

    # 2. Relaunch and verify recovery modal + restore
    Start-ChefApp
    WaitFor { (State).recovery.open -eq $true } 'recovery modal opens after crash'
    $recState = (State).recovery
    Expect 'recovery modal lists 1 crashed session' ($recState.sessions.Count -eq 1 -and $recState.sessions[0].revision -eq 1 -and $recState.sessions[0].dirty -eq $true) 'unexpected recovery session state'

    Click-Control 'recovery-restore-0'
    WaitFor {
        $s = State
        (-not $s.recovery.open) -and ($s.tabs.Count -eq 1) -and ($null -ne $s.view) -and ($s.tabs[0].dirty -eq $true)
    } 'restored session opens as dirty tab'
    Expect 'source PDF stays unchanged until saved' ((Get-FileHash -LiteralPath $docRestore -Algorithm SHA256).Hash -eq $restoreHash) 'source modified before save'

    Send 'action saveedit' | Out-Null
    WaitFor {
        $s = State
        $s.tabs.Count -eq 1 -and (-not $s.tabs[0].dirty)
    } 'saving restored session clears dirty state'
    Expect 'restored revision saves rotation to source PDF' ((Get-PdfRotation $docRestore) -eq '90') 'saved PDF did not retain rotation'

    Send 'action closetab' | Out-Null
    WaitFor { (State).tabs.Count -eq 0 -and (Get-SessionDirs).Count -eq 0 } 'closing restored session cleans session directory'
    Send 'quit' | Out-Null
    $proc.WaitForExit(5000) | Out-Null
    $proc = $null

    # 3. Simulate second crash and test discard confirmation
    Start-ChefApp $docDiscard
    WaitFor { $null -ne (State).view } 'second viewer ready'
    Send 'action rotatepage' | Out-Null
    WaitFor {
        (Get-ChildItem -LiteralPath (Join-Path $dataDir 'sessions') -Filter 'rev-0001.pdf' -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
    } 'second revision persisted before simulated crash'
    Stop-ProcessTree $proc.Id
    $proc.WaitForExit(5000) | Out-Null
    $proc = $null

    Start-ChefApp
    WaitFor { (State).recovery.open -eq $true } 'recovery modal opens for discard flow'
    Click-Control 'recovery-discard-0'
    WaitFor { $null -ne (State).recovery.confirmingDiscard } 'discard confirmation step shown'
    Expect 'discard confirmation keeps session directory until confirmed' ((Get-SessionDirs).Count -eq 1) 'session deleted before confirmation'

    Click-Control 'recovery-cancel-discard'
    WaitFor { $null -eq (State).recovery.confirmingDiscard } 'cancel discard returns to list'
    Expect 'cancelling discard retains crashed session' ((Get-SessionDirs).Count -eq 1) 'session deleted after cancel'

    Click-Control 'recovery-discard-0'
    WaitFor { $null -ne (State).recovery.confirmingDiscard } 'discard confirmation shown again'
    Click-Control 'recovery-confirm-discard'
    WaitFor {
        $s = State
        (-not $s.recovery.open) -and ((Get-SessionDirs).Count -eq 0)
    } 'confirming discard deletes session directory and closes modal'
    Expect 'confirming discard deletes crashed session directory' ((Get-SessionDirs).Count -eq 0) 'session directory still present'
    Send 'quit' | Out-Null
    $proc.WaitForExit(5000) | Out-Null
    $proc = $null

    # 4. Clean startup with no unclosed sessions must not start chef-core (R3.03 invariant)
    Start-ChefApp
    Start-Sleep -Seconds 2
    $cleanState = State
    Expect 'clean startup does not open recovery modal' (-not $cleanState.recovery.open) 'recovery modal opened unexpectedly'
    Expect 'clean startup does not start chef-core' (@(Get-CoreProcesses $proc.Id).Count -eq 0) 'chef-core started on clean startup'
    Send 'quit' | Out-Null
    $proc.WaitForExit(5000) | Out-Null
    $proc = $null

    if ($script:fails -gt 0) { throw "R3.13 recovery E2E failed with $($script:fails) failure(s)" }
    $passed = $true
} finally {
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Restore-Env 'CHEF_E2E_SAVE_AS_PATH' $oldSaveAs
    if ($proc -and -not $proc.HasExited) {
        Stop-ProcessTree $proc.Id
        $proc.WaitForExit(5000) | Out-Null
    }
    if ($passed) {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Write-Warning "E2E artifacts retained for diagnosis: $work"
    }
}

Write-Output "FAILS: $($script:fails)"
if ($script:fails -gt 0) { exit 1 }
