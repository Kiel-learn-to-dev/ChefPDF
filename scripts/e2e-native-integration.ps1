<#
.SYNOPSIS
  Native M3 operation/action slice: page.rotate -> revision file -> undo/redo -> Save As -> reopen.
.DESCRIPTION
  Requires Windows, chef-app.exe, core/.venv and pdfium.dll. Drives the app through its authenticated
  debug pipe; set CHEF_E2E_OS_INPUT=1 to opt into physical keyboard input. CHEF_E2E_SAVE_AS_PATH supplies a deterministic Save As target. It mutates
  the opened source PDF externally, checks the warning appears before session creation, then uses the
  Reopen control and continues the scroll/zoom/search/selection + rotate/undo/redo/Save As/reopen flow.
  It records page-to-image IDs and the exact changedPages eviction snapshot, exercises both source-warning
  choices, and exercises Ctrl+Z/Ctrl+Y/Ctrl+S (physical with OS input enabled). Native document properties verify the adopted source,
  each undo/redo revision and the reopened output. CHEF_E2E_IDLE_STOP_MS shortens the core idle timeout
  for the close-session/idle-stop/restart path. Failed saves and encrypted owner-password warnings
  are not exercised by this script.
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
$previousIdleStop = $env:CHEF_E2E_IDLE_STOP_MS
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
    if (-not $script:pipe -or -not $script:token) { throw 'debug pipe/token are not ready' }
    $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $script:pipe, [System.IO.Pipes.PipeDirection]::InOut)
    try {
        $client.Connect(5000)
        $writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false)); $writer.AutoFlush = $true
        $reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false))
        $writer.WriteLine("$script:token $command")
        $line = $reader.ReadLine()
        # quit terminates the server immediately and may close the pipe before writing a reply.
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
function CoreProcesses([int]$rootProcessId) {
    # chef-core can be behind the suspended Python launcher, so walk the complete child tree of this app.
    $processes = @(Get-CimInstance Win32_Process)
    $processIds = @([int]$rootProcessId)
    do {
        $children = @($processes | Where-Object { $processIds -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId })
        $newIds = @($children | Where-Object { $processIds -notcontains $_ } | Sort-Object -Unique)
        if ($newIds.Count) { $processIds += $newIds }
    } while ($newIds.Count)
    return @($processes | Where-Object {
        $processIds -contains [int]$_.ProcessId -and $_.CommandLine -match '(?i)(?:-m\s+chef_core|chef_core)'
    })
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
    if ($env:CHEF_E2E_OS_INPUT -ne '1') { return }
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
    if ($env:CHEF_E2E_OS_INPUT -ne '1') {
        switch ($key) {
            0x5A { Send 'action undoedit' | Out-Null; return }
            0x59 { Send 'action redoedit' | Out-Null; return }
            0x53 { Send 'action saveedit' | Out-Null; return }
            default { throw "unsupported non-OS Ctrl key: $key" }
        }
    }
    [ChefM3WindowInput]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero) # CTRL down
    [ChefM3WindowInput]::keybd_event($key, 0, 0, [UIntPtr]::Zero)
    [ChefM3WindowInput]::keybd_event($key, 0, 2, [UIntPtr]::Zero) # key up
    [ChefM3WindowInput]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero) # CTRL up
}
function PdfRotation([string]$path) {
    Push-Location (Join-Path $repo 'core')
    try {
        $rotation = & uv run --no-project python -c 'import pikepdf,sys; print(int(pikepdf.Pdf.open(sys.argv[1]).pages[0].get("/Rotate",0)))' $path
        if ($LASTEXITCODE -ne 0) { throw "pikepdf could not read rotation from $path" }
        return $rotation.Trim()
    }
    finally { Pop-Location }
}
function PdfPages([string]$path) {
    Push-Location (Join-Path $repo 'core')
    try {
        $pages = & uv run --no-project python -c 'import pikepdf,sys; print(len(pikepdf.Pdf.open(sys.argv[1]).pages))' $path
        if ($LASTEXITCODE -ne 0) { throw "pikepdf could not read page count from $path" }
        return $pages.Trim()
    }
    finally { Pop-Location }
}
function ViewerProperties([string]$fileName, [int]$pageCount) {
    Send 'action openproperties' | Out-Null
    WaitFor {
        $snapshot = State
        ($null -ne $snapshot.properties) -and ($null -ne ($snapshot.controls.controls |
            Where-Object { $_.id -eq 'properties-done' -and $null -ne $_.bounds }))
    } "native properties for $fileName"
    $properties = (State).properties
    if ($properties.fileName -cne $fileName -or [int]$properties.pageCount -ne $pageCount) {
        throw "native viewer loaded an unexpected document: $($properties | ConvertTo-Json -Compress)"
    }
    ClickControl 'properties-done'
    WaitFor { $null -eq (State).properties } 'native properties dialog closes'
    return $properties
}

