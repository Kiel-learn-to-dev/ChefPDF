#requires -Version 7.0
<#
.SYNOPSIS
  R4.08 E2E: side-by-side viewing of two files or two positions in one file under a shared cache budget.
.DESCRIPTION
  Windows only. Runs off-screen through the authenticated debug pipe and does not awaken chef-core.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-split-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$docA = Join-Path $work 'docA.pdf'
$docB = Join-Path $work 'docB.pdf'
$log = Join-Path $work 'app.log'
$proc = $null
$passed = $false
$script:fails = 0
$script:pipe = $null
$script:token = $null

$oldE2E = $env:CHEF_E2E
$oldUserData = $env:CHEF_USER_DATA_DIR
$oldSaveAs = $env:CHEF_E2E_SAVE_AS_PATH
$oldBudget = $env:CHEF_E2E_CACHE_BUDGET_BYTES

function Restore-Env([string]$Name, [AllowNull()][string]$Value) {
    if ($null -eq $Value) { Remove-Item "Env:$Name" -ErrorAction SilentlyContinue }
    else { Set-Item "Env:$Name" $Value }
}

function Expect([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) {
        Write-Output "PASS $Name"
    } else {
        $script:fails++
        Write-Output "FAIL $Name -- $Detail"
    }
}

function Send([string]$Command) {
    $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $script:pipe, [System.IO.Pipes.PipeDirection]::InOut)
    try {
        $client.Connect(5000)
        $writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false))
        $writer.AutoFlush = $true
        $reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false))
        $writer.WriteLine("$script:token $Command")
        $line = $reader.ReadLine()
        if (-not $line -and $Command -eq 'quit') { return $null }
        if (-not $line) { throw "No response to '$Command'." }
        $response = $line | ConvertFrom-Json
        if ($response.PSObject.Properties['ok'] -and $response.ok -eq $false) {
            throw "Debug command failed: $Command -- $($response.error)"
        }
        return $line
    } finally { $client.Dispose() }
}

function State() { return (Send 'state' | ConvertFrom-Json) }

function Control([string]$Id) {
    return (State).controls.controls | Where-Object id -eq $Id | Select-Object -First 1
}

function WaitFor([scriptblock]$Predicate, [string]$What, [int]$Seconds = 45) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($proc -and $proc.HasExited) {
            throw "chef-app exited ($($proc.ExitCode)) waiting for $What. $(Get-Content $log -Raw -ErrorAction SilentlyContinue)"
        }
        if (& $Predicate) { return }
        Start-Sleep -Milliseconds 120
    }
    $snapshot = if ($script:pipe -and $script:token) { Send 'state' } else { 'state unavailable' }
    throw "Timed out waiting for $What. $snapshot"
}

function Click-Control([string]$Id) {
    $script:targetControl = $null
    $script:targetSnapshot = $null
    WaitFor {
        $snap = State
        $c = $snap.controls.controls | Where-Object { $_.id -eq $Id -and $null -ne $_.bounds -and (-not $_.disabled) } | Select-Object -First 1
        if ($null -ne $c) {
            $script:targetSnapshot = $snap
            $script:targetControl = $c
            return $true
        }
        return $false
    } "clickable bounds for $Id" 15
    $snapshot = $script:targetSnapshot
    $control = $script:targetControl
    $scale = [double]$snapshot.controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $scale)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $scale)
    Send "click $x $y" | Out-Null
    Start-Sleep -Milliseconds 120
}

