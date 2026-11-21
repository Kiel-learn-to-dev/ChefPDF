#requires -Version 7.0
<#
.SYNOPSIS
  R4.03/R4.04 E2E: multi-page rotate, insert, replace, duplicate, delete, extract,
  undo via real chef-core, and source-file immutability.
.DESCRIPTION
  Windows only. Requires chef-app.exe, pdfium.dll, and core/.venv.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-pageops-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$log = Join-Path $work 'app.log'
$source = Join-Path $work 'pageops-source.pdf'
$sourcePages = Join-Path $work 'pageops-insert-source.pdf'
$extracted = Join-Path $work 'extracted.pdf'

$oldE2E = $env:CHEF_E2E
$oldUserData = $env:CHEF_USER_DATA_DIR
$oldExtractPath = $env:CHEF_E2E_EXTRACT_PATH
$oldPageSource = $env:CHEF_E2E_PAGE_SOURCE
$proc = $null
$passed = $false
$script:pipe = $null
$script:token = $null
$script:fails = 0

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

function ControlDisabled([object]$Snap, [string]$Id) {
    $c = $Snap.controls.controls | Where-Object id -eq $Id | Select-Object -First 1
    if ($null -eq $c) { return $null }
    return [bool]$c.disabled
}

function WaitFor([scriptblock]$Predicate, [string]$What, [int]$Seconds = 60) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($proc -and $proc.HasExited) {
            throw "chef-app exited ($($proc.ExitCode)) while waiting for $What. Log: $(Get-Content $log -Raw -ErrorAction SilentlyContinue)"
        }
        if (& $Predicate) { return }
        Start-Sleep -Milliseconds 150
    }
    throw "Timed out waiting for $What. Log: $(Get-Content $log -Raw -ErrorAction SilentlyContinue)"
}

function Click-Control([string]$Id, [string]$Mods = '') {
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
    } "control bounds for $Id" 15
    $snapshot = $script:targetSnapshot
    $control = $script:targetControl
    $scale = [double]$snapshot.controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $scale)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $scale)
    if ($Mods) {
        Send "click $x $y $Mods" | Out-Null
    } else {
        Send "click $x $y" | Out-Null
    }
}

function RightClick-Control([string]$Id) {
    $snapshot = State
    $control = $snapshot.controls.controls | Where-Object { $_.id -eq $Id } | Select-Object -First 1
    if ($null -eq $control -or $null -eq $control.bounds) { throw "Missing control bounds for $Id" }
    $scale = [double]$snapshot.controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $scale)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $scale)
    Send "mouse move $x $y" | Out-Null
    Start-Sleep -Milliseconds 80
    Send "mouse rdown $x $y" | Out-Null
    Start-Sleep -Milliseconds 60
    Send "mouse rup $x $y" | Out-Null
    Start-Sleep -Milliseconds 180
}
function Drag-Control([string]$SourceId, [string]$TargetId) {
    $snapshot = State
    $scale = [double]$snapshot.controls.scale
    $source = $snapshot.controls.controls | Where-Object id -eq $SourceId | Select-Object -First 1
    $target = $snapshot.controls.controls | Where-Object id -eq $TargetId | Select-Object -First 1
    if ($null -eq $source -or $null -eq $source.bounds) { throw "Missing control bounds for $SourceId" }
    if ($null -eq $target -or $null -eq $target.bounds) { throw "Missing control bounds for $TargetId" }
    $sx = [int](($source.bounds[0] + $source.bounds[2] / 2) * $scale)
    $sy = [int](($source.bounds[1] + $source.bounds[3] / 2) * $scale)
    $tx = [int](($target.bounds[0] + $target.bounds[2] / 2) * $scale)
    $ty = [int](($target.bounds[1] + $target.bounds[3] / 2) * $scale)
    Send "mouse down $sx $sy" | Out-Null
    Start-Sleep -Milliseconds 120
    Send "mouse move $($sx + 5) $($sy + 5)" | Out-Null
    Start-Sleep -Milliseconds 100
    Send "mouse move $tx $ty" | Out-Null
    $target = [int]($TargetId -replace '^thumbnail-', '') - 1
    WaitFor { (State).sidebarDragTarget -eq $target } "drag target is page $($target + 1)" 10
    Send "mouse up $tx $ty" | Out-Null
    Start-Sleep -Milliseconds 250
}

