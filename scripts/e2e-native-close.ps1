#requires -Version 7.0
<#
.SYNOPSIS
  Native R3.14 E2E: dirty close confirmation (cancel, discard, save), window close guard,
  session directory cleanup, and clean chef-core shutdown.
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

$work = Join-Path $env:TEMP ('chef-native-close-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$log = Join-Path $work 'app.log'
$doc1 = Join-Path $work 'close-1.pdf'
$doc2 = Join-Path $work 'close-2.pdf'
$winA = Join-Path $work 'win-a.pdf'
$winB = Join-Path $work 'win-b.pdf'
$winC = Join-Path $work 'win-c.pdf'

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
            throw "chef-app exited ($($proc.ExitCode)) while waiting for $What. Log: $(Get-Content $log -Raw -ErrorAction SilentlyContinue)"
        }
        if (& $Predicate) { return }
        Start-Sleep -Milliseconds 200
    }
    throw "Timed out waiting for $What. Log: $(Get-Content $log -Raw -ErrorAction SilentlyContinue)"
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

function Start-CloseApp([string[]]$Files, [int]$ExpectedTabs) {
    $script:runIndex++
    $script:log = Join-Path $work ("app-$($script:runIndex).log")
    $script:pipe = $null
    $script:token = $null
    $env:CHEF_E2E = '1'
    $env:CHEF_USER_DATA_DIR = $dataDir
    $env:CHEF_E2E_SAVE_AS_PATH = $null
    $arguments = ($Files | ForEach-Object { '"{0}"' -f $_ }) -join ' '
    try {
        $script:proc = Start-Process -FilePath $Exe -ArgumentList $arguments -PassThru -RedirectStandardError $script:log -WindowStyle Hidden
    } finally {
        Restore-Env 'CHEF_E2E' $oldE2E
        Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
        Restore-Env 'CHEF_E2E_SAVE_AS_PATH' $oldSaveAs
    }

    WaitFor {
        if (-not (Test-Path -LiteralPath $script:log)) { return $false }
        $text = [string](Get-Content -LiteralPath $script:log -Raw -ErrorAction SilentlyContinue)
        $script:pipe = [regex]::Match($text, 'chef-native-\d+').Value
        $script:token = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
        if (-not $script:pipe -or -not $script:token) { return $false }
        try {
            $s = State
            return ($s.tabs.Count -eq $ExpectedTabs -and $null -ne $s.view)
        } catch {
            return $false
        }
    } "$ExpectedTabs tab(s) ready" 60
}

