#requires -Version 7.0
<#
.SYNOPSIS
  R4.16 E2E for the layers panel (visibility toggle, rename, flatten + undo) and content.viewByType filter.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-layers-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$source = Join-Path $work 'layers.pdf'
$log = Join-Path $work 'app.log'
$proc = $null
$oldE2E = $env:CHEF_E2E
$oldUserData = $env:CHEF_USER_DATA_DIR

function Restore-Env([string]$Name, [AllowNull()][string]$Value) {
    if ($null -eq $Value) { Remove-Item "Env:$Name" -ErrorAction SilentlyContinue }
    else { Set-Item "Env:$Name" $Value }
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
    throw "Timed out waiting for $What. $snapshot $(Get-Content $log -Raw -ErrorAction SilentlyContinue)"
}
function Click-Control([string]$Id) {
    WaitFor { $c = Control $Id; $null -ne $c -and $null -ne $c.bounds -and -not $c.disabled } "clickable bounds for $Id"
    $snapshot = State
    $control = $snapshot.controls.controls | Where-Object id -eq $Id | Select-Object -First 1
    $scale = [double]$snapshot.controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $scale)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $scale)
    Send "click $x $y" | Out-Null
    Start-Sleep -Milliseconds 150
}
function Type-Field([string]$ControlId, [string]$Text) {
    Click-Control $ControlId
    WaitFor { (Control $ControlId).focused } "focus $ControlId"
    if ((Control $ControlId).value) {
        Send 'action selectall' | Out-Null
        Start-Sleep -Milliseconds 150
        Send 'action backspace' | Out-Null
        WaitFor { (Control $ControlId).value -eq '' } "clear $ControlId"
    }
    Send "char $Text" | Out-Null
    WaitFor { (Control $ControlId).value -eq $Text } "type $ControlId"
}
function Job-Count([string]$OpId) {
    return @((State).jobs.items | Where-Object { $_.opId -eq $OpId -and $_.status -eq 'finished' }).Count
}
function Save-Doc([string]$What) {
    WaitFor { $save = Control 'viewer-save'; $null -ne $save -and -not $save.disabled } "$What save control"
    Click-Control 'viewer-save'
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $false } "$What save"
}
function Py([string]$Code, [string[]]$PyArgs) {
    Push-Location (Join-Path $repo 'core')
    try {
        $output = & uv run --no-project python -c $Code @PyArgs 2>&1
        if ($LASTEXITCODE -ne 0) { throw "python check failed: $output" }
        Write-Host $output
    } finally { Pop-Location }
}

$fixturePy = @'
import pikepdf, sys

out_path = sys.argv[1]
pdf = pikepdf.new()
page = pdf.add_blank_page(page_size=(612, 792))
ocg1 = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.OCG, Name=pikepdf.String("Watermarks")))
ocg2 = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.OCG, Name=pikepdf.String("Draft")))
pdf.Root.OCProperties = pikepdf.Dictionary(
    OCGs=pikepdf.Array([ocg1, ocg2]),
    D=pikepdf.Dictionary(
        BaseState=pikepdf.Name.ON,
        Order=pikepdf.Array([ocg1, ocg2]),
        ON=pikepdf.Array([ocg1, ocg2]),
        OFF=pikepdf.Array([]),
    ),
)
font = pikepdf.Dictionary(
    Type=pikepdf.Name.Font,
    Subtype=pikepdf.Name.Type1,
    BaseFont=pikepdf.Name.Helvetica,
)
page.Resources = pikepdf.Dictionary(
    Properties=pikepdf.Dictionary(OC1=ocg1, OC2=ocg2),
    Font=pikepdf.Dictionary(F1=font),
)
stream = b"\n".join([
    b"BT /F1 18 Tf 60 720 Td (Hello Layers) Tj ET",
    b"/OC /OC1 BDC 0.9 0.1 0.1 rg 60 560 180 120 re f EMC",
    b"/OC /OC2 BDC 0.1 0.7 0.1 rg 60 380 180 120 re f EMC",
])
page.Contents = pdf.make_stream(stream)
pdf.save(out_path)
pdf.close()
'@

$verifyPy = @'
import pikepdf, pypdfium2 as pdfium, sys

mode, path = sys.argv[1:]
with pikepdf.open(path) as pdf:
    has_oc = "/OCProperties" in pdf.Root
    names = [str(g.get("/Name", "")) for g in pdf.Root["/OCProperties"]["/OCGs"]] if has_oc else []
doc = pdfium.PdfDocument(path)
pil = doc[0].render(scale=1).to_pil().convert("RGB")
red_spot = pil.getpixel((150, 172))
green_spot = pil.getpixel((150, 352))
if mode == "hidden-watermark":
    assert has_oc, "OCProperties missing"
    assert red_spot[0] > 235 and red_spot[1] > 235 and red_spot[2] > 235, f"expected hidden red spot white, got {red_spot}"
    assert green_spot[1] > green_spot[0] + 80, f"expected green spot visible, got {green_spot}"
elif mode == "renamed":
    assert names[0] == "Brand Mark", names
