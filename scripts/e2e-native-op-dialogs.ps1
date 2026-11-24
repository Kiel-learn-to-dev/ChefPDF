#requires -Version 7.0
<#
.SYNOPSIS
  Windows E2E for schema-driven OpDialog (Revision, Output, Standalone modes) and PickerDialog
  opened via the command palette and executed against real chef-core.
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

$work = Join-Path $env:TEMP ('chef-native-opdialogs-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$outDir = Join-Path $work 'out'
$log = Join-Path $work 'app.log'
$samplePdf = Join-Path $work 'sample.pdf'
$extractedTxt = Join-Path $work 'sample.txt'
$compressedPdf = Join-Path $work 'sample-nen.pdf'

$oldE2E = $env:CHEF_E2E
$oldUserData = $env:CHEF_USER_DATA_DIR
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

function Open-Command([string]$Query, [string]$ExpectedTitle, [string]$DialogId) {
    Send 'action openpalette' | Out-Null
    WaitFor { $s = State; return ($s.palette.open -and $s.palette.query -eq '') } "palette open for '$Query'"
    Send "char $Query" | Out-Null
    WaitFor {
        $s = State
        return ($s.palette.query -eq $Query -and $s.palette.results.Count -gt 0 -and $s.palette.results[0].title -eq $ExpectedTitle)
    } "palette top result '$ExpectedTitle' for '$Query'"
    Send 'action submit' | Out-Null
    WaitFor { $null -ne (Ctrl (State) $DialogId) } "dialog '$DialogId' open"
}

function Get-CurrentRevisionIndex() {
    $sessionsRoot = Join-Path $dataDir 'sessions'
    $metaFile = Get-ChildItem -LiteralPath $sessionsRoot -Filter 'meta.json' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $metaFile) { return -1 }
    $meta = Get-Content -LiteralPath $metaFile.FullName -Raw | ConvertFrom-Json
    $revs = @($meta.revisions | ForEach-Object { [int]$_ })
    return [array]::IndexOf($revs, [int]$meta.revision)
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

    $settingsJson = (@{
        theme = 'light'
        language = 'vi'
        defaultSaveDir = $outDir
        recentFiles = @()
        prefs = @{}
    } | ConvertTo-Json -Depth 4)
    [System.IO.File]::WriteAllText((Join-Path $dataDir 'settings.json'), $settingsJson, [System.Text.UTF8Encoding]::new($false))

    $mkSample = @'
import pikepdf, sys
pdf = pikepdf.new()
font = pdf.make_indirect(pikepdf.Dictionary(
    Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica
))
for label in ["Hello Page 1", "Hello Page 2"]:
    pdf.add_blank_page(page_size=(612, 792))
    pg = pdf.pages[-1]
    pg.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    pg.Contents = pdf.make_stream(f"BT /F1 24 Tf 72 700 Td ({label}) Tj ET".encode())
pdf.save(sys.argv[1])
'@
    [void](Run-Py $mkSample @($samplePdf))
    $sampleHash = (Get-FileHash -LiteralPath $samplePdf -Algorithm SHA256).Hash

    $env:CHEF_E2E = '1'
    $env:CHEF_USER_DATA_DIR = $dataDir
    try {
        $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $samplePdf + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
    } finally {
        Restore-Env 'CHEF_E2E' $oldE2E
        Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
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
        return ($null -ne $s.view -and [int]$s.view.pageCount -eq 2)
    } 'initial 2-page sample.pdf loaded'

    # -----------------------------------------------------------------------
    # 1. OpMode::Revision — compress.pdf + Undo (R5.11)
    # -----------------------------------------------------------------------
    $rev0 = Get-CurrentRevisionIndex
    Open-Command 'nen pdf' 'Nén PDF' 'op-compress.pdf'
    ClickControl 'op-compress.pdf-run'
    WaitFor {
        $s = State
        $undo = Ctrl $s 'viewer-undo'
        return ($null -eq (Ctrl $s 'op-compress.pdf') -and (Get-CurrentRevisionIndex) -gt $rev0 -and $null -ne $undo -and (-not $undo.disabled))
    } 'compress.pdf applied and revision reloaded'
    Expect 'R5.11 compress.pdf created revision' ((Get-CurrentRevisionIndex) -eq 1) "got rev $((Get-CurrentRevisionIndex))"
    Send 'action undoedit' | Out-Null
    WaitFor {
        $s = State
        $undo = Ctrl $s 'viewer-undo'
        return ((Get-CurrentRevisionIndex) -eq 0 -and $null -ne $undo -and $undo.disabled)
    } 'compress.pdf undone and reloaded'
    Expect 'R5.11 undo restored rev 0' ((Get-CurrentRevisionIndex) -eq 0) "got rev $((Get-CurrentRevisionIndex))"

    # -----------------------------------------------------------------------
    # 2. OpMode::Revision — overlay.pageNumbers (R5.42)
    # -----------------------------------------------------------------------
    Open-Command 'danh so trang' 'Đánh số trang' 'op-overlay.pageNumbers'
    ClickControl 'op-overlay.pageNumbers-run'
    WaitFor {
        $s = State
        $undo = Ctrl $s 'viewer-undo'
        return ($null -eq (Ctrl $s 'op-overlay.pageNumbers') -and (Get-CurrentRevisionIndex) -eq 1 -and $null -ne $undo -and (-not $undo.disabled))
    } 'overlay.pageNumbers applied and reloaded'
    Expect 'R5.42 overlay.pageNumbers created revision' ((Get-CurrentRevisionIndex) -eq 1) "got rev $((Get-CurrentRevisionIndex))"

    # -----------------------------------------------------------------------
    # 3. PickerDialog — picker.overlays lists & removes added page numbers (R5.46)
    # -----------------------------------------------------------------------
    Open-Command 'quan ly dau da them' 'Gỡ dấu đã thêm' 'picker-overlays'
    WaitFor { $null -ne (Ctrl (State) 'picker-all') } 'picker-overlays loaded overlay list'
    ClickControl 'picker-all'
    ClickControl 'picker-overlays-run'
    WaitFor {
        $s = State
        $undo = Ctrl $s 'viewer-undo'
        return ($null -eq (Ctrl $s 'picker-overlays') -and (Get-CurrentRevisionIndex) -eq 2 -and $null -ne $undo -and (-not $undo.disabled))
    } 'picker.overlays removed selected overlay and reloaded'
    Expect 'R5.46 picker.overlays applied revision 2' ((Get-CurrentRevisionIndex) -eq 2) "got rev $((Get-CurrentRevisionIndex))"
    Send 'action undoedit' | Out-Null
    WaitFor {
        $s = State
        $undo = Ctrl $s 'viewer-undo'
        return ((Get-CurrentRevisionIndex) -eq 1 -and $null -ne $undo -and (-not $undo.disabled))
    } 'picker.overlays undone and reloaded'
    Expect 'R5.46 undo restored rev 1' ((Get-CurrentRevisionIndex) -eq 1) "got rev $((Get-CurrentRevisionIndex))"

    # -----------------------------------------------------------------------
    # 4. OpMode::Output — doc.extractText (R5.18)
    # -----------------------------------------------------------------------
    Open-Command 'trich xuat van ban' 'Trích xuất văn bản' 'op-doc.extractText'
    ClickControl 'op-doc.extractText-run'
    WaitFor { $null -ne (Ctrl (State) 'op-doc.extractText-result') } 'op-doc.extractText-result'
    Expect 'R5.18 extracted text file exists' (Test-Path -LiteralPath $extractedTxt) "missing $extractedTxt"
    if (Test-Path -LiteralPath $extractedTxt) {
        $txt = Get-Content -LiteralPath $extractedTxt -Raw
        Expect 'R5.18 extracted text contains Hello Page 1' ($txt -match 'Hello Page 1') "got '$txt'"
    }
    ClickControl 'op-doc.extractText-close'
    WaitFor { $null -eq (Ctrl (State) 'op-doc.extractText') } 'op-doc.extractText closed'

    # -----------------------------------------------------------------------
    # 5. OpMode::Standalone — compress.file (R5.11)
    # -----------------------------------------------------------------------
    Open-Command 'nen thanh file moi' 'Nén thành file mới' 'op-compress.file'
    ClickControl 'op-compress.file-run'
    WaitFor { $null -ne (Ctrl (State) 'op-compress.file-result') } 'op-compress.file-result'
    Expect 'R5.11 compressed copy exists' (Test-Path -LiteralPath $compressedPdf) "missing $compressedPdf"
    if (Test-Path -LiteralPath $compressedPdf) {
        $pages = Run-Py 'import pikepdf,sys; print(len(pikepdf.Pdf.open(sys.argv[1]).pages))' @($compressedPdf)
        Expect 'R5.11 compressed copy has 2 pages' ($pages -eq '2') "got '$pages'"
    }
    Expect 'R5.11 sample.pdf source unchanged' ((Get-FileHash -LiteralPath $samplePdf -Algorithm SHA256).Hash -eq $sampleHash) 'sample.pdf modified'
    ClickControl 'op-compress.file-close'
    WaitFor { $null -eq (Ctrl (State) 'op-compress.file') } 'op-compress.file closed'

    Send 'quit' | Out-Null
    [void]$proc.WaitForExit(5000)
}
catch {
    Write-Output "ERROR: $($_.Exception.Message)"
    Write-Output "STACK: $($_.ScriptStackTrace)"
    if ($proc) {
        Write-Output "PROC exited=$($proc.HasExited)"
        if (-not $proc.HasExited -and $script:pipe -and $script:token) {
            try {
                $dbg = State
                Write-Output ("PALETTE: " + ($dbg.palette | ConvertTo-Json -Compress))
                Write-Output ("CONTROLS: " + ((@($dbg.controls.controls | ForEach-Object { $_.id })) -join ', '))
            } catch {}
        }
    }
    if (Test-Path -LiteralPath $log) {
        Write-Output "=== APP LOG ==="
        Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue | Write-Output
    }
    throw
}
finally {
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Output "FAILS: $script:fails"
if ($script:fails -gt 0) { exit 1 }
exit 0