function Assert-CleanShutdown([int[]]$CorePids, [string]$Label) {
    if (-not $proc.WaitForExit(15000)) { throw "chef-app did not exit cleanly after $Label" }
    Expect "$Label exits with code 0" ($proc.ExitCode -eq 0) "exit code was $($proc.ExitCode)"
    Expect "$Label leaves zero session directories" ((Get-SessionDirs).Count -eq 0) "remaining session dirs: $((Get-SessionDirs).Count)"
    $exitDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $liveCore = @($CorePids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if ($liveCore.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $exitDeadline)
    Expect "$Label leaves zero chef-core processes" ($liveCore.Count -eq 0) ("remaining core PIDs: $($liveCore -join ',')")
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
        & uv run --no-project python -c $fixture $doc1 $doc2 $winA $winB $winC
        if ($LASTEXITCODE -ne 0) { throw 'fixture generation failed' }
    } finally {
        Pop-Location
    }
    $doc1Hash = (Get-FileHash -LiteralPath $doc1 -Algorithm SHA256).Hash
    $winCHash = (Get-FileHash -LiteralPath $winC -Algorithm SHA256).Hash

    Start-CloseApp @($doc1, $doc2) 2

    # Make active tab (doc2) dirty -> close -> cancel -> close -> save
    Send 'action rotatepage' | Out-Null
    WaitFor {
        $s = State
        $tab = $s.tabs | Where-Object { $_.active } | Select-Object -First 1
        return ($tab -and $tab.dirty -and (Get-SessionDirs).Count -eq 1)
    } 'doc2 becomes dirty with active session directory'
    $trackedCorePids = @(Get-CoreProcesses $proc.Id | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)
    Expect 'chef-core is running after edit' ($trackedCorePids.Count -gt 0) 'expected live chef-core process'

    Send 'action closetab' | Out-Null
    WaitFor { (State).closePrompt.open -eq $true } 'close prompt opens for dirty tab'
    Expect 'dirty tab close opens confirmation prompt' ((State).closePrompt.open -eq $true) 'closePrompt.open was false'

    Click-Control 'close-prompt-cancel'
    WaitFor { (State).closePrompt.open -eq $false } 'cancel closes confirmation prompt'
    $s = State
    Expect 'cancel keeps dirty tab open' ($s.tabs.Count -eq 2 -and (@($s.tabs | Where-Object { $_.title -eq 'close-2.pdf' -and $_.dirty }).Count -eq 1)) 'tab missing or clean after cancel'
    Expect 'cancel keeps session directory' ((Get-SessionDirs).Count -eq 1) 'session dir removed on cancel'

    Send 'action closetab' | Out-Null
    WaitFor { (State).closePrompt.open -eq $true } 'close prompt reopens for save-and-close'
    Click-Control 'close-prompt-save'
    WaitFor {
        $s = State
        (-not $s.closePrompt.open) -and ($s.tabs.Count -eq 1) -and ((Get-SessionDirs).Count -eq 0)
    } 'save-and-close persists edit, closes tab, and deletes session directory'
    Expect 'save-and-close wrote rotation to doc2' ((Get-PdfRotation $doc2) -eq '90') 'doc2 rotation not saved'

    # Now active tab is doc1: rotate -> close -> discard
    Send 'action rotatepage' | Out-Null
    WaitFor {
        $s = State
        $tab = $s.tabs | Where-Object { $_.active } | Select-Object -First 1
        return ($tab -and $tab.dirty -and (Get-SessionDirs).Count -eq 1)
    } 'doc1 becomes dirty with active session directory'

    Send 'action closetab' | Out-Null
    WaitFor { (State).closePrompt.open -eq $true } 'close prompt opens for discard'
    Click-Control 'close-prompt-discard'
    WaitFor {
        $s = State
        (-not $s.closePrompt.open) -and ($s.tabs.Count -eq 0) -and ((Get-SessionDirs).Count -eq 0)
    } 'discard closes tab and deletes session directory'
    Expect 'discard leaves doc1 source file untouched' ((Get-FileHash -LiteralPath $doc1 -Algorithm SHA256).Hash -eq $doc1Hash) 'doc1 hash changed after discard'

    # Clean exit leaves no chef-core process alive
    Send 'quit' | Out-Null
    if (-not $proc.WaitForExit(5000)) { throw 'chef-app did not exit cleanly after quit' }
    $exitDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $liveCore = @($trackedCorePids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if ($liveCore.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $exitDeadline)
    Expect 'quit leaves zero chef-core processes' ($liveCore.Count -eq 0) ("remaining core PIDs: $($liveCore -join ',')")

    # Native window close (WM_CLOSE): clean-with-session tab (winA) + dirty tab (winB) -> cancel -> save
    Start-CloseApp @($winA, $winB) 2
    # Start-CloseApp focuses the last argv tab (winB); switch to winA, make a clean session, then edit winB.
    Send 'action tabprev' | Out-Null
    WaitFor {
        $s = State
        $tab = $s.tabs | Where-Object { $_.active } | Select-Object -First 1
        return ($tab -and $tab.title -eq 'win-a.pdf')
    } 'activate winA'
    Send 'action rotatepage' | Out-Null
    WaitFor {
        $s = State
        $tab = $s.tabs | Where-Object { $_.active } | Select-Object -First 1
        return ($tab -and $tab.dirty -and (Get-SessionDirs).Count -eq 1)
    } 'winA becomes dirty'
    Send 'action saveedit' | Out-Null
    WaitFor {
        $s = State
        $tab = $s.tabs | Where-Object { $_.active } | Select-Object -First 1
        return ($tab -and (-not $tab.dirty) -and (Get-SessionDirs).Count -eq 1)
    } 'winA becomes clean while keeping live session directory'

    Send 'action tabnext' | Out-Null
    WaitFor {
        $s = State
        $tab = $s.tabs | Where-Object { $_.active } | Select-Object -First 1
        return ($tab -and $tab.title -eq 'win-b.pdf')
    } 'activate winB'
    Send 'action rotatepage' | Out-Null
    WaitFor {
        $s = State
        $tab = $s.tabs | Where-Object { $_.active } | Select-Object -First 1
        return ($tab -and $tab.dirty -and (Get-SessionDirs).Count -eq 2)
    } 'winB becomes dirty with two active session dirs'
    $winACorePids = @(Get-CoreProcesses $proc.Id | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)

    Send 'closewindow' | Out-Null
    WaitFor {
        $s = State
        return ($s.closePrompt.open -eq $true -and $s.closePrompt.windowClosing -eq $true)
    } 'WM_CLOSE opens unsaved close prompt with windowClosing=true'
    $promptState = (State).closePrompt
    Expect 'WM_CLOSE does not exit process while dirty tab open' (-not $proc.HasExited) 'process exited unexpectedly'
    Expect 'WM_CLOSE prompts for dirty win-b.pdf' ($promptState.name -eq 'win-b.pdf') ("prompted for $($promptState.name)")

    Click-Control 'close-prompt-cancel'
    WaitFor {
        $s = State
        return (-not $s.closePrompt.open -and -not $s.closePrompt.windowClosing)
    } 'cancel clears prompt and aborts window closing'
    $afterCancel = State
    Expect 'WM_CLOSE cancel keeps both tabs open' ($afterCancel.tabs.Count -eq 2) ("tabs=$($afterCancel.tabs.Count)")
    Expect 'WM_CLOSE cancel keeps both session dirs' ((Get-SessionDirs).Count -eq 2) ("sessionDirs=$((Get-SessionDirs).Count)")

    Send 'closewindow' | Out-Null
    WaitFor { (State).closePrompt.open -eq $true } 'WM_CLOSE reopens close prompt for save-and-exit'
    Click-Control 'close-prompt-save'
    Assert-CleanShutdown $winACorePids 'WM_CLOSE save-and-exit'
    Expect 'WM_CLOSE save-and-exit saved rotation to winB' ((Get-PdfRotation $winB) -eq '90') 'winB rotation not saved'

    # Native window close (WM_CLOSE): single dirty tab (winC) -> discard -> clean exit
    Start-CloseApp @($winC) 1
    Send 'action rotatepage' | Out-Null
    WaitFor {
        $s = State
        $tab = $s.tabs | Where-Object { $_.active } | Select-Object -First 1
        return ($tab -and $tab.dirty -and (Get-SessionDirs).Count -eq 1)
    } 'winC becomes dirty with active session'
    $winCCorePids = @(Get-CoreProcesses $proc.Id | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)

    Send 'closewindow' | Out-Null
    WaitFor {
        $s = State
        return ($s.closePrompt.open -eq $true -and $s.closePrompt.windowClosing -eq $true)
    } 'WM_CLOSE opens prompt for winC discard'
    Click-Control 'close-prompt-discard'
    Assert-CleanShutdown $winCCorePids 'WM_CLOSE discard-and-exit'
    Expect 'WM_CLOSE discard leaves winC untouched' ((Get-FileHash -LiteralPath $winC -Algorithm SHA256).Hash -eq $winCHash) 'winC hash changed after discard'

    if ($script:fails -gt 0) { throw "R3.14 close E2E failed with $($script:fails) failure(s)" }
    $passed = $true
} finally {
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Restore-Env 'CHEF_E2E_SAVE_AS_PATH' $oldSaveAs
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
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