function Get-CurrentRevisionPath() {
    $sessionsRoot = Join-Path $dataDir 'sessions'
    $metaFile = Get-ChildItem -LiteralPath $sessionsRoot -Filter 'meta.json' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $metaFile) { throw 'meta.json not found' }
    $meta = Get-Content -LiteralPath $metaFile.FullName -Raw | ConvertFrom-Json
    $rev = [int]$meta.revision
    return (Join-Path $metaFile.DirectoryName ('rev-{0:D4}.pdf' -f $rev))
}

function Get-CurrentRevisionIndex() {
    $sessionsRoot = Join-Path $dataDir 'sessions'
    $metaFile = Get-ChildItem -LiteralPath $sessionsRoot -Filter 'meta.json' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $metaFile) { return -1 }
    $meta = Get-Content -LiteralPath $metaFile.FullName -Raw | ConvertFrom-Json
    $revs = @($meta.revisions | ForEach-Object { [int]$_ })
    return [array]::IndexOf($revs, [int]$meta.revision)
}

function Get-PdfRotations([string]$Path) {
    Push-Location (Join-Path $repo 'core')
    try {
        $out = & uv run --no-project python -c 'import pikepdf,sys; p=pikepdf.Pdf.open(sys.argv[1]); print(",".join(str(int(pg.get("/Rotate",0))) for pg in p.pages))' $Path
        if ($LASTEXITCODE -ne 0) { throw "pikepdf failed inspecting $Path" }
        return $out.Trim()
    } finally {
        Pop-Location
    }
}

function Get-PdfTexts([string]$Path) {
    Push-Location (Join-Path $repo 'core')
    try {
        $out = & uv run --no-project python -c 'import pypdfium2 as pdfium,sys; d=pdfium.PdfDocument(sys.argv[1]); print("|".join(d[i].get_textpage().get_text_range().strip() for i in range(len(d))))' $Path
        if ($LASTEXITCODE -ne 0) { throw "pypdfium2 failed reading texts of $Path" }
        return $out.Trim()
    } finally {
        Pop-Location
    }
}

function SelectionText([object]$Sel) {
    return (@($Sel.selected | ForEach-Object { [int]$_ }) -join ',')
}

try {
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $fixture = @'
import pikepdf, sys
pdf = pikepdf.new()
font = pdf.make_indirect(
    pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica
    )
)
for label in sys.argv[2:]:
    pdf.add_blank_page(page_size=(612, 400))
    page = pdf.pages[-1]
    page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    page.Contents = pdf.make_stream(f"BT /F1 48 Tf 100 200 Td ({label}) Tj ET".encode())