function Set-SplitPage([string]$PageNumber) {
    Click-Control 'split-page-input'
    WaitFor { (Control 'split-page-input').focused } 'focus split-page-input' 10
    Send 'action selectall' | Out-Null
    Start-Sleep -Milliseconds 100
    Send 'action backspace' | Out-Null
    WaitFor { (Control 'split-page-input').value -eq '' } 'clear split-page-input' 10
    Send "char $PageNumber" | Out-Null
    WaitFor { (Control 'split-page-input').value -eq $PageNumber } "type $PageNumber into split-page-input" 10
    Send 'action submit' | Out-Null
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

function Start-SplitApp([string[]]$Paths, [string]$UserDataSubdir, [AllowNull()][string]$BudgetBytes) {
    $subData = Join-Path $dataDir $UserDataSubdir
    $subLog = Join-Path $work ("app-$UserDataSubdir.log")
    New-Item -ItemType Directory -Force -Path $subData | Out-Null
    $script:log = $subLog
    $script:pipe = $null
    $script:token = $null

    $env:CHEF_E2E = '1'
    $env:CHEF_USER_DATA_DIR = $subData
    $env:CHEF_E2E_SAVE_AS_PATH = $null
    $env:CHEF_E2E_CACHE_BUDGET_BYTES = $BudgetBytes
    $arguments = ($Paths | ForEach-Object { '"' + $_ + '"' }) -join ' '
    try {
        $script:proc = Start-Process -FilePath $Exe -ArgumentList $arguments -PassThru -RedirectStandardError $subLog -WindowStyle Hidden
    } finally {
        Restore-Env 'CHEF_E2E' $oldE2E
        Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
        Restore-Env 'CHEF_E2E_SAVE_AS_PATH' $oldSaveAs
        Restore-Env 'CHEF_E2E_CACHE_BUDGET_BYTES' $oldBudget
    }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $subLog)) {
        if ($proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)) before log" }
        Start-Sleep -Milliseconds 100
    }
    while ((Get-Date) -lt $deadline -and (([string](Get-Content -LiteralPath $subLog -Raw -ErrorAction SilentlyContinue)) -notmatch 'CHEF_DEBUG_TOKEN=')) {
        if ($proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)): $(Get-Content -LiteralPath $subLog -Raw -ErrorAction SilentlyContinue)" }
        Start-Sleep -Milliseconds 150
    }
    $logText = Get-Content -LiteralPath $subLog -Raw
    $script:pipe = [regex]::Match($logText, 'chef-native-\d+').Value
    $script:token = [regex]::Match($logText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    if (-not $script:pipe -or -not $script:token) { throw "debug pipe/token missing from $subLog" }
}

function Stop-SplitApp([string]$Label) {
    Send 'quit' | Out-Null
    if (-not $proc.WaitForExit(5000)) { throw "${Label}: chef-app did not exit after quit" }
    $script:proc = $null
}

$fixturePy = @'
import pikepdf, sys

def make_pdf(path: str, prefix: str, pages: int) -> None:
    pdf = pikepdf.new()
    font = pikepdf.Dictionary(
        Type=pikepdf.Name.Font,
        Subtype=pikepdf.Name.Type1,
        BaseFont=pikepdf.Name.Helvetica,
    )
    for idx in range(pages):
        page = pdf.add_blank_page(page_size=(595, 842))
        page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
        text = f"{prefix} Page {idx + 1} of {pages}".encode("ascii")
        stream = b"BT /F1 24 Tf 72 720 Td (" + text + b") Tj ET\n0.2 0.4 0.8 rg 72 520 220 120 re f"
        page.Contents = pdf.make_stream(stream)
    pdf.save(path)
    pdf.close()

make_pdf(sys.argv[1], "DocA", 8)
make_pdf(sys.argv[2], "DocB", 6)
'@

