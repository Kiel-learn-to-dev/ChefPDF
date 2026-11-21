#requires -Version 7.0
<#
.SYNOPSIS
  R4.20 E2E for notes list filtering, CSV export, and flattening.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-noteslist-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$source = Join-Path $work 'notes.pdf'
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
function Type-Field([string]$ControlId, [string]$Text, [switch]$Replace) {
    Click-Control $ControlId
    if ($Replace) {
        Send 'key 36' | Out-Null # Home
        $count = [string](Control $ControlId).value
        for ($i = 0; $i -lt $count.Length + 4; $i++) { Send 'key 46' | Out-Null } # Delete
        WaitFor { (Control $ControlId).value -eq '' } "clear $ControlId"
        Click-Control $ControlId
    }
    Send "char $Text" | Out-Null
    WaitFor { (Control $ControlId).value -eq $Text } "type $ControlId"
}
function Save-Revision([string]$What) {
    if (Control 'notes-close') { Click-Control 'notes-close' }
    WaitFor { (Control 'notes-close') -eq $null } "$What dialog close"
    WaitFor { $save = Control 'viewer-save'; $null -ne $save -and -not $save.disabled } "$What save control"
    Click-Control 'viewer-save'
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $false } "$What save"
    Click-Control 'notes-manager'
    WaitFor { (Control 'notes-add') -ne $null } 'notes manager after save'
}
function Py([string]$Code, [string[]]$PyArgs) {
    Push-Location (Join-Path $repo 'core')
    try {
        $output = & uv run --no-project python -c $Code @PyArgs 2>&1
        if ($LASTEXITCODE -ne 0) { throw "python check failed: $output" }
        Write-Host $output
    } finally { Pop-Location }
}
function Assert-True($Cond, [string]$What) {
    if (-not $Cond) { throw "FAILED: $What" }
    Write-Host "VERIFIED $What"
}
$fixturePy = @'
from reportlab.pdfgen import canvas
import sys
c = canvas.Canvas(sys.argv[1], pagesize=(612, 792))
c.setFont("Helvetica", 18)
c.drawString(72, 700, "Notes list filter export flatten")
c.save()
'@
$csvPy = @'
import csv, sys
rows = list(csv.DictReader(open(sys.argv[1], encoding="utf-8-sig", newline="")))
assert len(rows) == 2, rows
joined = " ".join(" ".join(r.values()) for r in rows)
assert "Alpha" in joined and "Beta" in joined and "An" in joined and "Binh" in joined, rows
assert len(rows[0]) >= 6, list(rows[0])
print("VERIFIED CSV columns and rows", list(rows[0]))
'@
$flatPy = @'
import pikepdf, sys
with pikepdf.open(sys.argv[1]) as pdf:
    annots = [a for a in (pdf.pages[0].get('/Annots') or []) if str(a.get('/Subtype')) in ('/Text', '/FreeText')]
    assert not annots, annots
print("VERIFIED notes flattened")
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

    Click-Control 'notes-manager'
    WaitFor { (Control 'notes-add') -ne $null } 'notes manager'
    Click-Control 'notes-add'
    Type-Field 'notes-content' 'Alpha'
    Type-Field 'notes-author' 'An'
    Click-Control 'notes-apply'
    Save-Revision 'add sticky note'
    Click-Control 'notes-add-text'
    Type-Field 'notes-content' 'Beta'
    Type-Field 'notes-author' 'Binh'
    Click-Control 'notes-apply'
    Save-Revision 'add free text'
    WaitFor { (Control 'notes-row-1') -ne $null } 'two notes listed'

    Click-Control 'notes-filter-kind'
    WaitFor { (Control 'notes-row-0') -ne $null -and (Control 'notes-row-1') -eq $null } 'kind filter Text keeps one row'
    Assert-True ((Control 'notes-row-0').name -match 'Alpha') 'kind filter shows the sticky note'
    Click-Control 'notes-filter-kind'
    WaitFor { $r = Control 'notes-row-0'; $null -ne $r -and $r.name -match 'Beta' -and (Control 'notes-row-1') -eq $null } 'kind filter FreeText shows the text box'
    Click-Control 'notes-filter-kind'
    WaitFor { (Control 'notes-row-1') -ne $null } 'kind filter back to all'

    Click-Control 'notes-filter-author'
    WaitFor { $r = Control 'notes-row-0'; $null -ne $r -and $r.name -match 'Alpha' -and (Control 'notes-row-1') -eq $null } 'author filter An'
    Click-Control 'notes-filter-author'
    WaitFor { $r = Control 'notes-row-0'; $null -ne $r -and $r.name -match 'Beta' -and (Control 'notes-row-1') -eq $null } 'author filter Binh'
    Click-Control 'notes-filter-author'
    WaitFor { (Control 'notes-row-1') -ne $null } 'author filter back to all'

    $csv = Join-Path $work 'notes-notes.csv'
    Click-Control 'notes-export-csv'
    WaitFor { Test-Path -LiteralPath $csv } 'CSV file written'
    WaitFor { ((State).jobs.items | Where-Object opId -eq 'annots.export' | Select-Object -First 1).status -eq 'finished' } 'export job finished'
    Start-Sleep -Milliseconds 400
    if (-not (Control 'notes-flatten')) { Click-Control 'notes-manager' }
    WaitFor { $null -ne (Control 'notes-flatten') } 'notes manager after export'
    Py $csvPy @($csv)
    Assert-True (((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $false) 'export does not dirty the document'

    Click-Control 'notes-flatten'
    WaitFor { (Control 'notes-row-0') -eq $null } 'flatten removes notes from the list'
    if (Control 'notes-close') { Click-Control 'notes-close' }
    WaitFor { $save = Control 'viewer-save'; $null -ne $save -and -not $save.disabled } 'flatten save control'
    Click-Control 'viewer-save'
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $false } 'flatten save'
    Py $flatPy @($source)

    try { Send 'quit' | Out-Null } catch { }
    Write-Output 'PASS R4.20 notes list E2E'
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
