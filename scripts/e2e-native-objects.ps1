#requires -Version 7.0
<#
.SYNOPSIS
  R4.11 E2E for page object selection, nudge and delete.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-objects-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$source = Join-Path $work 'objects.pdf'
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
function Job-Count([string]$OpId) {
    return @((State).jobs.items | Where-Object { $_.opId -eq $OpId -and $_.status -eq 'finished' }).Count
}
function Click-Page([int]$X, [int]$Y) {
    $scale = [double](State).controls.scale
    Send "click $([int]($X * $scale)) $([int]($Y * $scale))" | Out-Null
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
c.setFillColorRGB(0.2, 0.4, 0.8)
c.rect(50, 92, 510, 600, stroke=0, fill=1)
c.setFillColorRGB(0, 0, 0)
c.setFont("Helvetica", 18)
c.drawString(72, 740, "Object selection fixture")
c.save()
'@
$verifyPy = @'
import pikepdf, sys
mode, path = sys.argv[1:]
with pikepdf.open(path) as pdf:
    page = pdf.pages[0]
    rects = []
    for instr in pikepdf.parse_content_stream(page):
        if str(instr.operator) == 're':
            rects.append([float(o) for o in instr.operands])
    if mode == 'moved':
        dump = [(str(i.operator), [str(o) for o in i.operands]) for i in pikepdf.parse_content_stream(page)]
        xs = [float(o) for op, args in dump for o in args if op in ('re', 'm', 'l', 'cm')]
        assert any(abs(v - 51.0) < 0.01 for v in xs), dump
    elif mode == 'deleted':
        assert len(rects) == 0, rects
print('VERIFIED', mode)
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

    # (1) click selects the topmost object under the pointer
    Click-Page 705 400
    WaitFor { (Job-Count 'content.hitTest') -ge 1 } 'hit test on the filled rectangle'
    Start-Sleep -Milliseconds 300

    # nudge right by one point, then the object is re-selected with a fresh id
    Send 'keystroke right' | Out-Null
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $true } 'nudge revision'
    WaitFor { (Job-Count 'content.move') -ge 1 } 'move job'
    WaitFor { (Job-Count 'content.hitTest') -ge 2 } 're-selection after nudge'
    Start-Sleep -Milliseconds 300
    Save-Doc 'nudge'
    Py $verifyPy @('moved', $source)

    # (2) Delete works right after selecting (and after the id changed from the nudge)
    Send 'keystroke delete' | Out-Null
    WaitFor { (Job-Count 'content.delete') -ge 1 } 'delete job'
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $true } 'delete revision'
    Save-Doc 'delete'
    Py $verifyPy @('deleted', $source)

    # empty page click clears the selection: Delete then does nothing
    Click-Page 705 400
    WaitFor { (Job-Count 'content.hitTest') -ge 3 } 'hit test on empty area'
    Start-Sleep -Milliseconds 300
    Send 'keystroke delete' | Out-Null
    Start-Sleep -Milliseconds 500
    if ((Job-Count 'content.delete') -ne 1) { throw 'Delete acted without a selected object' }
    Write-Host 'VERIFIED no selection on empty area'

    try { Send 'quit' | Out-Null } catch { }
    Write-Output 'PASS R4.11 objects E2E'
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
