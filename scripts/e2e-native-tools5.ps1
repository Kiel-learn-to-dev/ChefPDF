#requires -Version 7.0
<#
.SYNOPSIS
  M5a Windows E2E (R5.03–R5.08): Merge, Split, Crop/Resize, Remove Blank Pages, Grid Split, Smart Split
  via real chef-core and debug pipe without OS input synthesis.
.DESCRIPTION
  Windows only. Requires chef-app.exe, pdfium.dll, and core/.venv.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$py = Join-Path $repo 'core\.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $py)) { throw "core/.venv python not found: $py" }

$work = Join-Path $env:TEMP ('chef-native-tools5-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$outDir = Join-Path $work 'out'
$log = Join-Path $work 'app.log'
$mainPdf = Join-Path $work 'main.pdf'
$extraPdf = Join-Path $work 'extra.pdf'
$mergedPdf = Join-Path $work 'merged.pdf'

$oldE2E = $env:CHEF_E2E
$oldUserData = $env:CHEF_USER_DATA_DIR
$oldOpenPdfs = $env:CHEF_E2E_OPEN_PDFS
$oldSavePdf = $env:CHEF_E2E_SAVE_PDF
$proc = $null
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
function Controls([object]$Snap) { return @($Snap.controls.controls) }
function Ctrl([object]$Snap, [string]$Id) {
    return ($Snap.controls.controls | Where-Object id -eq $Id | Select-Object -First 1)
}

function WaitFor([scriptblock]$Predicate, [string]$What, [int]$Seconds = 45) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($proc -and $proc.HasExited) {
            $err = if (Test-Path -LiteralPath $log) { (Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue) } else { '' }
            throw "chef-app exited ($($proc.ExitCode)) while waiting for $What. Log:`n$err"
        }
        if (& $Predicate) { return }
        Start-Sleep -Milliseconds 120
    }
    throw "Timed out waiting for $What"
}

function ClickControl([string]$Id, [int]$WaitSeconds = 20) {
    WaitFor {
        $s = State
        $c = Ctrl $s $Id
        return ($null -ne $c -and $null -ne $c.bounds -and (-not $c.disabled))
    } "enabled control '$Id'" $WaitSeconds
    $s = State
    $c = Ctrl $s $Id
    $scale = [double]$s.controls.scale
    $x = [int](($c.bounds[0] + $c.bounds[2] / 2.0) * $scale)
    $y = [int](($c.bounds[1] + $c.bounds[3] / 2.0) * $scale)
    Send "click $x $y" | Out-Null
    Start-Sleep -Milliseconds 150
}

function Get-CurrentRevisionIndex() {
    $sessionsRoot = Join-Path $dataDir 'sessions'
    $metaFile = Get-ChildItem -LiteralPath $sessionsRoot -Filter 'meta.json' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $metaFile) { return -1 }
    $meta = Get-Content -LiteralPath $metaFile.FullName -Raw | ConvertFrom-Json
    $revs = @($meta.revisions | ForEach-Object { [int]$_ })
    return [array]::IndexOf($revs, [int]$meta.revision)
}

function Get-CurrentRevisionPath() {
    $sessionsRoot = Join-Path $dataDir 'sessions'
    $metaFile = Get-ChildItem -LiteralPath $sessionsRoot -Filter 'meta.json' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $metaFile) { throw 'meta.json not found' }
    $meta = Get-Content -LiteralPath $metaFile.FullName -Raw | ConvertFrom-Json
    $rev = [int]$meta.revision
    return (Join-Path $metaFile.DirectoryName ('rev-{0:D4}.pdf' -f $rev))
}

function Run-Py([string]$Script, [string[]]$PyArgs) {
    $out = & $py -c $Script @PyArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Python helper failed ($LASTEXITCODE): $($out -join "`n")"
    }
    return (($out | Out-String).Trim())
}

