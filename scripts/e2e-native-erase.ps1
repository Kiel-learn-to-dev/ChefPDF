#requires -Version 7.0
<#
.SYNOPSIS
  R4.13 E2E for the erase-region tool and its undo.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-erase-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$source = Join-Path $work 'erase.pdf'
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
function Py([string]$Code, [string[]]$PyArgs) {
    Push-Location (Join-Path $repo 'core')
    try {
        $output = & uv run --no-project python -c $Code @PyArgs 2>&1
        if ($LASTEXITCODE -ne 0) { throw "python check failed: $output" }
        Write-Host $output
    } finally { Pop-Location }
}
function Draw-Drag([int]$X1, [int]$Y1, [int]$X2, [int]$Y2, [string]$What) {
    $scale = [double](State).controls.scale
    $sx = [int]($X1 * $scale); $sy = [int]($Y1 * $scale)
    $tx = [int]($X2 * $scale); $ty = [int]($Y2 * $scale)
    Send "mouse down $sx $sy" | Out-Null
    Start-Sleep -Milliseconds 70
    Send "mouse move $tx $ty" | Out-Null
    Start-Sleep -Milliseconds 70
    Send "mouse up $tx $ty" | Out-Null
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $true } "$What revision"
    Start-Sleep -Milliseconds 250
    WaitFor { -not (Control 'draw-tool').disabled } "$What operation complete"
}
function Save-Doc([string]$What) {
    WaitFor { $save = Control 'viewer-save'; $null -ne $save -and -not $save.disabled } "$What save control"
    Click-Control 'viewer-save'
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $false } "$What save"
}
$fixturePy = @'
from reportlab.pdfgen import canvas
import sys
c = canvas.Canvas(sys.argv[1], pagesize=(612, 792))
c.setFont("Helvetica-Bold", 100)
c.drawString(56, 560, "MMMM")
c.save()
'@
$verifyPy = @'
import pypdfium2 as pdfium, sys
mode, path = sys.argv[1:]
pdf = pdfium.PdfDocument(path)
img = pdf[0].render(scale=1).to_pil().convert('L')
def dark(x0, y0, x1, y1):
    return sum(1 for x in range(x0, x1) for y in range(y0, y1) if img.getpixel((x, y)) < 128)
inner = dark(200, 170, 360, 225)
left = dark(60, 170, 120, 225)
if mode == 'erased':
    assert inner == 0, f'erased region still has {inner} dark pixels'
    assert left > 50, f'text outside the region was damaged ({left})'
else:
    assert inner > 50, f'undo did not restore the text ({inner})'
print('VERIFIED', mode, inner, left)
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

    WaitFor { $c = Control 'draw-tool'; $null -ne $c -and -not $c.disabled } 'draw tool button'
    for ($i = 0; $i -lt 6; $i++) { Click-Control 'draw-tool'; Start-Sleep -Milliseconds 150 }
    WaitFor { (Control 'draw-tool').name -match 'Erase|Tẩy' } 'erase tool selected'

    Draw-Drag 500 330 900 520 'erase region'
    Save-Doc 'erase'
    Py $verifyPy @('erased', $source)

    # undo restores the text
    Send 'keystroke ctrl-z' | Out-Null
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $true } 'undo revision'
    Save-Doc 'undo'
    Py $verifyPy @('undone', $source)

    try { Send 'quit' | Out-Null } catch { }
    Write-Output 'PASS R4.13 erase E2E'
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