elif mode == "flattened":
    assert not has_oc, "OCProperties should be removed after flatten"
    assert red_spot[0] > red_spot[1] + 80, f"expected flattened red visible, got {red_spot}"
    assert green_spot[1] > green_spot[0] + 80, f"expected flattened green visible, got {green_spot}"
elif mode == "undo-flatten":
    assert has_oc, "OCProperties should be restored by undo"
    assert names[0] == "Brand Mark", names
print(f"VERIFIED {mode}: has_oc={has_oc} names={names} red_spot={red_spot} green_spot={green_spot}")
'@

try {
    New-Item -ItemType Directory -Force -Path $work, $dataDir | Out-Null
    Py $fixturePy @($source)

    $env:CHEF_E2E = '1'
    $env:CHEF_USER_DATA_DIR = $dataDir
    $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $source + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
    WaitFor { (Get-Content $log -Raw -ErrorAction SilentlyContinue) -match 'CHEF_DEBUG_TOKEN=' } 'debug pipe startup'
    $logText = Get-Content $log -Raw
    $script:pipe = [regex]::Match($logText, 'chef-native-\d+').Value
    $script:token = [regex]::Match($logText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value

    # 1. Open layers panel & toggle Watermarks visibility (cache invalidation + immediate render + saved PDF pixel check)
    WaitFor { $c = Control 'layers-manager'; $null -ne $c -and -not $c.disabled } 'layers button'
    Click-Control 'layers-manager'
    WaitFor { $null -ne (Control 'layers-row-0') -and $null -ne (Control 'layers-row-1') } 'layers rows listed'
    $rendersBeforeToggle = (State).renders
    Click-Control 'layers-toggle-0'
    WaitFor { (Job-Count 'layers.setVisibility') -ge 1 } 'setVisibility job'
    WaitFor {
        $s = State
        $inv = $s.cacheInvalidation.changedPages
        $hasPage0 = ($null -ne $inv) -and ($inv -contains 0)
        $reRendered = ($null -ne $s.cachedPageImages.PSObject.Properties['0']) -and ($s.renders -gt $rendersBeforeToggle)
        $hasPage0 -and $reRendered
    } 'immediate cache eviction and page 0 re-render'
    WaitFor { (Control 'layers-toggle-0').name -match 'Show|Hiện' } 'toggle button updates to Show'
    Click-Control 'layers-close'
    WaitFor { $null -eq (Control 'layers-panel') -and $null -eq (Control 'layers-row-0') } 'layers panel closed for save'
    Save-Doc 'hidden-watermark'
    Py $verifyPy @('hidden-watermark', $source)

    # 2. Reopen panel, rename Watermarks -> Brand Mark, save and verify /Name persists
    Click-Control 'layers-manager'
    WaitFor { $null -ne (Control 'layers-row-0') } 'layers panel reopened'
    Click-Control 'layers-row-0'
    Type-Field 'layers-name' 'Brand Mark'
    Click-Control 'layers-rename'
    WaitFor { (Job-Count 'layers.rename') -ge 1 -and (Control 'layers-row-0').name -match 'Brand Mark' } 'layer renamed in UI'
    Click-Control 'layers-close'
    WaitFor { $null -eq (Control 'layers-row-0') } 'layers panel closed for rename save'
    Save-Doc 'renamed'
    Py $verifyPy @('renamed', $source)

    # 3. View-by-type filter (text, then path, then off)
    Click-Control 'layers-manager'
    WaitFor { $null -ne (Control 'layers-filter-text') } 'filter buttons ready'
    Click-Control 'layers-filter-text'
    WaitFor {
        $tf = (State).typeFilter
        $null -ne $tf -and ($tf.kinds -join ',') -eq 'text' -and $tf.showCount -ge 1 -and $tf.hideCount -ge 2 -and $tf.counts.text -ge 1 -and $tf.counts.path -ge 2
    } 'typeFilter text active'
    Click-Control 'layers-filter-text'
    WaitFor { $null -eq (State).typeFilter } 'typeFilter text cleared'
    Click-Control 'layers-filter-path'
    WaitFor {
        $tf = (State).typeFilter
        $null -ne $tf -and ($tf.kinds -join ',') -eq 'path' -and $tf.showCount -ge 2 -and $tf.hideCount -ge 1
    } 'typeFilter path active'
    Click-Control 'layers-filter-path'
    WaitFor { $null -eq (State).typeFilter } 'typeFilter cleared'

    # 4. Flatten layers -> saves without /OCProperties + hidden red shown again -> Ctrl+Z restores OCGs
    Click-Control 'layers-flatten'
    WaitFor { (Job-Count 'layers.flatten') -ge 1 -and $null -eq (Control 'layers-row-0') -and (Control 'layers-flatten').disabled } 'layers flattened in UI'
    Click-Control 'layers-close'
    WaitFor { $null -eq (Control 'layers-flatten') } 'layers panel closed for flatten save'
    Save-Doc 'flattened'
    Py $verifyPy @('flattened', $source)

    Send 'keystroke ctrl-z' | Out-Null
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $true } 'undo flatten dirty'
    Save-Doc 'undo-flatten'
    Py $verifyPy @('undo-flatten', $source)

    try { Send 'quit' | Out-Null } catch { }
    Write-Output 'PASS R4.16 layers and view-by-type E2E'
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