try {
    New-Item -ItemType Directory -Force -Path $work, $dataDir | Out-Null
    Push-Location (Join-Path $repo 'core')
    try {
        & uv run --no-project python -c $fixturePy $docA $docB
        if ($LASTEXITCODE -ne 0) { throw 'fixture generation failed' }
    } finally { Pop-Location }

    # Pass 1: default cache budget (256 MB)
    Start-SplitApp @($docA, $docB) 'pass1' $null
    WaitFor { $s = State; $s.tabs.Count -eq 2 -and $s.tabs[1].active -and $s.cached -gt 0 -and $s.pending -eq 0 } 'initial tabs ready'
    $docATabId = [int](State).tabs[0].id
    Click-Control "doc-tab-$docATabId"
    WaitFor { $s = State; $s.tabs[0].active -and $s.view.pageCount -eq 8 -and $s.cached -gt 0 -and $s.pending -eq 0 } 'docA active'

    $coreAtOpen = @(Get-CoreProcesses $proc.Id)
    Expect 'view-only keeps zero chef-core processes before split' ($coreAtOpen.Count -eq 0) "core count=$($coreAtOpen.Count)"

    Click-Control 'split-toggle'
    WaitFor { $s = State; $s.split.open -eq $true -and $s.split.pageCount -eq 8 -and $s.split.cachedPages -gt 0 -and $s.split.pending -eq 0 } 'split opens on docA'

    # Same file, two independent positions
    Set-SplitPage '4'
    WaitFor { $s = State; $s.split.firstPage -eq 3 -and $s.split.scrollY -gt 0 -and $s.split.pending -eq 0 } 'right pane jumps to page 4'
    $sAfterJump = State
    $rightScrollPage4 = [double]$sAfterJump.split.scrollY
    Expect 'right pane jump leaves left pane at page 1' ($sAfterJump.view.firstPage -eq 0 -and [math]::Abs([double]$sAfterJump.view.scrollY) -lt 0.5) "left page=$($sAfterJump.view.firstPage) scrollY=$($sAfterJump.view.scrollY)"

    Send 'scrollscreens 2' | Out-Null
    WaitFor { $s = State; (-not $s.scrollProgress.active) -and $s.view.scrollY -gt 0 -and $s.pending -eq 0 } 'left pane scrolls independently'
    $sAfterLeftScroll = State
    $leftScroll = [double]$sAfterLeftScroll.view.scrollY
    $leftPage = [int]$sAfterLeftScroll.view.firstPage
    Expect 'left pane scrolled past page 1 while right stayed at page 4' ($leftPage -gt 0 -and $sAfterLeftScroll.split.firstPage -eq 3 -and [math]::Abs([double]$sAfterLeftScroll.split.scrollY - $rightScrollPage4) -lt 0.5) "leftPage=$leftPage rightPage=$($sAfterLeftScroll.split.firstPage)"

    Send 'scrollsplit 1' | Out-Null
    WaitFor { $s = State; $s.split.scrollY -gt ($rightScrollPage4 + 10) -and $s.split.pending -eq 0 } 'right pane scrolls independently'
    $sAfterRightScroll = State
    Expect 'right pane scroll leaves left pane untouched' ($sAfterRightScroll.view.firstPage -eq $leftPage -and [math]::Abs([double]$sAfterRightScroll.view.scrollY - $leftScroll) -lt 0.5) "leftScroll=$($sAfterRightScroll.view.scrollY) expected=$leftScroll"

    # Two different files
    Click-Control 'split-doc-select'
    Click-Control 'split-doc-select-opt-1'
    WaitFor { $s = State; $s.split.title -eq 'docB.pdf' -and $s.split.pageCount -eq 6 -and $s.split.cachedPages -gt 0 -and $s.split.pending -eq 0 } 'right pane switches to docB'
    Set-SplitPage '3'
    WaitFor { $s = State; $s.split.firstPage -eq 2 -and $s.split.pending -eq 0 } 'right pane navigates docB to page 3'
    $sDiffFiles = State
    Expect 'left pane stays on docA when right pane navigates docB' ($sDiffFiles.view.pageCount -eq 8 -and $sDiffFiles.view.firstPage -eq $leftPage -and [math]::Abs([double]$sDiffFiles.view.scrollY - $leftScroll) -lt 0.5) "leftCount=$($sDiffFiles.view.pageCount) rightTitle=$($sDiffFiles.split.title)"

    # Shared cache invariant
    Expect 'shared cache stays within default budget' ($sDiffFiles.split.sharedCacheBytes -le $sDiffFiles.split.sharedCacheBudget) "bytes=$($sDiffFiles.split.sharedCacheBytes) budget=$($sDiffFiles.split.sharedCacheBudget)"
    Expect 'shared cache total pages equals left plus right cached pages' ($sDiffFiles.split.sharedCachePages -eq ($sDiffFiles.cached + $sDiffFiles.split.cachedPages)) "shared=$($sDiffFiles.split.sharedCachePages) left=$($sDiffFiles.cached) right=$($sDiffFiles.split.cachedPages)"
    $onePageBytes = [math]::Ceiling([double]$sDiffFiles.split.cachedBytes / [math]::Max(1, [int]$sDiffFiles.split.cachedPages))

    # Closing right pane keeps left pane untouched
    Click-Control 'split-close'
    WaitFor { $s = State; (-not $s.split.open) -and $s.split.cachedPages -eq 0 -and $s.split.sharedCachePages -eq $s.cached } 'closing right pane evicts only right cache'
    $sAfterCloseRight = State
    Expect 'closing right pane preserves left pane position and cache' ($sAfterCloseRight.view.pageCount -eq 8 -and $sAfterCloseRight.view.firstPage -eq $leftPage -and $sAfterCloseRight.cached -gt 0) "leftPage=$($sAfterCloseRight.view.firstPage) cached=$($sAfterCloseRight.cached)"

    # Closing left tab keeps right pane showing docB at its position
    Click-Control 'split-toggle'
    WaitFor { $s = State; $s.split.open -eq $true } 'reopen split'
    Click-Control 'split-doc-select'
    Click-Control 'split-doc-select-opt-1'
    WaitFor { $s = State; $s.split.title -eq 'docB.pdf' -and $s.split.pageCount -eq 6 -and $s.split.pending -eq 0 } 'right pane selects docB again'
    Set-SplitPage '4'
    WaitFor { $s = State; $s.split.firstPage -eq 3 -and $s.split.scrollY -gt 0 -and $s.split.pending -eq 0 } 'right pane jumps docB to page 4'
    $rightDocBScroll = [double](State).split.scrollY

    Send 'action closetab' | Out-Null
    WaitFor { $s = State; $s.tabs.Count -eq 1 -and $s.tabs[0].title -eq 'docB.pdf' -and $s.tabs[0].active } 'left docA tab closes'
    $sAfterCloseLeft = State
    Expect 'closing left tab keeps right pane on docB page 4' ($sAfterCloseLeft.split.open -eq $true -and $sAfterCloseLeft.split.title -eq 'docB.pdf' -and $sAfterCloseLeft.split.firstPage -eq 3 -and [math]::Abs([double]$sAfterCloseLeft.split.scrollY - $rightDocBScroll) -lt 0.5) "splitTitle=$($sAfterCloseLeft.split.title) splitPage=$($sAfterCloseLeft.split.firstPage)"

    $coreEndPass1 = @(Get-CoreProcesses $proc.Id)
    Expect 'side-by-side viewing never launches chef-core' ($coreEndPass1.Count -eq 0) "core count=$($coreEndPass1.Count)"
    Stop-SplitApp 'pass1'

    # Pass 2: tight shared cache budget (R1.33)
    $tightBudget = [int]([math]::Max(1500000, [math]::Ceiling($onePageBytes * 3.5)))
    Start-SplitApp @($docA) 'pass2' ([string]$tightBudget)
    WaitFor { $s = State; $s.tabs.Count -eq 1 -and $s.view.pageCount -eq 8 -and $s.cached -gt 0 -and $s.pending -eq 0 } 'pass2 docA ready'
    Click-Control 'split-toggle'
    WaitFor { $s = State; $s.split.open -eq $true -and $s.split.cachedPages -gt 0 -and $s.split.pending -eq 0 } 'pass2 split ready'

    foreach ($step in 1..2) {
        Send 'scrollscreens 2' | Out-Null
        WaitFor { $s = State; -not $s.scrollProgress.active } "pass2 left scroll $step"
        Send 'scrollsplit 2' | Out-Null
        Start-Sleep -Milliseconds 250
    }
    WaitFor { $s = State; $s.pending -eq 0 -and $s.split.pending -eq 0 } 'pass2 settles with no pending renders'
    Start-Sleep -Milliseconds 300
    $sTight = State
    Expect 'tight budget propagates to shared cache' ($sTight.split.sharedCacheBudget -eq $tightBudget) "got=$($sTight.split.sharedCacheBudget) expected=$tightBudget"
    Expect 'tight shared cache stays within byte budget' ($sTight.split.sharedCacheBytes -le $tightBudget) "bytes=$($sTight.split.sharedCacheBytes) budget=$tightBudget"
    Expect 'both panes keep visible pages under tight budget without thrashing' ($sTight.cached -ge 1 -and $sTight.split.cachedPages -ge 1 -and $sTight.pending -eq 0 -and $sTight.split.pending -eq 0) "left=$($sTight.cached) right=$($sTight.split.cachedPages) pending=$($sTight.pending)/$($sTight.split.pending)"

    Stop-SplitApp 'pass2'

    Write-Output "FAILS: $script:fails"
    if ($script:fails -gt 0) { exit 1 }
    $passed = $true
    exit 0
} finally {
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Restore-Env 'CHEF_E2E_SAVE_AS_PATH' $oldSaveAs
    Restore-Env 'CHEF_E2E_CACHE_BUDGET_BYTES' $oldBudget
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        if (-not $proc.WaitForExit(5000)) { Write-Warning "chef-app $($proc.Id) did not exit during cleanup." }
    }
    if ($passed) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    else { Write-Warning "E2E artifacts retained for diagnosis: $work" }
}