try {
    New-Item -ItemType Directory -Force -Path $work, $dataDir, $outDir | Out-Null

    # Settings without UTF-8 BOM so ChefPDF loader accepts defaultSaveDir.
    $settingsJson = (@{
        theme = 'light'
        language = 'vi'
        defaultSaveDir = $outDir
        recentFiles = @()
        prefs = @{}
    } | ConvertTo-Json -Depth 4)
    [System.IO.File]::WriteAllText((Join-Path $dataDir 'settings.json'), $settingsJson, [System.Text.UTF8Encoding]::new($false))

    # Build main.pdf (4 pages: P1 text, P2 blank, P3 text, P4 text) and extra.pdf (2 pages: E1, E2).
    $mkMain = @'
import pikepdf, sys
pdf = pikepdf.new()
font = pdf.make_indirect(pikepdf.Dictionary(
    Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica
))
for idx, label in enumerate(["Page1", "", "Page3", "Page4"], 1):
    pdf.add_blank_page(page_size=(612, 792))
    if label:
        pg = pdf.pages[-1]
        pg.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
        pg.Contents = pdf.make_stream(f"BT /F1 36 Tf 72 700 Td ({label}) Tj ET".encode())
pdf.save(sys.argv[1])
'@
    $mkExtra = @'
import pikepdf, sys
pdf = pikepdf.new()
font = pdf.make_indirect(pikepdf.Dictionary(
    Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica
))
for label in ["Extra1", "Extra2"]:
    pdf.add_blank_page(page_size=(612, 792))
    pg = pdf.pages[-1]
    pg.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    pg.Contents = pdf.make_stream(f"BT /F1 36 Tf 72 700 Td ({label}) Tj ET".encode())
pdf.save(sys.argv[1])
'@
    [void](Run-Py $mkMain @($mainPdf))
    [void](Run-Py $mkExtra @($extraPdf))

    $mainHash = (Get-FileHash -LiteralPath $mainPdf -Algorithm SHA256).Hash
    $extraHash = (Get-FileHash -LiteralPath $extraPdf -Algorithm SHA256).Hash

    $env:CHEF_E2E = '1'
    $env:CHEF_USER_DATA_DIR = $dataDir
    $env:CHEF_E2E_OPEN_PDFS = $extraPdf
    $env:CHEF_E2E_SAVE_PDF = $mergedPdf
    try {
        $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $mainPdf + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
    } finally {
        Restore-Env 'CHEF_E2E' $oldE2E
        Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
        Restore-Env 'CHEF_E2E_OPEN_PDFS' $oldOpenPdfs
        Restore-Env 'CHEF_E2E_SAVE_PDF' $oldSavePdf
    }

    WaitFor {
        if (-not (Test-Path -LiteralPath $log)) { return $false }
        $text = [string](Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue)
        $script:pipe = [regex]::Match($text, 'chef-native-\d+').Value
        $script:token = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
        return ($script:pipe -and $script:token)
    } 'debug pipe/token'

    WaitFor {
        $s = State
        return ($null -ne $s.view -and [int]$s.view.pageCount -eq 4)
    } 'initial 4-page main.pdf loaded'

    # -----------------------------------------------------------------------
    # 1. R5.03 MergeDialog (file.merge)
    # -----------------------------------------------------------------------
    Send 'action openmerge' | Out-Null
    WaitFor { $null -ne (Ctrl (State) 'merge-dialog') } 'merge-dialog open'
    ClickControl 'merge-add'
    WaitFor {
        $runBtn = Ctrl (State) 'merge-dialog-run'
        return ($null -ne $runBtn -and (-not $runBtn.disabled))
    } 'merge-dialog-run enabled after probing both files'
    ClickControl 'merge-dialog-run'
    WaitFor { $null -ne (Ctrl (State) 'merge-dialog-result') } 'merge-dialog-result'
    Expect 'R5.03 merged.pdf exists' (Test-Path -LiteralPath $mergedPdf) "missing $mergedPdf"
    $mergeCheck = Run-Py @'
import pikepdf, sys
with pikepdf.Pdf.open(sys.argv[1]) as pdf:
    with pdf.open_outline() as outline:
        titles = [item.title for item in outline.root]
    print(f"{len(pdf.pages)}|{','.join(titles)}")
'@ @($mergedPdf)
    Expect 'R5.03 merged pages=6 and filename bookmarks' ($mergeCheck -eq '6|main,extra') "got '$mergeCheck'"
    Expect 'R5.03 main.pdf unchanged' ((Get-FileHash -LiteralPath $mainPdf -Algorithm SHA256).Hash -eq $mainHash) 'main.pdf modified'
    Expect 'R5.03 extra.pdf unchanged' ((Get-FileHash -LiteralPath $extraPdf -Algorithm SHA256).Hash -eq $extraHash) 'extra.pdf modified'
    ClickControl 'merge-dialog-close'
    WaitFor { $null -eq (Ctrl (State) 'merge-dialog') } 'merge-dialog closed'

    # -----------------------------------------------------------------------
    # 2. R5.04 SplitDialog (file.split)
    # -----------------------------------------------------------------------
    Send 'action opensplit' | Out-Null
    WaitFor { $null -ne (Ctrl (State) 'split-dialog') } 'split-dialog open'
    ClickControl 'split-dialog-run'
    WaitFor { $null -ne (Ctrl (State) 'split-dialog-result') } 'split-dialog-result'
    $splitFiles = @(Get-ChildItem -LiteralPath $outDir -Filter '*.pdf' | Sort-Object Name)
    Expect 'R5.04 split produced 2 PDF files' ($splitFiles.Count -eq 2) "got $($splitFiles.Count)"
    if ($splitFiles.Count -eq 2) {
        $splitCounts = ($splitFiles | ForEach-Object {
            Run-Py 'import pikepdf,sys; print(len(pikepdf.Pdf.open(sys.argv[1]).pages))' @($_.FullName)
        }) -join ','
        Expect 'R5.04 split halves have 2,2 pages' ($splitCounts -eq '2,2') "got '$splitCounts'"
    }
    Expect 'R5.04 main.pdf unchanged' ((Get-FileHash -LiteralPath $mainPdf -Algorithm SHA256).Hash -eq $mainHash) 'main.pdf modified'
    ClickControl 'split-dialog-close'
    WaitFor { $null -eq (Ctrl (State) 'split-dialog') } 'split-dialog closed'
    Get-ChildItem -LiteralPath $outDir -Filter '*.pdf' | Remove-Item -Force

    # -----------------------------------------------------------------------
    # 3. R5.05 CropDialog (page.crop) + Undo
    # -----------------------------------------------------------------------
    $revBeforeCrop = Get-CurrentRevisionIndex
    $expectedUndoRev = [math]::Max(0, $revBeforeCrop)
    Send 'action opencropresize' | Out-Null
    WaitFor { $null -ne (Ctrl (State) 'crop-dialog') } 'crop-dialog open'
    ClickControl 'crop-m-top'
    Send 'action selectall' | Out-Null
    Start-Sleep -Milliseconds 100
    Send 'char 20' | Out-Null
    Start-Sleep -Milliseconds 120
    ClickControl 'crop-dialog-run'
    WaitFor {
        $null -eq (Ctrl (State) 'crop-dialog') -and (Get-CurrentRevisionIndex) -gt $revBeforeCrop
    } 'crop applied and revision advanced'
    $revCropPath = Get-CurrentRevisionPath
    $cropInfo = Run-Py @'
import pikepdf, pypdfium2 as pdfium, sys
p = pikepdf.Pdf.open(sys.argv[1])
pg = p.pages[0]
cb = [float(x) for x in pg.CropBox]
mb = [float(x) for x in pg.MediaBox]
d = pdfium.PdfDocument(sys.argv[1])
txt = d[0].get_textpage().get_text_range().strip()
print(f"{cb[3] < mb[3]}|{txt}")
'@ @($revCropPath)
    Expect 'R5.05 CropBox top reduced and text preserved' ($cropInfo -eq 'True|Page1') "got '$cropInfo'"
    Send 'action undoedit' | Out-Null
    WaitFor { (Get-CurrentRevisionIndex) -eq $expectedUndoRev } 'crop undone'
    Expect 'R5.05 undo restored initial revision' ((Get-CurrentRevisionIndex) -eq $expectedUndoRev) "got $((Get-CurrentRevisionIndex))"

    # -----------------------------------------------------------------------
    # 4. R5.06 BlankDialog (page.findBlank -> confirm -> page.removeBlank) + Undo
    # -----------------------------------------------------------------------
    Send 'action openremoveblank' | Out-Null
    WaitFor {
        $s = State
        $runBtn = Ctrl $s 'blank-dialog-run'
        return ($null -ne (Ctrl $s 'blank-dialog') -and $null -ne $runBtn -and (-not $runBtn.disabled))
    } 'blank-dialog detected blank page and enabled run'
    Expect 'R5.06 pages still 4 before confirmation' ([int](State).view.pageCount -eq 4) "got $((State).view.pageCount)"
    ClickControl 'blank-dialog-run'
    WaitFor {
        $s = State
        return ($null -eq (Ctrl $s 'blank-dialog') -and [int]$s.view.pageCount -eq 3)
    } 'blank page removed (pageCount=3)'
    Expect 'R5.06 blank page removed to 3 pages' ([int](State).view.pageCount -eq 3) "got $((State).view.pageCount)"
    Send 'action undoedit' | Out-Null
    WaitFor { [int](State).view.pageCount -eq 4 } 'blank removal undone (pageCount=4)'
    Expect 'R5.06 undo restored 4 pages' ([int](State).view.pageCount -eq 4) "got $((State).view.pageCount)"

    # -----------------------------------------------------------------------
    # 5. R5.07 GridSplitDialog (page.split) + Undo
    # -----------------------------------------------------------------------
    Send 'action opengridsplit' | Out-Null
    WaitFor {
        $s = State
        $runBtn = Ctrl $s 'grid-split-dialog-run'
        return ($null -ne (Ctrl $s 'grid-split-dialog') -and $null -ne $runBtn -and (-not $runBtn.disabled))
    } 'grid-split-dialog open and enabled'
    ClickControl 'grid-split-dialog-run'
    WaitFor {
        $s = State
        return ($null -eq (Ctrl $s 'grid-split-dialog') -and [int]$s.view.pageCount -eq 5)
    } 'grid split applied on selected page 1 (pageCount=5)'
    Expect 'R5.07 page 1 split 1x2 -> 5 pages' ([int](State).view.pageCount -eq 5) "got $((State).view.pageCount)"
    Send 'action undoedit' | Out-Null
    WaitFor { [int](State).view.pageCount -eq 4 } 'grid split undone (pageCount=4)'
    Expect 'R5.07 undo restored 4 pages' ([int](State).view.pageCount -eq 4) "got $((State).view.pageCount)"

    # -----------------------------------------------------------------------
    # 6. R5.08 SmartSplitDialog (file.splitSmart by blank separator)
    # -----------------------------------------------------------------------
    Send 'action opensmartsplit' | Out-Null
    WaitFor { $null -ne (Ctrl (State) 'smart-split-dialog') } 'smart-split-dialog open'
    ClickControl 'smart-drop'
    ClickControl 'smart-preview'
    WaitFor {
        $runBtn = Ctrl (State) 'smart-split-dialog-run'
        return ($null -ne $runBtn -and (-not $runBtn.disabled))
    } 'smart-split-dialog-run enabled after preview'
    ClickControl 'smart-split-dialog-run'
    WaitFor { $null -ne (Ctrl (State) 'smart-split-dialog-result') } 'smart-split-dialog-result'
    $smartFiles = @(Get-ChildItem -LiteralPath $outDir -Filter '*.pdf' | Sort-Object Name)
    Expect 'R5.08 smart split produced 2 files' ($smartFiles.Count -eq 2) "got $($smartFiles.Count)"
    if ($smartFiles.Count -eq 2) {
        $smartCounts = ($smartFiles | ForEach-Object {
            Run-Py 'import pikepdf,sys; print(len(pikepdf.Pdf.open(sys.argv[1]).pages))' @($_.FullName)
        }) -join ','
        Expect 'R5.08 dropped blank separator -> 1,2 pages' ($smartCounts -eq '1,2') "got '$smartCounts'"
    }
    Expect 'R5.08 main.pdf unchanged' ((Get-FileHash -LiteralPath $mainPdf -Algorithm SHA256).Hash -eq $mainHash) 'main.pdf modified'
    ClickControl 'smart-split-dialog-close'
    WaitFor { $null -eq (Ctrl (State) 'smart-split-dialog') } 'smart-split-dialog closed'

    Send 'quit' | Out-Null
    [void]$proc.WaitForExit(5000)
}
catch {
    Write-Output "ERROR: $($_.Exception.Message)"
    Write-Output "STACK: $($_.ScriptStackTrace)"
    if ($proc) { Write-Output "PROC exited=$($proc.HasExited)" }
    if (Test-Path -LiteralPath $log) {
        Write-Output "=== APP LOG ==="
        Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue | Write-Output
    }
    throw
}
finally {
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Restore-Env 'CHEF_E2E_OPEN_PDFS' $oldOpenPdfs
    Restore-Env 'CHEF_E2E_SAVE_PDF' $oldSavePdf
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Output "FAILS: $script:fails"
if ($script:fails -gt 0) { exit 1 }
exit 0
