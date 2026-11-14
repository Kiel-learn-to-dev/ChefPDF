<#
.SYNOPSIS
  Native M3 operation/action slice: page.rotate -> revision file -> undo/redo -> Save As -> reopen.
.DESCRIPTION
  Requires Windows, chef-app.exe, core/.venv and pdfium.dll. Drives the app through its authenticated
  debug pipe and OS keyboard input. CHEF_E2E_SAVE_AS_PATH supplies a deterministic Save As target. It mutates
  the opened source PDF externally, checks the warning appears before session creation, then uses the
  Reopen control and continues the scroll/zoom/search/selection + rotate/undo/redo/Save As/reopen flow.
  It records page-to-image IDs and the exact changedPages eviction snapshot, exercises both source-warning
  choices, and sends physical Ctrl+Z/Ctrl+Y. Save failures and owner-password warnings remain unverified.
#>
param([string]$Exe)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path $Exe)) { throw "chef-app.exe not found: $Exe" }
$work = Join-Path $env:TEMP ('chef-native-m3-' + [guid]::NewGuid().ToString('N'))
$source = Join-Path $work 'source.pdf'
$saved = Join-Path $work 'saved-as.pdf'
$previousE2E = $env:CHEF_E2E
$previousUserDataDir = $env:CHEF_USER_DATA_DIR
$previousSaveAsPath = $env:CHEF_E2E_SAVE_AS_PATH
$fixture = @'
import sys
from reportlab.pdfgen import canvas
c = canvas.Canvas(sys.argv[1], pagesize=(612, 792))
for page in range(1, 3):
    c.setFont("Helvetica-Bold", 18)
    c.drawString(72, 740, f"CHEF-M3-ANCHOR page {page}")
    c.setFont("Helvetica", 12)
    for line in range(1, 25):
        c.drawString(72, 700 - line * 24, f"Stable searchable line {line} page {page}")
    c.showPage()
c.save()
'@

