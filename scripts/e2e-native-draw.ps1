#requires -Version 7.0
<#
.SYNOPSIS
  R4.19 drawing E2E: create five tools on a scanned rotated page and verify the saved annotations.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-draw-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$source = Join-Path $work 'draw.pdf'
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
        if ($proc -and $proc.HasExited) { throw "chef-app exited waiting for $What. $(Get-Content $log -Raw)" }
        if (& $Predicate) { return }
        Start-Sleep -Milliseconds 120
    }
    $snapshot = if ($script:pipe -and $script:token) { State } else { $null }
    $active = $snapshot.tabs | Where-Object active | Select-Object -First 1
    $tool = $snapshot.controls.controls | Where-Object id -eq 'draw-tool' | Select-Object -First 1
    throw "Timed out waiting for $What (dirty=$($active.dirty); tool=$($tool.name)). $(Get-Content $log -Raw -ErrorAction SilentlyContinue)"
}
function Click-Control([string]$Id) {
    WaitFor { $c = Control $Id; $null -ne $c -and $null -ne $c.bounds } "bounds for $Id"
    $snapshot = State
    $control = $snapshot.controls.controls | Where-Object id -eq $Id | Select-Object -First 1
    $scale = [double]$snapshot.controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $scale)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $scale)
    Send "click $x $y" | Out-Null
}
function Draw-Drag([int]$X1, [int]$Y1, [int]$X2, [int]$Y2, [string]$What) {
    $scale = [double](State).controls.scale
    $sx = [int]($X1 * $scale)
    $sy = [int]($Y1 * $scale)
    $tx = [int]($X2 * $scale)
    $ty = [int]($Y2 * $scale)
    Send "mouse down $sx $sy" | Out-Null
    Start-Sleep -Milliseconds 70
    Send "mouse move $tx $ty" | Out-Null
    Start-Sleep -Milliseconds 70
    Send "mouse up $tx $ty" | Out-Null
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $true } "$What revision"
    Start-Sleep -Milliseconds 250
    WaitFor { -not (Control 'draw-tool').disabled } "$What operation complete"
}
function Verify-Pdf {
    $verify = @'
import pikepdf, sys
with pikepdf.open(sys.argv[1]) as pdf:
    annots = list(pdf.pages[0].get('/Annots') or [])
    shapes = [a for a in annots if str(a.get('/Subtype')) in ('/Square', '/Line', '/Circle', '/Ink')]
    assert len(shapes) == 5, f'expected five shapes, found {len(shapes)}'
    subtypes = [str(a.get('/Subtype')) for a in shapes]
    assert subtypes.count('/Square') == 1, subtypes
    assert subtypes.count('/Circle') == 1, subtypes
    assert subtypes.count('/Ink') == 1, subtypes
    lines = [a for a in shapes if str(a.get('/Subtype')) == '/Line']
    assert len(lines) == 2 and any(str(a.get('/LE', [])[1]) == '/OpenArrow' for a in lines), lines
    by_subtype = {str(a.get('/Subtype')): a for a in shapes if str(a.get('/Subtype')) != '/Line'}
    square = [float(v) for v in by_subtype['/Square'].get('/Rect')]
    circle = [float(v) for v in by_subtype['/Circle'].get('/Rect')]
    ink = [float(v) for v in by_subtype['/Ink'].get('/Rect')]
    assert 80 <= square[2] - square[0] <= 90 and 80 <= square[3] - square[1] <= 90, square
    assert 64 <= circle[2] - circle[0] <= 74 and 80 <= circle[3] - circle[1] <= 90, circle
    assert 50 <= ink[2] - ink[0] <= 65 and 125 <= ink[3] - ink[1] <= 145, ink
    for line in lines:
        rect = [float(v) for v in line.get('/Rect')]
        if str(line.get('/LE', [])[1]) == '/OpenArrow':
            assert 75 <= rect[2] - rect[0] <= 90 and 90 <= rect[3] - rect[1] <= 105, rect
        else:
            assert 90 <= rect[2] - rect[0] <= 105 and 90 <= rect[3] - rect[1] <= 105, rect
    expected = [21 / 255, 101 / 255, 192 / 255]
    for shape in shapes:
        rect = [float(v) for v in shape.get('/Rect')]
        assert rect[2] > rect[0] and rect[3] > rect[1], rect
        assert float(shape['/BS']['/W']) == 4.0
        color = [float(v) for v in shape.get('/C')]
        assert all(abs(a - b) < 0.01 for a, b in zip(color, expected)), color
import numpy as np
import pypdfium2 as pdfium
with pdfium.PdfDocument(sys.argv[1]) as doc:
    pixels = doc[0].render(scale=1.5, rev_byteorder=True, draw_annots=True).to_numpy()
    blue = (pixels[:, :, 0] < 70) & (pixels[:, :, 1] > 65) & (pixels[:, :, 2] > 130)
    assert int(blue.sum()) > 100, f'PDFium did not render the blue annotation appearance: {int(blue.sum())}'
print('VERIFIED saved drawing geometry/style and PDFium appearance')
'@
    Push-Location (Join-Path $repo 'core')
    try {
        $output = & uv run --no-project python -c $verify $source 2>&1
        if ($LASTEXITCODE -ne 0) { throw "PDF draw verification failed: $output" }
        Write-Host $output
    } finally { Pop-Location }
}

