#requires -Version 7.0
<#
.SYNOPSIS
  R4.12 E2E for object drag-move, Shift proportional resize handles, rotate handle, and undo.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-handles-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$source = Join-Path $work 'handles.pdf'
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
function Pointer-Drag([double]$X1, [double]$Y1, [double]$X2, [double]$Y2, [string]$Mods = '') {
    $scale = [double](State).scale
    $sx = [int]([math]::Round($X1 * $scale)); $sy = [int]([math]::Round($Y1 * $scale))
    $tx = [int]([math]::Round($X2 * $scale)); $ty = [int]([math]::Round($Y2 * $scale))
    $suffix = if ($Mods) { " $Mods" } else { "" }
    Send "pointer down $sx $sy$suffix" | Out-Null
    Start-Sleep -Milliseconds 80
    Send "pointer drag $tx $ty$suffix" | Out-Null
    Start-Sleep -Milliseconds 80
    Send "pointer up $tx $ty$suffix" | Out-Null
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
import pikepdf, sys
c = canvas.Canvas(sys.argv[1], pagesize=(612, 792))
c.setFillColorRGB(0.15, 0.35, 0.85)
c.rect(150, 350, 200, 100, stroke=0, fill=1)
c.showPage()
c.setFillColorRGB(0.85, 0.2, 0.2)
c.rect(200, 300, 120, 60, stroke=0, fill=1)
c.save()
with pikepdf.open(sys.argv[1], allow_overwriting_input=True) as pdf:
    pdf.pages[1].obj.Rotate = 90
    pdf.save(sys.argv[1])
'@

$verifyPy = @'
import pikepdf, sys
from pathlib import Path
from chef_core.content.engine import build_model

mode, path = sys.argv[1:]
with pikepdf.open(path) as pdf:
    model = build_model(pdf, pdf.pages[0], 0)
    objs = [o for o in model.objects if o.kind == 'path']
    assert len(objs) == 1, objs
    x0, y0, x1, y1 = objs[0].display_bbox(model.frame)
    w, h = x1 - x0, y1 - y0
    if mode == 'moved':
        assert x0 > 155.0 and y0 > 345.0, (x0, y0, x1, y1)
        assert abs(w - 200.0) < 0.5 and abs(h - 100.0) < 0.5, (w, h)
    elif mode == 'resized':
        assert w > 220.0 and h > 110.0, (w, h)
        assert abs((w / h) - 2.0) < 0.05, f'aspect ratio drifted: {w}/{h}={w/h}'
    elif mode == 'rotated':
        assert abs((h / w) - 2.0) < 0.05, f'expected 90deg rotated 1:2 aspect, got {w}x{h}'
    elif mode == 'undone':
        assert abs((w / h) - 2.0) < 0.05, f'undo did not restore 2:1 aspect, got {w}x{h}'
print(f'VERIFIED {mode}: bbox=({x0:.1f},{y0:.1f},{x1:.1f},{y1:.1f}) size={w:.1f}x{h:.1f}')
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

    WaitFor { $c = Control 'object-select'; $null -ne $c -and -not $c.disabled } 'object select button'
    Click-Control 'object-select'
    WaitFor { (Control 'object-select').name -match 'Bật|On' } 'object mode on'

    # 1. Click center of the 200x100 blue rectangle (displayed bbox [150, 342, 350, 442])
    # At fit-width zoom ~1.17, rect center in window logical px is ~(639, 539)
    $st0 = State
    $scale0 = [double]$st0.scale
    $pxClick = [int](640 * $scale0)
    $pyClick = [int](540 * $scale0)
    Send "click $pxClick $pyClick" | Out-Null
    WaitFor { $null -ne (State).objectSelection } 'initial object selection'

    # 2. Drag body by (+40, +30) logical px
    $sel1 = (State).objectSelection
    $bx = [double]$sel1.handles.body[0]; $by = [double]$sel1.handles.body[1]
    Pointer-Drag $bx $by ($bx + 40.0) ($by + 30.0)
    WaitFor { (Job-Count 'content.move') -ge 1 -and (Job-Count 'content.hitTest') -ge 2 } 'body drag move + rehit'
    Save-Doc 'moved'
    Py $verifyPy @('moved', $source)

    # 3. Drag SE handle asymmetrically (+90, +15) with Shift held -> proportional 2:1 resize
    WaitFor { $null -ne (State).objectSelection } 'selection refreshed after move'
    $sel2 = (State).objectSelection
    $sx = [double]$sel2.handles.se[0]; $sy = [double]$sel2.handles.se[1]
    Pointer-Drag $sx $sy ($sx + 90.0) ($sy + 15.0) 'shift'
    WaitFor { (Job-Count 'content.transform') -ge 1 -and (Job-Count 'content.hitTest') -ge 3 } 'shift resize + rehit'
    Save-Doc 'resized'
    Py $verifyPy @('resized', $source)

    # 4. Drag Rotate knob 90 deg CW around center
    WaitFor { $null -ne (State).objectSelection } 'selection refreshed after resize'
    $sel3 = (State).objectSelection
    $rx = [double]$sel3.handles.rotate[0]; $ry = [double]$sel3.handles.rotate[1]
    $cx = [double]$sel3.handles.body[0]; $cy = [double]$sel3.handles.body[1]
    $tx = $cx + ($cy - $ry)
    $ty = $cy
    Pointer-Drag $rx $ry $tx $ty
    WaitFor { (Job-Count 'content.transform') -ge 2 -and (Job-Count 'content.hitTest') -ge 4 } 'rotate + rehit'
    Save-Doc 'rotated'
    Py $verifyPy @('rotated', $source)

    # 5. Undo restores 2:1 aspect ratio
    Send 'keystroke ctrl-z' | Out-Null
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $true } 'undo rotate revision'
    Save-Doc 'undone'
    Py $verifyPy @('undone', $source)

    try { Send 'quit' | Out-Null } catch { }
    Write-Output 'PASS R4.12 handles E2E'
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