$dataDir = Join-Path $work 'userdata'
$log = Join-Path $work 'app.log'
$script:pipe = $null
$script:token = $null
function Send([string]$command) {
    $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $script:pipe, [System.IO.Pipes.PipeDirection]::InOut)
    $client.Connect(5000)
    try {
        $writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false)); $writer.AutoFlush = $true
        $reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false))
        $writer.WriteLine("$script:token $command"); return $reader.ReadLine()
    } finally { $client.Dispose() }
}
function State() { return (Send 'state' | ConvertFrom-Json) }
function ControlDisabled($snapshot, [string]$id) {
    $control = $snapshot.controls.controls | Where-Object { $_.id -eq $id } | Select-Object -First 1
    if ($null -eq $control) { return $null }
    return [bool]$control.disabled
}
function TabDirty($snapshot) {
    $tab = $snapshot.tabs | Where-Object { $_.active } | Select-Object -First 1
    if ($null -eq $tab) { return $null }
    return [bool]$tab.dirty
}
function ClickControl([string]$id) {
    $snapshot = State
    $control = $snapshot.controls.controls | Where-Object { $_.id -eq $id } | Select-Object -First 1
    if ($null -eq $control) { throw "control not found: $id" }
    $scale = [double]$snapshot.controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $scale)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $scale)
    Send "mouse move $x $y" | Out-Null; Start-Sleep -Milliseconds 60
    Send "mouse down $x $y" | Out-Null; Start-Sleep -Milliseconds 40
    Send "mouse up $x $y" | Out-Null
}
function WaitFor([scriptblock]$predicate, [string]$what, [int]$Seconds = 45) {
    $end = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $end) {
        $activeProcess = if ($null -ne $reopen) { $reopen } else { $proc }
        if ($activeProcess -and $activeProcess.HasExited) {
            throw "chef-app exited ($($activeProcess.ExitCode)) while waiting for $what. See $work"
        }
        if (& $predicate) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "Timed out waiting for $what"
}
if (-not ('ChefM3WindowInput' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ChefM3WindowInput {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
}
function FocusViewerCanvas() {
    $snapshot = State
    $hwnd = [IntPtr]::new([long]$snapshot.hwnd)
    [void][ChefM3WindowInput]::ShowWindow($hwnd, 9) # SW_RESTORE
    [void][ChefM3WindowInput]::SetWindowPos($hwnd, [IntPtr]::Zero, 100, 100, 1280, 900, 0x0040) # SWP_SHOWWINDOW
    Start-Sleep -Milliseconds 250
    [void][ChefM3WindowInput]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 150
    WaitFor { (State).foreground } 'viewer window foreground for physical key input'
    $snapshot = State
    $x = [int]($snapshot.rect.left + ($snapshot.rect.right - $snapshot.rect.left) * 0.58)
    $y = [int]($snapshot.rect.top + ($snapshot.rect.bottom - $snapshot.rect.top) * 0.55)
    [void][ChefM3WindowInput]::SetCursorPos($x, $y)
    [ChefM3WindowInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero) # LEFTDOWN
    [ChefM3WindowInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) # LEFTUP
    Start-Sleep -Milliseconds 100
}
function Send-ControlKey([byte]$key) {
    [ChefM3WindowInput]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero) # CTRL down
    [ChefM3WindowInput]::keybd_event($key, 0, 0, [UIntPtr]::Zero)
    [ChefM3WindowInput]::keybd_event($key, 0, 2, [UIntPtr]::Zero) # key up
    [ChefM3WindowInput]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero) # CTRL up
}
function PdfRotation([string]$path) {
    Push-Location (Join-Path $repo 'core')
    try { return (& uv run --no-project python -c 'import pikepdf,sys; print(int(pikepdf.Pdf.open(sys.argv[1]).pages[0].get("/Rotate",0)))' $path).Trim() }
    finally { Pop-Location }
}
function PdfPages([string]$path) {
    Push-Location (Join-Path $repo 'core')
    try { return (& uv run --no-project python -c 'import pikepdf,sys; print(len(pikepdf.Pdf.open(sys.argv[1]).pages))' $path).Trim() }
    finally { Pop-Location }
}

