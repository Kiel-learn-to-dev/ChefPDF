#requires -Version 7.0
<#
.SYNOPSIS
  R4.09 E2E for image insertion: drag placement, proportional sizing, page boundary clipping, and undo.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-insert-img-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$source = Join-Path $work 'insert_img.pdf'
$png = Join-Path $work 'red_2x1.png'
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
function Job-Count([string]$OpId) {
    return @((State).jobs.items | Where-Object { $_.opId -eq $OpId -and $_.status -eq 'finished' }).Count
}
function Pointer-Drag([double]$X1, [double]$Y1, [double]$X2, [double]$Y2) {
    $scale = [double](State).scale
    $sx = [int]([math]::Round($X1 * $scale)); $sy = [int]([math]::Round($Y1 * $scale))
    $tx = [int]([math]::Round($X2 * $scale)); $ty = [int]([math]::Round($Y2 * $scale))
    Send "pointer down $sx $sy" | Out-Null
    Start-Sleep -Milliseconds 80
    Send "pointer drag $tx $ty" | Out-Null
    Start-Sleep -Milliseconds 80
    Send "pointer up $tx $ty" | Out-Null
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
pdf_path, png_path = sys.argv[1:]
c = canvas.Canvas(pdf_path, pagesize=(612, 792))
c.showPage()
c.save()
Image.new("RGB", (100, 50), (220, 30, 30)).save(png_path)
'@

$verifyPy = @'
import pikepdf, pypdfium2 as pdfium, sys
from chef_core.content.engine import build_model

mode, path = sys.argv[1:]
with pikepdf.open(path) as pdf:
    mbox = [float(v) for v in pdf.pages[0].MediaBox]
    assert mbox == [0.0, 0.0, 612.0, 792.0], mbox
    model = build_model(pdf, pdf.pages[0], 0)
    imgs = [o for o in model.objects if o.kind == 'image']
    if mode == 'first':
        assert len(imgs) == 1, imgs
        x0, y0, x1, y1 = imgs[0].display_bbox(model.frame)
        w, h = x1 - x0, y1 - y0
        assert abs((w / h) - 2.0) < 0.05, (w, h)
        doc = pdfium.PdfDocument(path)
        pil = doc[0].render(scale=1).to_pil().convert('RGB')
        r, g, b = pil.getpixel((int((x0 + x1) / 2), int((y0 + y1) / 2)))
        assert r > 180 and g < 80, (r, g, b)
        print(f'VERIFIED first: bbox=({x0:.1f},{y0:.1f},{x1:.1f},{y1:.1f}) size={w:.1f}x{h:.1f}')
    elif mode == 'clipped':
        assert len(imgs) == 2, imgs
        bx0, by0, bx1, by1 = imgs[1].display_bbox(model.frame)
        assert bx1 > 612.0, (bx0, by0, bx1, by1)
        doc = pdfium.PdfDocument(path)
        pil = doc[0].render(scale=1).to_pil().convert('RGB')
        assert pil.size == (612, 792), pil.size
        # Check pixel right at the clipped right border (x=610)
        ys = [y for y in range(792) if pil.getpixel((610, y))[0] > 180 and pil.getpixel((610, y))[1] < 80]
        assert len(ys) > 20, f'expected clipped red edge at x=610 (bbox={(bx0,by0,bx1,by1)}), found {len(ys)} rows'
        print(f'VERIFIED clipped overflow at x=610: {len(ys)} rows, bbox=({bx0:.1f},{by0:.1f},{bx1:.1f},{by1:.1f})')
    elif mode == 'undo1':
        assert len(imgs) == 1, imgs
        print('VERIFIED undo1 keeps 1 image')
    elif mode == 'undo2':
        assert len(imgs) == 0, imgs
        print('VERIFIED undo2 removes all images')
'@

try {
    New-Item -ItemType Directory -Force -Path $work, $dataDir | Out-Null
    Py $fixturePy @($source, $png)

    $env:CHEF_E2E = '1'
    $env:CHEF_USER_DATA_DIR = $dataDir
    $env:CHEF_E2E_IMAGE_PATH = $png
    $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $source + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
    WaitFor { (Get-Content $log -Raw -ErrorAction SilentlyContinue) -match 'CHEF_DEBUG_TOKEN=' } 'debug pipe startup'
    $logText = Get-Content $log -Raw
    $script:pipe = [regex]::Match($logText, 'chef-native-\d+').Value
    $script:token = [regex]::Match($logText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value

    # 1. Insert first image proportionally
    Click-Control 'insert-image'
    WaitFor { (Control 'insert-image').name -ne '' } 'insert image active'
    Pointer-Drag 450 260 650 460
    WaitFor { (Job-Count 'overlay.addImage') -ge 1 } 'first overlay.addImage'
    Save-Doc 'first image'
    Py $verifyPy @('first', $source)

    # 2. Insert second image overflowing past page right boundary (page right ~1162 logical px)
    Click-Control 'insert-image'
    Pointer-Drag 1040 450 1280 570
    WaitFor { (Job-Count 'overlay.addImage') -ge 2 } 'clipped overlay.addImage'
    Save-Doc 'clipped image'
    Py $verifyPy @('clipped', $source)

    # 3. Undo twice
    Send 'keystroke ctrl-z' | Out-Null
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $true } 'undo 1 dirty'
    Save-Doc 'undo 1'
    Py $verifyPy @('undo1', $source)

    Send 'keystroke ctrl-z' | Out-Null
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $true } 'undo 2 dirty'
    Save-Doc 'undo 2'
    Py $verifyPy @('undo2', $source)

    try { Send 'quit' | Out-Null } catch { }
    Write-Output 'PASS R4.09 insert image E2E'
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Restore-Env 'CHEF_E2E_IMAGE_PATH' $oldImg
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
