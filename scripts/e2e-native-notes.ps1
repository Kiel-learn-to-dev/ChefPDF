#requires -Version 7.0
<#
.SYNOPSIS
  R4.18 E2E for sticky note creation/edit, replies, completion status, and free text.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-notes-' + [guid]::NewGuid().ToString('N'))
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
function Verify-Pdf([string]$Mode) {
    $verify = @'
import pikepdf, sys
mode, path = sys.argv[1:]
with pikepdf.open(path) as pdf:
    annots = list(pdf.pages[0].get('/Annots') or [])
    notes = [a for a in annots if str(a.get('/Subtype')) == '/Text']
    texts = [a for a in annots if str(a.get('/Subtype')) == '/FreeText']
    root = next((a for a in notes if str(a.get('/Contents')) in ('First comment', 'Edited comment')), None)
    if mode == 'created':
        assert len(notes) == 1 and str(notes[0].get('/Contents')) == 'First comment'
        assert str(notes[0].get('/T')) == ''
    elif mode == 'edited':
        assert root is not None and str(root.get('/Contents')) == 'Edited comment'
        assert str(root.get('/T')) == 'Binh'
    elif mode == 'replied':
        assert root is not None
        children = [a for a in notes if a.get('/IRT') == root]
        assert len(children) == 1 and str(children[0].get('/Contents')) == 'Reply text'
    elif mode == 'completed':
        assert root is not None and str(root.get('/State')) == '/Completed'
        assert str(root.get('/StateModel')) == '/Review'
    elif mode == 'free-text':
        assert len(texts) == 1 and str(texts[0].get('/Contents')) == 'Text box content'
print(f'VERIFIED {mode}')
'@
    Push-Location (Join-Path $repo 'core')
    try {
        $output = & uv run --no-project python -c $verify $Mode $source 2>&1
        if ($LASTEXITCODE -ne 0) { throw "PDF note verification failed: $output" }
        Write-Host $output
    } finally { Pop-Location }
}

try {
    New-Item -ItemType Directory -Force -Path $work, $dataDir | Out-Null
    $fixture = @'
from reportlab.pdfgen import canvas
import sys
c = canvas.Canvas(sys.argv[1], pagesize=(612, 792))
c.setFont("Helvetica", 18)
c.drawString(72, 700, "Sticky notes persist with author and replies")
c.save()
'@
    Push-Location (Join-Path $repo 'core')
    try {
        & uv run --no-project python -c $fixture $source
        if ($LASTEXITCODE -ne 0) { throw 'note fixture generation failed' }
    } finally { Pop-Location }

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
    Type-Field 'notes-content' 'First comment'
    Click-Control 'notes-apply'
    Save-Revision 'add sticky note'
    Verify-Pdf 'created'

    Click-Control 'notes-row-0'
    Type-Field 'notes-content' 'Edited comment' -Replace
    Type-Field 'notes-author' 'Binh'
    Click-Control 'notes-apply'
    Save-Revision 'edit sticky note'
    Verify-Pdf 'edited'

    Click-Control 'notes-row-0'
    Click-Control 'notes-reply'
    Type-Field 'notes-content' 'Reply text'
    Click-Control 'notes-apply'
    Save-Revision 'reply to note'
    Verify-Pdf 'replied'

    Click-Control 'notes-row-0'
    Click-Control 'notes-complete'
    WaitFor {
        $row = Control 'notes-row-0'
        $complete = Control 'notes-complete'
        $null -ne $row -and $row.name -match 'completed' -and $null -ne $complete -and $complete.disabled
    } 'completed note refresh and stale selection cleared'
    Save-Revision 'complete note'
    Verify-Pdf 'completed'

    Click-Control 'notes-add-text'
    Type-Field 'notes-content' 'Text box content'
    Type-Field 'notes-author' 'An'
    Click-Control 'notes-apply'
    Save-Revision 'add free text'
    Verify-Pdf 'free-text'

    Click-Control 'notes-close'
    try { Send 'quit' | Out-Null } catch { }
    if ($proc -and -not $proc.WaitForExit(10000)) {
        Stop-Process -Id $proc.Id -Force
    }
    $proc = $null
    $log = Join-Path $work 'reopen.log'
    $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $source + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
    WaitFor { (Get-Content $log -Raw -ErrorAction SilentlyContinue) -match 'CHEF_DEBUG_TOKEN=' } 'reopen debug pipe startup'
    $logText = Get-Content $log -Raw
    $script:pipe = [regex]::Match($logText, 'chef-native-\d+').Value
    $script:token = [regex]::Match($logText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    Click-Control 'notes-manager'
    WaitFor { (Control 'notes-row-0') -ne $null } 'notes after reopening document'
    Click-Control 'notes-row-0'
    WaitFor {
        $content = Control 'notes-content'
        $author = Control 'notes-author'
        $null -ne $content -and $content.value -eq 'Edited comment' -and $null -ne $author -and $author.value -eq 'Binh'
    } 'reopened note content and author'
    Write-Host 'VERIFIED reopened note content and author'

    Write-Output 'PASS R4.18 notes E2E'
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