try {
    New-Item -ItemType Directory -Force -Path $work, $dataDir | Out-Null
    $fixture = @'
from reportlab.pdfgen import canvas
import pikepdf
import sys
c = canvas.Canvas(sys.argv[1], pagesize=(612, 792))
c.showPage()
c.save()
with pikepdf.open(sys.argv[1], allow_overwriting_input=True) as pdf:
    pdf.pages[0].obj.Rotate = 90
    pdf.save(sys.argv[1])
'@
    Push-Location (Join-Path $repo 'core')
    try {
        & uv run --no-project python -c $fixture $source
        if ($LASTEXITCODE -ne 0) { throw 'draw fixture generation failed' }
    } finally { Pop-Location }

    $env:CHEF_E2E = '1'
    $env:CHEF_USER_DATA_DIR = $dataDir
    $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $source + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
    WaitFor { (Get-Content $log -Raw -ErrorAction SilentlyContinue) -match 'CHEF_DEBUG_TOKEN=' } 'debug pipe startup'
    $logText = Get-Content $log -Raw
    $script:pipe = [regex]::Match($logText, 'chef-native-\d+').Value
    $script:token = [regex]::Match($logText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value

    Click-Control 'draw-color'
    WaitFor { (Control 'draw-color').name -match '#1565C0' } 'cycle draw color'
    Click-Control 'draw-width'
    WaitFor { (Control 'draw-width').name -match '4' } 'cycle draw width'
    Click-Control 'draw-tool'
    WaitFor { (Control 'draw-tool').name -match 'Rectangle|Chữ nhật' } 'select rectangle tool'
    Draw-Drag 350 250 450 350 'rectangle'
    Click-Control 'draw-tool'
    WaitFor { (Control 'draw-tool').name -match 'Line|Đường thẳng' } 'select line tool'
    Draw-Drag 520 250 620 350 'line'
    Click-Control 'draw-tool'
    WaitFor { (Control 'draw-tool').name -match 'Arrow|Mũi tên' } 'select arrow tool'
    Draw-Drag 350 380 450 460 'arrow'
    Click-Control 'draw-tool'
    WaitFor { (Control 'draw-tool').name -match 'Ellipse|Elip' } 'select ellipse tool'
    Draw-Drag 520 380 620 460 'ellipse'
    Click-Control 'draw-tool'
    WaitFor { (Control 'draw-tool').name -match 'Pen|Bút' } 'select pen tool'
    Draw-Drag 350 500 500 560 'pen'
    Send 'key 27' | Out-Null
    WaitFor { (Control 'draw-tool').name -match 'Off|Tắt' } 'cancel drawing mode'
    Click-Control 'viewer-save'
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $false } 'rectangle save'
    Verify-Pdf
    Write-Output 'PASS R4.19 drawing E2E'
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