$proc = $null
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
    $env:CHEF_E2E_IDLE_STOP_MS = '1500'
    try {
        $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $source + '"') -PassThru `
            -RedirectStandardError $log -WindowStyle Hidden
    }
    finally {
        $env:CHEF_E2E = $previousE2E
        $env:CHEF_USER_DATA_DIR = $previousUserDataDir
        $env:CHEF_E2E_SAVE_AS_PATH = $previousSaveAsPath
        $env:CHEF_E2E_IDLE_STOP_MS = $previousIdleStop
    }
    WaitFor {
        if (-not (Test-Path -LiteralPath $log)) { return $false }
        $logText = [string](Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue)
        $script:pipe = [regex]::Match($logText, 'chef-native-\d+').Value
        $script:token = [regex]::Match($logText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
        if (-not $script:pipe -or -not $script:token) { return $false }
        try { return $null -ne (State).view } catch { return $false }
    } 'initial viewer ready before mutating source' 60
    $initialState = State
    if ($initialState.settings.language -ne 'vi') {
        throw "R3.04 warning E2E requires Vietnamese locale, got [$($initialState.settings.language)]"
    }
    $initialProperties = ViewerProperties 'source.pdf' 2

    # The 2-page source becomes 3 pages after an external edit. Both warning choices must leave
    # the document untouched until Reopen adopts the changed source.
    Push-Location (Join-Path $repo 'core')
    try {
        & uv run --no-project python -c 'import os,pikepdf,sys; src=sys.argv[1]; tmp=src+".mutated.pdf"; p=pikepdf.Pdf.open(src); p.add_blank_page(page_size=(612,792)); p.save(tmp); p.close(); os.replace(tmp,src)' $source
        if ($LASTEXITCODE) { throw 'source mutation fixture failed' }
    }
    finally { Pop-Location }
    if ((PdfPages $source) -ne '3') { throw 'source mutation fixture should contain exactly three pages' }
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
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
    $sourceProperties = ViewerProperties 'source.pdf' 3
    if ($sourceProperties.pageSize -cne $initialProperties.pageSize) { throw 'Reopen changed the original first-page geometry' }

    # Establish measurable viewer state and a clipboard copy of the page selection before reload.
    # A real foreground window is needed for GPUI TextInput focus and clipboard behavior on Windows.
    FocusViewerCanvas
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
    Start-Sleep -Seconds 2
    if (@(CoreProcesses $proc.Id).Count -ne 0) {
        throw 'R3.03 lazy-core check failed: opening, scrolling, searching, or selecting a read-only PDF started chef-core'
    }
    Write-Output 'PASS opening, scrolling, searching, and selecting text does not start chef-core'
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
    if (@(CoreProcesses $proc.Id).Count -eq 0) {
        throw 'R3.03 first edit created a revision without a chef-core process in the app process tree'
    }
    $startedCorePids = @(CoreProcesses $proc.Id | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)
    Write-Output 'PASS first edit starts chef-core on demand'
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
    $rotatedProperties = ViewerProperties 'rev-0001.pdf' 3
    if ($rotatedProperties.pageSize -ceq $sourceProperties.pageSize) { throw 'native viewer did not adopt the rotated first-page geometry' }

    FocusViewerCanvas
    Send-ControlKey 0x5A # Ctrl+Z
    WaitFor { $s = State; ((Get-Content (Join-Path $revision.DirectoryName 'meta.json') -Raw) -match '"revision"\s*:\s*0') -and (ControlDisabled $s 'viewer-undo') -eq $true -and (ControlDisabled $s 'viewer-redo') -eq $false -and (TabDirty $s) -eq $false } 'undo revision applied in core and viewer'
    $undoState = State
    if ($undoState.message) { throw "undo action reported an error: $($undoState.message)" }
    $undoProperties = ViewerProperties 'rev-0000.pdf' 3
    if ($undoProperties.pageSize -cne $sourceProperties.pageSize) { throw 'Undo did not restore the original first-page geometry in pdfium' }
    FocusViewerCanvas
    Send-ControlKey 0x59 # Ctrl+Y
    WaitFor { $s = State; ((Get-Content (Join-Path $revision.DirectoryName 'meta.json') -Raw) -match '"revision"\s*:\s*1') -and (ControlDisabled $s 'viewer-undo') -eq $false -and (ControlDisabled $s 'viewer-redo') -eq $true -and (TabDirty $s) -eq $true } 'redo revision applied in core and viewer'
    $redoState = State
    if ($redoState.message) { throw "redo action reported an error: $($redoState.message)" }
    $redoProperties = ViewerProperties 'rev-0001.pdf' 3
    if ($redoProperties.pageSize -cne $rotatedProperties.pageSize) { throw 'Redo did not restore the rotated first-page geometry in pdfium' }

    Send 'action saveeditas' | Out-Null
    WaitFor { Test-Path $saved } 'Save As output'
    if ((PdfRotation $saved) -ne '90') { throw 'Save As PDF does not contain the rotated page' }
    if ((PdfRotation $source) -ne '0' -or (PdfPages $saved) -ne '3') { throw 'Save As changed the source or lost pages' }
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $sourceHash) { throw 'Save As changed the original source bytes' }
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
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $sourceHash) { throw 'Ctrl+S changed the original source bytes' }

    # A closed, clean session releases its hold; the short E2E timeout should stop the core. A second
    # launch forwards the saved PDF to this primary app; editing it must start a fresh core process.
    $beforeIdleStopPids = @(CoreProcesses $proc.Id | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)
    Send 'action closetab' | Out-Null
    WaitFor { (State).tabs.Count -eq 0 } 'closing the clean document session'
    $idleDeadline = (Get-Date).AddSeconds(15)
    do {
        $idleCorePids = @(CoreProcesses $proc.Id | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)
        if ($idleCorePids.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $idleDeadline)
    if ($idleCorePids.Count -gt 0) { throw "R3.03 closed session did not idle-stop chef-core: $($idleCorePids -join ',')" }
    foreach ($corePid in $beforeIdleStopPids) {
        if (Get-Process -Id $corePid -ErrorAction SilentlyContinue) { throw "R3.03 idle stop left prior core PID $corePid alive" }
    }
    $env:CHEF_USER_DATA_DIR = $dataDir
    $env:CHEF_E2E = '1'
    try {
        $secondLaunch = Start-Process -FilePath $Exe -ArgumentList ('"' + $saved + '"') -PassThru -WindowStyle Hidden
    }
    finally {
        $env:CHEF_USER_DATA_DIR = $previousUserDataDir
        $env:CHEF_E2E = $previousE2E
    }
    if (-not $secondLaunch.WaitForExit(10000)) {
        Stop-Process -Id $secondLaunch.Id -Force -ErrorAction SilentlyContinue
        throw 'second instance did not exit after forwarding the saved PDF'
    }
    WaitFor { $s = State; $s.tabs.Count -eq 1 -and $s.tabs[0].title -eq 'saved-as.pdf' } 'reopening the saved PDF through the primary instance'
    Send 'action rotatepage' | Out-Null
    WaitFor { (Get-ChildItem (Join-Path $dataDir 'sessions') -Filter 'rev-0001.pdf' -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0 } 'core restart on the next edit after idle stop'
    $restartedCorePids = @(CoreProcesses $proc.Id | ForEach-Object { [int]$_.ProcessId } | Sort-Object -Unique)
    if ($restartedCorePids.Count -eq 0 -or @($restartedCorePids | Where-Object { $beforeIdleStopPids -contains $_ }).Count -gt 0) {
        throw 'R3.03 next edit did not start a new chef-core process after idle stop'
    }
    $restartedRevision = Get-ChildItem (Join-Path $dataDir 'sessions') -Filter 'rev-0001.pdf' -Recurse | Select-Object -First 1
    if ((PdfRotation $restartedRevision.FullName) -ne '270' -or (PdfRotation $saved) -ne '180') {
        throw 'R3.03 restarted core did not preserve the saved document state before applying the next edit'
    }
    Send 'action undoedit' | Out-Null
    WaitFor { (TabDirty (State)) -eq $false } 'undo restores the saved state after core restart'
    Write-Output 'PASS closed session idle-stops chef-core; next edit restarts it with the saved PDF intact'

    Send 'quit' | Out-Null
    if (-not $proc.WaitForExit(5000)) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        if (-not $proc.WaitForExit(5000)) { throw 'Original app process did not exit before native reopen.' }
    }
    $shutdownCorePids = @($startedCorePids + $restartedCorePids | Sort-Object -Unique)
    $coreExitDeadline = (Get-Date).AddSeconds(10)
    do {
        $liveCorePids = @($shutdownCorePids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if ($liveCorePids.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $coreExitDeadline)
    if ($liveCorePids.Count -gt 0) { throw "R3.02 app shutdown left chef-core PIDs running: $($liveCorePids -join ',')" }
    Write-Output 'PASS app shutdown leaves no chef-core process'

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
    WaitFor { (Test-Path -LiteralPath $reopenLog) -and ((Get-Content -LiteralPath $reopenLog -Raw) -match 'CHEF_DEBUG_TOKEN=') } 'reopened viewer debug channel'
    $reopenText = Get-Content $reopenLog -Raw
    $script:pipe = [regex]::Match($reopenText, 'chef-native-\d+').Value
    $script:token = [regex]::Match($reopenText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    if (-not $script:pipe -or -not $script:token) { throw 'reopened viewer debug pipe/token are missing' }
    WaitFor { try { $snapshot = Send 'state' | ConvertFrom-Json; ($null -ne $snapshot.view) -and ($null -eq $snapshot.message) } catch { $false } } 'saved document loaded without an error'
    $savedProperties = ViewerProperties 'saved-as.pdf' 3
    if ($savedProperties.pageSize -cne $sourceProperties.pageSize) { throw 'the 180-degree saved output reopened with unexpected page dimensions in pdfium' }
    Send 'quit' | Out-Null
    if (-not $reopen.WaitForExit(5000)) {
        Stop-Process -Id $reopen.Id -Force -ErrorAction SilentlyContinue
        if (-not $reopen.WaitForExit(5000)) { throw 'Reopened app process did not exit.' }
    }
    Write-Output 'PASS source guard -> page.rotate/revision/cache -> physical Ctrl+Z/Y -> Save As -> physical Ctrl+S -> native reopen'
    $passed = $true
}
finally {
    $env:CHEF_E2E = $previousE2E; $env:CHEF_USER_DATA_DIR = $previousUserDataDir; $env:CHEF_E2E_SAVE_AS_PATH = $previousSaveAsPath; $env:CHEF_E2E_IDLE_STOP_MS = $previousIdleStop
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        if (-not $proc.WaitForExit(5000)) { Write-Warning "chef-app process $($proc.Id) did not exit during cleanup." }
    }
    if ($reopen -and -not $reopen.HasExited) {
        Stop-Process -Id $reopen.Id -Force -ErrorAction SilentlyContinue
        if (-not $reopen.WaitForExit(5000)) { Write-Warning "Reopened chef-app process $($reopen.Id) did not exit during cleanup." }
    }
    if ($passed) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    else { Write-Warning "E2E artifacts retained for diagnosis: $work" }
}