$reopen = $null
$passed = $false
try {
    New-Item -ItemType Directory -Force $work | Out-Null
    Push-Location (Join-Path $repo 'core')
    try { & uv run --no-project python -c $fixture $source; if ($LASTEXITCODE) { throw 'fixture generation failed' } }
    finally { Pop-Location }

    $env:CHEF_USER_DATA_DIR = $dataDir
    $env:CHEF_E2E = '1'
    $env:CHEF_E2E_SAVE_AS_PATH = $saved
    try {
        $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $source + '"') -PassThru `
            -RedirectStandardError $log -WindowStyle Hidden
    }
    finally {
        $env:CHEF_E2E = $previousE2E
        $env:CHEF_USER_DATA_DIR = $previousUserDataDir
        $env:CHEF_E2E_SAVE_AS_PATH = $previousSaveAsPath
    }
    WaitFor {
        if (-not (Test-Path -LiteralPath $log)) { return $false }
        $logText = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
        $script:pipe = [regex]::Match($logText, 'chef-native-\d+').Value
        $script:token = [regex]::Match($logText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
        if (-not $script:pipe -or -not $script:token) { return $false }
        try { return $null -ne (State).view } catch { return $false }
    } 'initial viewer ready before mutating source' 60
    $initialState = State
    if ($initialState.settings.language -ne 'vi') {
        throw "R3.04 warning E2E requires Vietnamese locale, got [$($initialState.settings.language)]"
    }

    # The 2-page source becomes 3 pages after an external edit. Both warning choices must leave
    # the document untouched until Reopen adopts the changed source.
    Push-Location (Join-Path $repo 'core')
    try {
        & uv run --no-project python -c 'import os,pikepdf,sys; src=sys.argv[1]; tmp=src+".mutated.pdf"; p=pikepdf.Pdf.open(src); p.add_blank_page(page_size=(612,792)); p.save(tmp); p.close(); os.replace(tmp,src)' $source
        if ($LASTEXITCODE) { throw 'source mutation fixture failed' }
    }
    finally { Pop-Location }
    if ((PdfPages $source) -ne '3') { throw 'source mutation fixture should contain exactly three pages' }
    Send 'action rotatepage' | Out-Null
    WaitFor { $s = State; $null -ne ($s.controls.controls | Where-Object { $_.id -eq 'source-warning-reopen' }) } 'source-change warning'
    $warningControls = (State).controls.controls
    $reviewControl = $warningControls | Where-Object { $_.id -eq 'source-warning-review' } | Select-Object -First 1
    $reopenControl = $warningControls | Where-Object { $_.id -eq 'source-warning-reopen' } | Select-Object -First 1
    if ($reviewControl.name -ne 'Xem lại' -or $reopenControl.name -ne 'Mở lại') {
        throw "R3.04 source warning actions are not Vietnamese: review=[$($reviewControl.name)] reopen=[$($reopenControl.name)]"
    }
    $warningText = (State).sourceWarning
    if ($warningText.title -ne 'File gốc đã thay đổi' -or
        $warningText.body -notlike '*đã được sửa hoặc thay thế bên ngoài Chef PDF*' -or
        $warningText.body -notlike '*chưa tạo phiên làm việc*') {
        throw "R3.04 source warning text is not the expected Vietnamese copy: $($warningText | ConvertTo-Json -Compress)"
    }
    $sessionRoot = Join-Path $dataDir 'sessions'
    $sessionMetadata = @(Get-ChildItem $sessionRoot -Filter 'meta.json' -Recurse -ErrorAction SilentlyContinue)
    $sessionRevisions = @(Get-ChildItem $sessionRoot -Filter 'rev-*.pdf' -Recurse -ErrorAction SilentlyContinue)
    if ($sessionMetadata.Count -ne 0 -or $sessionRevisions.Count -ne 0) {
        throw 'source-change warning was shown after session metadata or a revision had already been created'
    }
    ClickControl 'source-warning-review'
    WaitFor { $s = State; $null -eq ($s.controls.controls | Where-Object { $_.id -eq 'source-warning-review' }) } 'Review dismisses source-change warning'
    $sessionMetadata = @(Get-ChildItem $sessionRoot -Filter 'meta.json' -Recurse -ErrorAction SilentlyContinue)
    $sessionRevisions = @(Get-ChildItem $sessionRoot -Filter 'rev-*.pdf' -Recurse -ErrorAction SilentlyContinue)
    if ($sessionMetadata.Count -ne 0 -or $sessionRevisions.Count -ne 0) { throw 'Review created a session or revision' }
    Send 'action rotatepage' | Out-Null
    WaitFor { $s = State; $null -ne ($s.controls.controls | Where-Object { $_.id -eq 'source-warning-reopen' }) } 'source warning returns after Review'
    $sessionMetadata = @(Get-ChildItem $sessionRoot -Filter 'meta.json' -Recurse -ErrorAction SilentlyContinue)
    $sessionRevisions = @(Get-ChildItem $sessionRoot -Filter 'rev-*.pdf' -Recurse -ErrorAction SilentlyContinue)
    if ($sessionMetadata.Count -ne 0 -or $sessionRevisions.Count -ne 0) { throw 'second source-change warning arrived after creating a session or revision' }
    ClickControl 'source-warning-reopen'
    WaitFor { $s = State; ($null -ne $s.view) -and ($null -eq ($s.controls.controls | Where-Object { $_.id -eq 'source-warning-reopen' })) } 'reopen of changed source'

    # Establish measurable viewer state and a clipboard copy of the page selection before reload.
    Send 'action zoomin' | Out-Null
    WaitFor { $s = State; (-not $s.view.fitWidth) -and ($s.view.zoom -gt 1.01) } 'zoom outside fit-width'
    Send 'scrollscreens 0.2' | Out-Null
    WaitFor { $s = State; $s.view.scrollY -gt 1 -and $s.view.firstPage -eq 0 } 'nonzero scroll on page zero'
    Send 'action focussearch' | Out-Null
    WaitFor { $s = State; $null -ne $s.input -and $s.input.focused } 'search field owns focus before typing'
    Send 'char CHEF-M3-ANCHOR' | Out-Null
    WaitFor { $s = State; $s.find.query -eq 'CHEF-M3-ANCHOR' -and $s.find.total -gt 0 -and (-not $s.find.scanning) } 'search result before reload'
    Send 'action selectalltext' | Out-Null
    Start-Sleep -Milliseconds 150
    Set-Clipboard -Value 'CHEF-M3-CLIPBOARD-SENTINEL-BEFORE'
    Send 'action copyselection' | Out-Null
    WaitFor { (Get-Clipboard -Raw).Contains('CHEF-M3-ANCHOR') } 'selected text copied before revision'
    $selectionBefore = Get-Clipboard -Raw
    if (-not $selectionBefore.Contains('CHEF-M3-ANCHOR')) { throw 'could not select/copy the text-bearing first page before revision reload' }
    $before = State
    $beforeZoom = [double]$before.view.zoom
    $beforeScrollFraction = [double]$before.view.scrollY / (792.0 * $beforeZoom)
    $beforeFirstPage = [int]$before.view.firstPage
    $beforeFindTotal = [int]$before.find.total
    $beforeCacheCount = [int]$before.cached
    if ($beforeFirstPage -ne 0 -or $before.view.scrollY -le 1) { throw 'pre-reload view lost the intended page-zero scroll anchor' }
    WaitFor {
        $s = State
        $pageNames = @($s.cachedPageImages.PSObject.Properties.Name)
        $pageNames -contains '0' -and $pageNames -contains '1' -and [int]$s.pending -eq 0
    } 'full-size images for changed page 0 and unchanged page 1 before revision'
    $before = State
    $beforeCacheCount = [int]$before.cached
    $beforeCacheIds = @{}
    foreach ($property in $before.cachedPageImages.PSObject.Properties) {
        $beforeCacheIds[[int]$property.Name] = [long]$property.Value
    }
    if (-not $beforeCacheIds.ContainsKey(0) -or -not $beforeCacheIds.ContainsKey(1)) {
        throw 'pre-revision cache snapshot does not contain page 0 and page 1'
    }

    Send 'action rotatepage' | Out-Null
    WaitFor { (Get-ChildItem (Join-Path $dataDir 'sessions') -Filter 'rev-0001.pdf' -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0 } 'first revision from page.rotate'
    $revision = Get-ChildItem (Join-Path $dataDir 'sessions') -Filter 'rev-0001.pdf' -Recurse | Select-Object -First 1
    if ((PdfRotation $revision.FullName) -ne '90') { throw 'rotate did not persist /Rotate 90 in rev-0001.pdf' }
    WaitFor { $s = State; (ControlDisabled $s 'viewer-undo') -eq $false -and (ControlDisabled $s 'viewer-redo') -eq $true -and (TabDirty $s) -eq $true } 'viewer applies rotated revision and enables Undo'
    WaitFor { $s = State; $null -ne $s.cacheInvalidation -and @($s.cacheInvalidation.changedPages) -contains 0 } 'page.rotate cache invalidation audit'
    $invalidation = (State).cacheInvalidation
    $changedPages = @($invalidation.changedPages | ForEach-Object { [int]$_ })
    if ($changedPages.Count -ne 1 -or $changedPages[0] -ne 0) {
        throw "expected page.rotate to report changedPages=[0], got [$($changedPages -join ',')]"
    }
    $expectedRemoved = @($invalidation.before.PSObject.Properties | Where-Object { $changedPages -contains [int]$_.Name } | ForEach-Object { [int]$_.Name } | Sort-Object)
    $actualRemoved = @($invalidation.removed.PSObject.Properties | ForEach-Object { [int]$_.Name } | Sort-Object)
    if (Compare-Object $expectedRemoved $actualRemoved) {
        throw "cache invalidation removed pages [$($actualRemoved -join ',')], expected exactly [$($expectedRemoved -join ',')]"
    }
    if ($invalidation.before.'0' -ne $beforeCacheIds[0] -or $invalidation.before.'1' -ne $beforeCacheIds[1]) {
        throw 'cache contents changed between the preflight snapshot and OperationResult::Applied'
    }
    if ($invalidation.removed.'0' -ne $beforeCacheIds[0]) { throw 'changed page 0 did not evict its original bitmap at revision apply' }
    if ($invalidation.removed.PSObject.Properties.Name -contains '1') { throw 'unchanged page 1 was evicted at revision apply' }
    if ((PdfPages $revision.FullName) -ne '3') { throw 'Reopen did not load the externally changed three-page source' }
    WaitFor {
        $s = State
        (-not $s.find.scanning) -and $s.find.query -eq 'CHEF-M3-ANCHOR' -and $s.find.total -eq $beforeFindTotal -and
        [math]::Abs([double]$s.view.zoom - $beforeZoom) -lt 0.02 -and $s.view.firstPage -eq $beforeFirstPage -and $s.view.scrollY -gt 1 -and
        [math]::Abs(([double]$s.view.scrollY / (612.0 * $beforeZoom)) - $beforeScrollFraction) -lt 0.02 -and
        $null -ne $s.cachedPageImages.PSObject.Properties['0'] -and $null -ne $s.cachedPageImages.PSObject.Properties['1'] -and
        [long]$s.cachedPageImages.'0' -ne $beforeCacheIds[0] -and [long]$s.cachedPageImages.'1' -eq $beforeCacheIds[1] -and [int]$s.pending -eq 0
    } 'scroll/zoom/search state and per-page cache identity after revision reload'
    Set-Clipboard -Value 'CHEF-M3-CLIPBOARD-SENTINEL-AFTER'
    Send 'action copyselection' | Out-Null
    WaitFor { (Get-Clipboard -Raw) -ne 'CHEF-M3-CLIPBOARD-SENTINEL-AFTER' } 'selected text copied after revision reload'
    $selectionAfter = Get-Clipboard -Raw
    if ($selectionAfter -cne $selectionBefore) { throw 'text selection content changed after revision reload' }
    $after = State
    Write-Output ("R3.06 view before/after: scrollY={0}/{1}, zoom={2}/{3}, firstPage={4}/{5}, cachedPages={6}/{7}" -f
        $before.view.scrollY, $after.view.scrollY, $beforeZoom, $after.view.zoom, $beforeFirstPage, $after.view.firstPage, $beforeCacheCount, $after.cached)
    Write-Output ("R3.06 cache images: before page0={0}, page1={1}; evicted={2}; after page0={3}, page1={4}" -f
        $beforeCacheIds[0], $beforeCacheIds[1], ($actualRemoved -join ','), $after.cachedPageImages.'0', $after.cachedPageImages.'1')

    FocusViewerCanvas
    Send-ControlKey 0x5A # Ctrl+Z
    WaitFor { $s = State; ((Get-Content (Join-Path $revision.DirectoryName 'meta.json') -Raw) -match '"revision"\s*:\s*0') -and (ControlDisabled $s 'viewer-undo') -eq $true -and (ControlDisabled $s 'viewer-redo') -eq $false -and (TabDirty $s) -eq $false } 'undo revision applied in core and viewer'
    $undoState = State
    if ($undoState.message) { throw "undo action reported an error: $($undoState.message)" }
    FocusViewerCanvas
    Send-ControlKey 0x59 # Ctrl+Y
    WaitFor { $s = State; ((Get-Content (Join-Path $revision.DirectoryName 'meta.json') -Raw) -match '"revision"\s*:\s*1') -and (ControlDisabled $s 'viewer-undo') -eq $false -and (ControlDisabled $s 'viewer-redo') -eq $true -and (TabDirty $s) -eq $true } 'redo revision applied in core and viewer'
    $redoState = State
    if ($redoState.message) { throw "redo action reported an error: $($redoState.message)" }

    Send 'action saveeditas' | Out-Null
    WaitFor { Test-Path $saved } 'Save As output'
    if ((PdfRotation $saved) -ne '90') { throw 'Save As PDF does not contain the rotated page' }
    if ((PdfRotation $source) -ne '0' -or (PdfPages $saved) -ne '3') { throw 'Save As changed the source or lost pages' }
    WaitFor { (TabDirty (State)) -eq $false } 'Save As clears the dirty state'

    # Save As changes the session source path. A second relative 90-degree rotation reaches 180;
    # physical Ctrl+S must atomically overwrite that Save As target and clear dirty state.
    Send 'action rotatepage' | Out-Null
    WaitFor { (Get-ChildItem (Join-Path $dataDir 'sessions') -Filter 'rev-0002.pdf' -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0 } 'second revision before Ctrl+S'
    WaitFor { (TabDirty (State)) -eq $true } 'second edit marks the tab dirty'
    FocusViewerCanvas
    Send-ControlKey 0x53 # Ctrl+S
    WaitFor { (TabDirty (State)) -eq $false } 'Ctrl+S clears dirty state after overwriting Save As target'
    if ((PdfRotation $saved) -ne '180' -or (PdfPages $saved) -ne '3') {
        throw 'Ctrl+S did not overwrite the Save As target with the second rotated revision'
    }
    if ((PdfRotation $source) -ne '0' -or (PdfPages $source) -ne '3') {
        throw 'Save or Save As changed the original source PDF'
    }
    Send 'quit' | Out-Null
    Start-Sleep -Milliseconds 500
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }

    # Reopen through native/pdfium and validate the authenticated viewer snapshot.
    $env:CHEF_USER_DATA_DIR = Join-Path $work 'reopen-userdata'
    $env:CHEF_E2E = '1'
    $env:CHEF_E2E_SAVE_AS_PATH = $null
    $reopenLog = Join-Path $work 'reopen.log'
    try { $reopen = Start-Process -FilePath $Exe -ArgumentList ('"' + $saved + '"') -PassThru -RedirectStandardError $reopenLog -WindowStyle Hidden }
    finally {
        $env:CHEF_E2E = $previousE2E
        $env:CHEF_USER_DATA_DIR = $previousUserDataDir
        $env:CHEF_E2E_SAVE_AS_PATH = $previousSaveAsPath
    }
    WaitFor { (Get-Content $reopenLog -Raw) -match 'CHEF_DEBUG_TOKEN=' } 'reopened viewer debug channel'
    $reopenText = Get-Content $reopenLog -Raw
    $script:pipe = [regex]::Match($reopenText, 'chef-native-\d+').Value
    $script:token = [regex]::Match($reopenText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    WaitFor { try { $snapshot = Send 'state' | ConvertFrom-Json; ($null -ne $snapshot.view) -and ($null -eq $snapshot.message) } catch { $false } } 'saved document loaded without an error'
    Stop-Process -Id $reopen.Id -Force
    Write-Output 'PASS source guard -> page.rotate/revision/cache -> physical Ctrl+Z/Y -> Save As -> physical Ctrl+S -> native reopen'
    $passed = $true
}
finally {
    $env:CHEF_E2E = $previousE2E; $env:CHEF_USER_DATA_DIR = $previousUserDataDir; $env:CHEF_E2E_SAVE_AS_PATH = $previousSaveAsPath
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    if ($reopen -and -not $reopen.HasExited) { Stop-Process -Id $reopen.Id -Force }
    if ($passed) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    else { Write-Warning "E2E artifacts retained for diagnosis: $work" }
}
