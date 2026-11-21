#requires -Version 7.0
<#
.SYNOPSIS
  R4.14 E2E for replacing and adjusting an image inside a PDF, with crop, brightness, rotate, and undo.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-img-edit-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$source = Join-Path $work 'image_edit.pdf'
$redPng = Join-Path $work 'red.png'
$bluePng = Join-Path $work 'blue.png'
$log = Join-Path $work 'app.log'
$proc = $null
$oldE2E = $env:CHEF_E2E
$oldUserData = $env:CHEF_USER_DATA_DIR
$oldImg = $env:CHEF_E2E_IMAGE_PATH

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
    WaitFor { $c = Control $Id; $null -ne $c -and $null -ne $c.bounds } "bounds for $Id"
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
from reportlab.pdfgen import canvas
from PIL import Image
import sys
pdf_path, red_path, blue_path = sys.argv[1:]
Image.new("RGB", (80, 40), (140, 20, 20)).save(red_path)
Image.new("RGB", (80, 40), (20, 20, 140)).save(blue_path)
c = canvas.Canvas(pdf_path, pagesize=(612, 792))
c.drawImage(red_path, 150, 450, width=200, height=100)
c.save()
'@

$verifyPy = @'
import pikepdf, pypdfium2 as pdfium, sys
from chef_core.content.engine import build_model

mode, path = sys.argv[1:]
with pikepdf.open(path) as pdf:
    model = build_model(pdf, pdf.pages[0], 0)
    imgs = [o for o in model.objects if o.kind == 'image']
    assert len(imgs) == 1, imgs
    obj = imgs[0]
    x0, y0, x1, y1 = obj.display_bbox(model.frame)
    doc = pdfium.PdfDocument(path)
    pil = doc[0].render(scale=1).to_pil().convert('RGB')
    r, g, b = pil.getpixel((250, 292))
    if mode == 'replaced':
        assert abs(x0 - 150.0) < 1.0 and abs(y0 - 242.0) < 1.0 and abs((x1 - x0) - 200.0) < 1.0, (x0, y0, x1, y1)
        assert b > r + 60, (r, g, b)
        assert list(obj.pixel_size) == [80, 40], obj.pixel_size
    elif mode == 'adjusted':
        assert list(obj.pixel_size) == [40, 40], obj.pixel_size
        assert b > 160 and (r + g + b) > 250, (r, g, b)
    elif mode == 'undo1':
        assert list(obj.pixel_size) == [80, 40], obj.pixel_size
        assert b > r + 60, (r, g, b)
    elif mode == 'undo2':
        assert list(obj.pixel_size) == [80, 40], obj.pixel_size
        assert r > b + 60, (r, g, b)
    print(f'VERIFIED {mode}: pixelSize={obj.pixel_size} rgb=({r},{g},{b}) bbox=({x0:.1f},{y0:.1f},{x1:.1f},{y1:.1f})')
'@

try {
    New-Item -ItemType Directory -Force -Path $work, $dataDir | Out-Null
    Py $fixturePy @($source, $redPng, $bluePng)

    $env:CHEF_E2E = '1'
    $env:CHEF_USER_DATA_DIR = $dataDir
    $env:CHEF_E2E_IMAGE_PATH = $bluePng
    $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $source + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
    WaitFor { (Get-Content $log -Raw -ErrorAction SilentlyContinue) -match 'CHEF_DEBUG_TOKEN=' } 'debug pipe startup'
    $logText = Get-Content $log -Raw
    $script:pipe = [regex]::Match($logText, 'chef-native-\d+').Value
    $script:token = [regex]::Match($logText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value

    # 1. Select the image object (center of (150, 242, 350, 342) at 1-page zoom ~1.5163 is ~(613, 523))
    WaitFor { $c = Control 'object-select'; $null -ne $c -and -not $c.disabled } 'object select button'
    Click-Control 'object-select'
    $scale = [double](State).scale
    $px = [int](613 * $scale)
    $py = [int](523 * $scale)
    Send "click $px $py" | Out-Null
    WaitFor { $null -ne (State).objectSelection -and $null -ne (Control 'image-replace') } 'image selected and replace button visible'

    # 2. Replace red image with blue image, keeping box position & size
    Click-Control 'image-replace'
    WaitFor { (Job-Count 'content.replaceImage') -ge 1 -and (Job-Count 'content.hitTest') -ge 2 } 'replaceImage + rehit'
    Save-Doc 'replaced'
    Py $verifyPy @('replaced', $source)

    # 3. Adjust brightness (+50), rotate 90, crop 0,0,40,40
    Click-Control 'image-adjust'
    WaitFor { (Control 'image-adjust-apply') -ne $null } 'image adjust dialog open'
    Click-Control 'image-brightness-up'
    Click-Control 'image-brightness-up'
    Click-Control 'image-rotate'
    Type-Field 'image-crop' '0,0,40,40'
    Click-Control 'image-adjust-apply'
    WaitFor { (Job-Count 'content.adjustImage') -ge 1 -and (Job-Count 'content.hitTest') -ge 3 } 'adjustImage + rehit'
    Save-Doc 'adjusted'
    Py $verifyPy @('adjusted', $source)

    # 4. Undo twice: restored to 80x40 blue, then 80x40 red
    Send 'keystroke ctrl-z' | Out-Null
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $true } 'undo 1 dirty'
    Save-Doc 'undo 1'
    Py $verifyPy @('undo1', $source)

    Send 'keystroke ctrl-z' | Out-Null
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $true } 'undo 2 dirty'
    Save-Doc 'undo 2'
    Py $verifyPy @('undo2', $source)

    try { Send 'quit' | Out-Null } catch { }
    Write-Output 'PASS R4.14 image edit E2E'
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Restore-Env 'CHEF_E2E_IMAGE_PATH' $oldImg
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
