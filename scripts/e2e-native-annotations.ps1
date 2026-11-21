#requires -Version 7.0
<#
.SYNOPSIS
  E2E for text markup creation, persistence, and undo (R4.17).
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-annotations-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$source = Join-Path $work 'markup.pdf'
$log = Join-Path $work 'app.log'
$proc = $null
$pipe = $null
$token = $null
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
        if (-not $line -and $Command -eq 'quit') { return $null }
        if (-not $line) { throw "No response to debug command '$Command'." }
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
    throw "Timed out waiting for $What. $(Get-Content $log -Raw -ErrorAction SilentlyContinue)"
}
function Click-Control([string]$Id) {
    WaitFor { $c = Control $Id; $null -ne $c -and $null -ne $c.bounds } "bounds for $Id"
    $snapshot = State
    $control = $snapshot.controls.controls | Where-Object id -eq $Id | Select-Object -First 1
    $scale = [double]$snapshot.controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $scale)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $scale)
    Send "click $x $y" | Out-Null
    Start-Sleep -Milliseconds 200
}
function Verify-Markup([int]$Expected, [string]$Kind) {
    $verify = @'
import pikepdf, sys
with pikepdf.open(sys.argv[1]) as pdf:
    marks = [a for page in pdf.pages for a in (page.get('/Annots') or []) if str(a.get('/Subtype')) in ('/Highlight', '/Underline', '/StrikeOut')]
    if len(marks) != int(sys.argv[2]):
        raise SystemExit(f"expected {sys.argv[2]} markup annotations, found {len(marks)}")
    per_page = [sum(1 for a in (page.get('/Annots') or []) if str(a.get('/Subtype')) in ('/Highlight', '/Underline', '/StrikeOut')) for page in pdf.pages]
    expected_per_page = 0 if int(sys.argv[2]) == 0 else 2
    if len(per_page) != 2 or any(count != expected_per_page for count in per_page):
        raise SystemExit(f"expected {expected_per_page} markup annotations on each of two pages, found {per_page}")
    expected = {'highlight': '/Highlight', 'underline': '/Underline', 'strike': '/StrikeOut'}[sys.argv[3]]
    for mark in marks:
        if not mark.get('/QuadPoints') or len(mark.get('/QuadPoints')) < 8:
            raise SystemExit('markup has no usable QuadPoints')
        if str(mark.get('/Subtype')) != expected:
            raise SystemExit(f"expected {expected}, found {mark.get('/Subtype')}")
        if len(mark.get('/C') or []) != 3:
            raise SystemExit('markup has no saved color')
    if marks and len({tuple(round(float(c), 5) for c in mark['/C']) for mark in marks}) != 1:
        raise SystemExit('multi-line markup annotations have inconsistent colors')
    if marks:
        page = pdf.pages[0]
        width = float(page.mediabox[2] - page.mediabox[0])
        height = float(page.mediabox[3] - page.mediabox[1])
        for mark in marks:
            points = [float(v) for v in mark['/QuadPoints']]
            if any(not (0 <= x <= width and 0 <= y <= height) for x, y in zip(points[0::2], points[1::2])):
                raise SystemExit('markup geometry is outside the rotated page bounds')
    if marks:
        colour = ''.join(f"{round(float(c) * 255):02X}" for c in marks[0]['/C'])
        opacity = float(marks[0].get('/CA', 1.0))
        print(f"MARKUP_COLOR=#{colour};OPACITY={opacity:.4f}")
'@
    Push-Location (Join-Path $repo 'core')
    try {
        $output = & uv run --no-project python -c $verify $source $Expected $Kind 2>&1
        if ($LASTEXITCODE -ne 0) { throw "PDF markup verification failed: $output" }
        if ($Expected -eq 0) { Write-Host 'Verified no markup annotations'; return '' }
        $colorLine = $output | Where-Object { $_ -like 'MARKUP_COLOR=*' } | Select-Object -First 1
        Write-Host $colorLine
        return ([string]$colorLine).Substring('MARKUP_COLOR='.Length)
    } finally { Pop-Location }
}

try {
    New-Item -ItemType Directory -Force -Path $work, $dataDir | Out-Null
    $fixture = @'
from reportlab.pdfgen import canvas
import pikepdf
import sys
c = canvas.Canvas(sys.argv[1], pagesize=(612, 792))
c.setFont("Helvetica", 24)
c.drawString(72, 700, "Native text markup")
c.drawString(72, 660, "sample second line")
c.showPage()
c.setFont("Helvetica", 24)
c.drawString(72, 700, "Markup on page two")
c.drawString(72, 660, "second page line")
c.save()
with pikepdf.open(sys.argv[1], allow_overwriting_input=True) as pdf:
    for page in pdf.pages:
        page.Rotate = 90
    pdf.save(sys.argv[1])
'@
    Push-Location (Join-Path $repo 'core')
    try {
        & uv run --no-project python -c $fixture $source
        if ($LASTEXITCODE -ne 0) { throw 'text fixture generation failed' }
    } finally { Pop-Location }

    $env:CHEF_E2E = '1'
    $env:CHEF_USER_DATA_DIR = $dataDir
    $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $source + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
    WaitFor { (Get-Content $log -Raw -ErrorAction SilentlyContinue) -match 'CHEF_DEBUG_TOKEN=' } 'debug pipe startup'
    $logText = Get-Content $log -Raw
    $pipe = [regex]::Match($logText, 'chef-native-\d+').Value
    $token = [regex]::Match($logText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    if (-not $pipe -or -not $token) { throw 'debug pipe/token missing from app log' }

    Send 'action selectalltextdocument' | Out-Null
    WaitFor { (Control 'markup-highlight') -ne $null } 'selected text markup controls'
    foreach ($kind in @('highlight', 'underline', 'strike')) {
        Click-Control "markup-$kind"
        WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $true } "$kind revision"
        Click-Control 'viewer-save'
        WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $false } "$kind save"
        $originalColor = Verify-Markup 4 $kind

        if ($kind -eq 'highlight') {
            Click-Control 'markup-change-color'
            WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $true } 'highlight color revision'
            Click-Control 'viewer-save'
            WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $false } 'highlight color save'
            $changedColor = Verify-Markup 4 'highlight'
            $originalParts = $originalColor -split ';OPACITY='
            $changedParts = $changedColor -split ';OPACITY='
            if ($changedParts[0] -ne '#FF8A00' -or
                [math]::Abs([double]$originalParts[1] - [double]$changedParts[1]) -gt 0.0001) {
                throw "highlight color did not change as expected: $originalColor -> $changedColor"
            }
            Click-Control 'viewer-undo'
            WaitFor { (Control 'viewer-undo').disabled -eq $false } 'undo highlight color change'
            Click-Control 'viewer-save'
            WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $false } 'save restored highlight color'
            $restoredColor = Verify-Markup 4 'highlight'
            if ($restoredColor -ne $originalColor) {
                throw "undo did not restore the highlight color: $originalColor -> $restoredColor"
            }
        }

        Click-Control 'viewer-undo'
        WaitFor { (Control 'viewer-undo').disabled -eq $true } "$kind undo"
        Click-Control 'viewer-save'
        WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $false } "$kind undo save"
        $emptyColor = Verify-Markup 0 $kind
    }

    Send 'quit' | Out-Null
    Write-Output 'PASS R4.17 text markup E2E'
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