pdf.save(sys.argv[1])
'@
    Push-Location (Join-Path $repo 'core')
    try {
        & uv run --no-project python -c $fixture $source P1 P2 P3 P4
        if ($LASTEXITCODE -ne 0) { throw 'main fixture generation failed' }
        & uv run --no-project python -c $fixture $sourcePages S1 S2
        if ($LASTEXITCODE -ne 0) { throw 'fixture generation failed' }
    } finally {
        Pop-Location
    }
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    $sourcePagesHash = (Get-FileHash -LiteralPath $sourcePages -Algorithm SHA256).Hash

    $env:CHEF_E2E = '1'
    $env:CHEF_USER_DATA_DIR = $dataDir
    $env:CHEF_E2E_EXTRACT_PATH = $extracted
    $env:CHEF_E2E_PAGE_SOURCE = $sourcePages
    try {
        $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $source + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
    } finally {
        Restore-Env 'CHEF_E2E' $oldE2E
        Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
        Restore-Env 'CHEF_E2E_EXTRACT_PATH' $oldExtractPath
        Restore-Env 'CHEF_E2E_PAGE_SOURCE' $oldPageSource
    }

    WaitFor {
        if (-not (Test-Path -LiteralPath $log)) { return $false }
        $text = [string](Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue)
        $script:pipe = [regex]::Match($text, 'chef-native-\d+').Value
        $script:token = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
        if (-not $script:pipe -or -not $script:token) { return $false }
        try {
            $s = State
            return ($null -ne $s.view -and $s.view.pageCount -eq 4 -and $null -ne ($s.controls.controls | Where-Object id -eq 'thumbnail-4'))
        } catch {
            return $false
        }
    } '4-page document ready' 60

    # Page context menu opens on the pointer and selects the pointed page.
    RightClick-Control 'thumbnail-2'
    WaitFor { $null -ne ((State).controls.controls | Where-Object id -eq 'page-context-menu') } 'page context menu opens'
    $s = State
    $menu = $s.controls.controls | Where-Object id -eq 'page-context-menu' | Select-Object -First 1
    $createPdf = $s.controls.controls | Where-Object id -eq 'page-menu-create-pdf' | Select-Object -First 1
    Expect 'right-click selects the page under pointer' ((SelectionText $s.pageSelection) -eq '1') (SelectionText $s.pageSelection)
    Expect 'context menu labels single-page PDF export' ($createPdf.name -eq 'Tạo PDF từ 1 trang đã chọn') ([string]$createPdf.name)
    Expect 'unsigned document keeps rotate enabled' (($s.controls.controls | Where-Object id -eq 'page-menu-rotate-left').disabled -eq $false) 'rotate menu item is unexpectedly disabled'
    Send 'key 27' | Out-Null
    WaitFor { $null -eq ((State).controls.controls | Where-Object id -eq 'page-context-menu') } 'page context menu closes with Escape'

    Click-Control 'thumbnail-2'
    Click-Control 'thumbnail-4' 'ctrl'
    WaitFor { (SelectionText (State).pageSelection) -eq '1,3' } 'pages 2 and 4 selected for context menu'
    RightClick-Control 'thumbnail-2'
    $s = State
    $createPdf = $s.controls.controls | Where-Object id -eq 'page-menu-create-pdf' | Select-Object -First 1
    Expect 'right-click inside selection preserves all selected pages' ((SelectionText $s.pageSelection) -eq '1,3') (SelectionText $s.pageSelection)
    Expect 'context menu labels multi-page PDF export' ($createPdf.name -eq 'Tạo PDF từ 2 trang đã chọn') ([string]$createPdf.name)
    Send 'key 27' | Out-Null
    WaitFor { $null -eq ((State).controls.controls | Where-Object id -eq 'page-context-menu') } 'multi-page context menu closes'

    RightClick-Control 'thumbnail-3'
    $s = State
    $createPdf = $s.controls.controls | Where-Object id -eq 'page-menu-create-pdf' | Select-Object -First 1
    Expect 'right-click outside selection selects only target page' ((SelectionText $s.pageSelection) -eq '2') (SelectionText $s.pageSelection)
    Expect 'context menu labels single target after replacing selection' ($createPdf.name -eq 'Tạo PDF từ 1 trang đã chọn') ([string]$createPdf.name)
    Send 'key 27' | Out-Null
    WaitFor { $null -eq ((State).controls.controls | Where-Object id -eq 'page-context-menu') } 'single-page context menu closes'

    # 1. Multi-page rotate clockwise & counterclockwise + undo
    Click-Control 'thumbnail-2'
    Click-Control 'thumbnail-4' 'ctrl'
    WaitFor { (SelectionText (State).pageSelection) -eq '1,3' } 'pages 2 and 4 selected'

    Send 'action rotatepage' | Out-Null
    WaitFor {
        (Get-CurrentRevisionIndex) -eq 1 -and (ControlDisabled (State) 'viewer-undo') -eq $false
    } 'multi-page rotate clockwise applied'
    $rev1 = Get-CurrentRevisionPath
    Expect 'multi-page rotate clockwise rotates pages 2 and 4' ((Get-PdfRotations $rev1) -eq '0,90,0,90') ("got " + (Get-PdfRotations $rev1))

    Send 'action rotatepageleft' | Out-Null
    WaitFor {
        (Get-CurrentRevisionIndex) -eq 2 -and (ControlDisabled (State) 'viewer-undo') -eq $false
    } 'multi-page rotate left applied'
    $rev2 = Get-CurrentRevisionPath
    Expect 'multi-page rotate left restores 0,0,0,0' ((Get-PdfRotations $rev2) -eq '0,0,0,0') ("got " + (Get-PdfRotations $rev2))

    Send 'action undoedit' | Out-Null
    WaitFor { (Get-CurrentRevisionIndex) -eq 1 -and (ControlDisabled (State) 'viewer-undo') -eq $false } 'undo 1'
    Send 'action undoedit' | Out-Null
    WaitFor { (Get-CurrentRevisionIndex) -eq 0 -and (ControlDisabled (State) 'viewer-undo') -eq $true } 'undo 2 back to rev 0'
    Expect 'undo restores initial rotations' ((Get-PdfRotations (Get-CurrentRevisionPath)) -eq '0,0,0,0') ("got " + (Get-PdfRotations (Get-CurrentRevisionPath)))

    # 2. Insert and replace pages from a source file, with revision undo.
    Click-Control 'thumbnail-2'
    $revBeforeInsert = Get-CurrentRevisionIndex
    Send 'action insertblankbefore' | Out-Null
    WaitFor { (State).view.pageCount -eq 5 -and (Get-CurrentRevisionIndex) -gt $revBeforeInsert } 'insert blank before selected page'
    Expect 'blank insertion selects inserted page' ((SelectionText (State).pageSelection) -eq '1') (SelectionText (State).pageSelection)
    Expect 'blank insertion preserves surrounding page order' ((Get-PdfTexts (Get-CurrentRevisionPath)) -eq 'P1||P2|P3|P4') (Get-PdfTexts (Get-CurrentRevisionPath))
    Send 'action undoedit' | Out-Null
    WaitFor { (State).view.pageCount -eq 4 -and (Get-CurrentRevisionIndex) -eq $revBeforeInsert } 'undo blank insertion'

    Click-Control 'thumbnail-2'
    Click-Control 'thumbnail-4' 'ctrl'
    WaitFor { (SelectionText (State).pageSelection) -eq '1,3' } 'pages 2 and 4 selected for insert after'
    $revBeforeInsertAfter = Get-CurrentRevisionIndex
    Send 'action insertblankafter' | Out-Null
    WaitFor {
        (State).view.pageCount -eq 5 -and (Get-CurrentRevisionIndex) -gt $revBeforeInsertAfter
    } 'insert blank after the final selected page'
    Expect 'insert after multi-selection appends after page 4' ((Get-PdfTexts (Get-CurrentRevisionPath)) -eq 'P1|P2|P3|P4|') (Get-PdfTexts (Get-CurrentRevisionPath))
    Expect 'multi-selection after insertion selects appended page' ((SelectionText (State).pageSelection) -eq '4') (SelectionText (State).pageSelection)
    Send 'action undoedit' | Out-Null
    WaitFor { (State).view.pageCount -eq 4 -and (Get-CurrentRevisionIndex) -eq $revBeforeInsertAfter } 'undo multi-selection insert after'

    Click-Control 'thumbnail-2'
    $revBeforeFileInsert = Get-CurrentRevisionIndex
    Send 'action insertpagesfromfile' | Out-Null
    WaitFor { (State).view.pageCount -eq 6 -and (Get-CurrentRevisionIndex) -gt $revBeforeFileInsert } 'insert source PDF before selected page'
    Expect 'PDF insertion preserves source order and surrounding pages' ((Get-PdfTexts (Get-CurrentRevisionPath)) -eq 'P1|S1|S2|P2|P3|P4') (Get-PdfTexts (Get-CurrentRevisionPath))
    Expect 'PDF insertion selects first inserted page' ((SelectionText (State).pageSelection) -eq '1') (SelectionText (State).pageSelection)
    Send 'action undoedit' | Out-Null
    WaitFor { (State).view.pageCount -eq 4 -and (Get-CurrentRevisionIndex) -eq $revBeforeFileInsert } 'undo PDF insertion'

    Click-Control 'thumbnail-2'
    $revBeforeReplace = Get-CurrentRevisionIndex
    Send 'action replaceselectedpages' | Out-Null
    WaitFor { (State).view.pageCount -eq 5 -and (Get-CurrentRevisionIndex) -gt $revBeforeReplace } 'replace selected page with two source pages'
    Expect 'replace keeps untouched pages and allows a different page count' ((Get-PdfTexts (Get-CurrentRevisionPath)) -eq 'P1|S1|S2|P3|P4') (Get-PdfTexts (Get-CurrentRevisionPath))
    Expect 'replace selects first replaced page' ((SelectionText (State).pageSelection) -eq '1') (SelectionText (State).pageSelection)
    Expect 'insert and replace leave source PDF unchanged' ((Get-FileHash -LiteralPath $sourcePages -Algorithm SHA256).Hash -eq $sourcePagesHash) 'source PDF hash changed'
    Send 'action undoedit' | Out-Null
    WaitFor { (State).view.pageCount -eq 4 -and (Get-CurrentRevisionIndex) -eq $revBeforeReplace } 'undo replacement'

    # 3. Multi-page duplicate + selection remap + undo
    Click-Control 'thumbnail-1'
    Click-Control 'thumbnail-3' 'ctrl'
    WaitFor { (SelectionText (State).pageSelection) -eq '0,2' } 'pages 1 and 3 selected'
    $revBeforeDup = Get-CurrentRevisionIndex

    Send 'action duplicatepages' | Out-Null
    WaitFor {
        $s = State
        (Get-CurrentRevisionIndex) -gt $revBeforeDup -and $s.view.pageCount -eq 6 -and (ControlDisabled $s 'viewer-undo') -eq $false
    } 'duplicate pages 1 and 3 creates 6-page revision'
    $s = State
    Expect 'duplicate selects newly inserted copies [1,4]' ((SelectionText $s.pageSelection) -eq '1,4') ("got " + (SelectionText $s.pageSelection))
    $dupTexts = Get-PdfTexts (Get-CurrentRevisionPath)
    Expect 'duplicate inserts copies right after originals' ($dupTexts -eq 'P1|P1|P2|P3|P3|P4') "got $dupTexts"

    Send 'action undoedit' | Out-Null
    WaitFor {
        $s = State
        $s.view.pageCount -eq 4 -and (ControlDisabled $s 'viewer-undo') -eq $true -and (Get-CurrentRevisionIndex) -eq $revBeforeDup
    } 'undo duplicate restores 4 pages'
    $afterUndoDup = Get-PdfTexts (Get-CurrentRevisionPath)
    Expect 'undo duplicate restores P1..P4' ($afterUndoDup -eq 'P1|P2|P3|P4') "got $afterUndoDup"

    # 4. Multi-page delete + selection remap + undo
    Click-Control 'thumbnail-2'
    Click-Control 'thumbnail-4' 'ctrl'
    WaitFor { (SelectionText (State).pageSelection) -eq '1,3' } 'pages 2 and 4 selected for delete'
    $revBeforeDel = Get-CurrentRevisionIndex

    Send 'action deletepages' | Out-Null
    WaitFor {
        $s = State
        (Get-CurrentRevisionIndex) -gt $revBeforeDel -and $s.view.pageCount -eq 2 -and (ControlDisabled $s 'viewer-undo') -eq $false
    } 'delete pages 2 and 4 creates 2-page revision'
    $s = State
    Expect 'delete remaps selection to [1]' ((SelectionText $s.pageSelection) -eq '1') ("got " + (SelectionText $s.pageSelection))
    $delTexts = Get-PdfTexts (Get-CurrentRevisionPath)
    Expect 'delete keeps pages P1 and P3' ($delTexts -eq 'P1|P3') "got $delTexts"

    Send 'action undoedit' | Out-Null
    WaitFor {
        $s = State
        $s.view.pageCount -eq 4 -and (Get-CurrentRevisionIndex) -eq $revBeforeDel
    } 'undo delete restores 4 pages'
    $afterUndoDel = Get-PdfTexts (Get-CurrentRevisionPath)
    Expect 'undo delete restores P1..P4' ($afterUndoDel -eq 'P1|P2|P3|P4') "got $afterUndoDel"

    # 5. Cannot delete all pages
    Send 'action selectallpages' | Out-Null
    WaitFor { (SelectionText (State).pageSelection) -eq '0,1,2,3' } 'all 4 pages selected'
    Send 'action deletepages' | Out-Null
    WaitFor { $null -ne (State).message } 'cannot-delete-all warning displayed'
    $s = State
    Expect 'cannot-delete-all keeps 4 pages' ($s.view.pageCount -eq 4) "pageCount=$($s.view.pageCount)"
    Expect 'cannot-delete-all shows localized message' ($s.message -like '*Không thể xóa hết các trang*') "message=$($s.message)"

    # 6. Extract pages 2 and 4 to new file and open in new tab without modifying source
    Click-Control 'thumbnail-2'
    Click-Control 'thumbnail-4' 'ctrl'
    WaitFor { (SelectionText (State).pageSelection) -eq '1,3' } 'pages 2 and 4 selected for extract'

    Send 'action extractpages' | Out-Null
    WaitFor {
        $s = State
        (Test-Path -LiteralPath $extracted) -and $s.tabs.Count -eq 2 -and ($s.tabs | Where-Object { $_.active } | Select-Object -First 1).title -eq 'extracted.pdf'
    } 'extract writes PDF and opens it as active second tab'
    $extractTexts = Get-PdfTexts $extracted
    Expect 'extracted PDF contains P2 and P4' ($extractTexts -eq 'P2|P4') "got $extractTexts"
    Expect 'extract leaves source file bytes untouched' ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -eq $sourceHash) 'source SHA-256 changed'
    Expect 'extract leaves source page texts intact' ((Get-PdfTexts $source) -eq 'P1|P2|P3|P4') 'source page texts changed'

    # Drag page 2 before page 4 in grid mode. One drop must create one revision.
    Click-Control 'doc-tab-1'
    WaitFor { (State).view.pageCount -eq 4 } 'return to source document for page reorder'
    Click-Control 'sidebar-grid'
    WaitFor { (State).sidebarGrid -eq $true } 'grid sidebar opens'
    $revisionBeforeReorder = [Math]::Max(0, (Get-CurrentRevisionIndex))
    Click-Control 'thumbnail-2'
    WaitFor { (SelectionText (State).pageSelection) -eq '1' } 'select only page 2 before dragging'
    Drag-Control 'thumbnail-2' 'thumbnail-4'
    WaitFor { (Get-CurrentRevisionIndex) -eq ($revisionBeforeReorder + 1) } 'page reorder creates one revision'
    Expect 'dragging page 2 before page 4 reorders content' ((Get-PdfTexts (Get-CurrentRevisionPath)) -eq 'P1|P3|P2|P4') 'page content order changed incorrectly'
    Expect 'reordered page remains selected at its new index' ((SelectionText (State).pageSelection) -eq '2') (SelectionText (State).pageSelection)

    # Release a drag outside any tile; cancellation must not create a revision.
    $revisionBeforeCancel = Get-CurrentRevisionIndex
    $snapshot = State
    $scale = [double]$snapshot.controls.scale
    $sourceTile = $snapshot.controls.controls | Where-Object id -eq 'thumbnail-3' | Select-Object -First 1
    $sx = [int](($sourceTile.bounds[0] + $sourceTile.bounds[2] / 2) * $scale)
    $sy = [int](($sourceTile.bounds[1] + $sourceTile.bounds[3] / 2) * $scale)
    Send "mouse down $sx $sy" | Out-Null
    Start-Sleep -Milliseconds 100
    Send "mouse move $($sx + 5) $($sy + 5)" | Out-Null
    Start-Sleep -Milliseconds 100
    Send 'mouse move 20 20' | Out-Null
    Start-Sleep -Milliseconds 100
    Send 'mouse up 20 20' | Out-Null
    Start-Sleep -Milliseconds 250
    Expect 'cancelled drag leaves revision and page order unchanged' ((Get-CurrentRevisionIndex) -eq $revisionBeforeCancel -and (Get-PdfTexts (Get-CurrentRevisionPath)) -eq 'P1|P3|P2|P4') 'cancelled drag mutated the document'
    Send 'action undoedit' | Out-Null
    WaitFor { (Get-CurrentRevisionIndex) -eq $revisionBeforeReorder } 'undo page reorder returns to clean source revision'
    Click-Control 'sidebar-pages'
    WaitFor { (State).sidebarGrid -eq $false } 'thumbnail list restored'

    # Clean window close
    Send 'closewindow' | Out-Null
    if (-not $proc.WaitForExit(15000)) { throw 'chef-app did not exit cleanly after closewindow' }
    Expect 'clean window close exits with code 0' ($proc.ExitCode -eq 0) "exit=$($proc.ExitCode)"
    $sessionsLeft = @(Get-ChildItem -LiteralPath (Join-Path $dataDir 'sessions') -Directory -ErrorAction SilentlyContinue).Count
    Expect 'clean window close deletes session dirs' ($sessionsLeft -eq 0) "sessionsLeft=$sessionsLeft"

    if ($script:fails -gt 0) { throw "R4.03 page ops E2E failed with $($script:fails) failure(s)" }
    $passed = $true
} finally {
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Restore-Env 'CHEF_E2E_EXTRACT_PATH' $oldExtractPath
    Restore-Env 'CHEF_E2E_PAGE_SOURCE' $oldPageSource
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
