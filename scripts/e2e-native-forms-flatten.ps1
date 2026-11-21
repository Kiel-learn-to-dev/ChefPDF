#requires -Version 7.0
<#
.SYNOPSIS
  R4.24 E2E: PDF form flattening (auto-applying unsaved fill edits after confirmation,
  cancel preservation, Undo/Redo, Ctrl+S save, pikepdf/pypdfium2 disk verification,
  clean PDF reopen + full-text find with 0 chef-core, and Command Palette forms.flatten
  preserving unsigned /FT /Sig signature fields).
.DESCRIPTION
  Windows only. Runs off-screen through the authenticated debug pipe.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-forms-flatten-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$editablePdf = Join-Path $work 'flatten-editable.pdf'
$signedFieldPdf = Join-Path $work 'flatten-with-sig.pdf'
$proc = $null
$script:fails = 0
$script:pipe = $null
$script:token = $null
$script:log = Join-Path $work 'app.log'

$oldE2E = $env:CHEF_E2E
$oldUserData = $env:CHEF_USER_DATA_DIR
$oldSaveAs = $env:CHEF_E2E_SAVE_AS_PATH

function Restore-Env([string]$Name, [AllowNull()][string]$Value) {
    if ($null -eq $Value) { Remove-Item "Env:$Name" -ErrorAction SilentlyContinue }
    else { Set-Item "Env:$Name" $Value }
}

function Expect([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) {
        Write-Output "PASS $Name"
    } else {
        $script:fails++
        Write-Output "FAIL $Name -- $Detail"
    }
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
        if (-not $line) { throw "No response to '$Command'." }
        $response = $line | ConvertFrom-Json
        if ($response.PSObject.Properties['ok'] -and $response.ok -eq $false) {
            throw "Debug command failed: $Command -- $($response.error)"
        }
        return $line
    } finally { $client.Dispose() }
}

function State() { return (Send 'state' | ConvertFrom-Json) }

function WaitFor([scriptblock]$Predicate, [string]$What, [int]$Seconds = 45) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($proc -and $proc.HasExited) {
            throw "chef-app exited ($($proc.ExitCode)) waiting for $What. $(Get-Content $script:log -Raw -ErrorAction SilentlyContinue)"
        }
        if (& $Predicate) { return }
        Start-Sleep -Milliseconds 120
    }
    $snapshot = if ($script:pipe -and $script:token) { Send 'state' } else { 'state unavailable' }
    throw "Timed out waiting for $What. $snapshot"
}

function Click-Control([string]$Id) {
    $script:targetControl = $null
    $script:targetSnapshot = $null
    WaitFor {
        $snap = State
        $c = $snap.controls.controls | Where-Object { $_.id -eq $Id -and $null -ne $_.bounds -and (-not $_.disabled) } | Select-Object -First 1
        if ($null -ne $c) {
            $script:targetSnapshot = $snap
            $script:targetControl = $c
            return $true
        }
        return $false
    } "clickable bounds for $Id" 15
    $snapshot = $script:targetSnapshot
    $control = $script:targetControl
    $scale = [double]$snapshot.controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $scale)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $scale)
    Send "click $x $y" | Out-Null
    Start-Sleep -Milliseconds 120
}

function Control-Disabled($Snap, [string]$Id) {
    $c = $Snap.controls.controls | Where-Object { $_.id -eq $Id } | Select-Object -First 1
    if ($null -eq $c) { return $true }
    return [bool]$c.disabled
}

function Field-ByName($Snap, [string]$Name) {
    return ($Snap.forms.dialogFields | Where-Object { $_.name -eq $Name } | Select-Object -First 1)
}

function Widget-ByName($Snap, [string]$Name) {
    return ($Snap.forms.widgets | Where-Object { $_.name -eq $Name } | Select-Object -First 1)
}

function Get-CoreProcesses([int]$RootProcessId) {
    $processes = @(Get-CimInstance Win32_Process)
    $processIds = @([int]$RootProcessId)
    do {
        $children = @($processes | Where-Object { $processIds -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId })
        $newIds = @($children | Where-Object { $processIds -notcontains $_ } | Sort-Object -Unique)
        if ($newIds.Count) { $processIds += $newIds }
    } while ($newIds.Count)
    return @($processes | Where-Object {
        $processIds -contains [int]$_.ProcessId -and $_.CommandLine -match '(?i)(?:-m\s+chef_core|chef_core)'
    })
}

function Start-FormsApp([string[]]$Paths, [string]$Subdir) {
    $subData = Join-Path $dataDir $Subdir
    $subLog = Join-Path $work ("app-$Subdir.log")
    New-Item -ItemType Directory -Force -Path $subData | Out-Null
    $script:log = $subLog
    $script:pipe = $null
    $script:token = $null

    $env:CHEF_E2E = '1'
    $env:CHEF_USER_DATA_DIR = $subData
    $env:CHEF_E2E_SAVE_AS_PATH = $null
    $arguments = ($Paths | ForEach-Object { '"' + $_ + '"' }) -join ' '
    try {
        $script:proc = Start-Process -FilePath $Exe -ArgumentList $arguments -PassThru -RedirectStandardError $subLog -WindowStyle Hidden
    } finally {
        Restore-Env 'CHEF_E2E' $oldE2E
        Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
        Restore-Env 'CHEF_E2E_SAVE_AS_PATH' $oldSaveAs
    }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $subLog)) {
        if ($proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)) before log" }
        Start-Sleep -Milliseconds 100
    }
    while ((Get-Date) -lt $deadline -and (([string](Get-Content -LiteralPath $subLog -Raw -ErrorAction SilentlyContinue)) -notmatch 'CHEF_DEBUG_TOKEN=')) {
        if ($proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)): $(Get-Content -LiteralPath $subLog -Raw -ErrorAction SilentlyContinue)" }
        Start-Sleep -Milliseconds 150
    }
    $logText = Get-Content -LiteralPath $subLog -Raw
    $script:pipe = [regex]::Match($logText, 'chef-native-\d+').Value
    $script:token = [regex]::Match($logText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    if (-not $script:pipe -or -not $script:token) { throw "debug pipe/token missing from $subLog" }
}

function Stop-FormsApp([string]$Label) {
    Send 'quit' | Out-Null
    if (-not $proc.WaitForExit(5000)) { throw "${Label}: chef-app did not exit after quit" }
    $script:proc = $null
}

$fixturePy = @'
import sys
from pathlib import Path
import pikepdf
from pikepdf import Array, Dictionary, Name

sys.path.insert(0, sys.argv[1])
from forms_support import pikepdf_form

editable_path = Path(sys.argv[2])
signed_path = Path(sys.argv[3])

pikepdf_form(editable_path)
pikepdf_form(signed_path)

with pikepdf.open(signed_path, allow_overwriting_input=True) as pdf:
    p0 = pdf.pages[0]
    sig = pdf.make_indirect(Dictionary(
        Type=Name.Annot,
        Subtype=Name.Widget,
        F=4,
        P=p0.obj,
        FT=Name.Sig,
        T=pikepdf.String("chuky"),
        Rect=Array([160, 4, 280, 22]),
    ))
    p0.obj.Annots.append(sig)
    pdf.Root.AcroForm.Fields.append(sig)
    pdf.save(signed_path)
'@

$inspectFlatPy = @'
import json, sys, unicodedata
import pikepdf
from pypdfium2 import PdfDocument
from chef_core.forms.model import FormDoc
from chef_core.forms.listing import list_result

path = sys.argv[1]
with pikepdf.open(path) as pdf:
    has_acroform = "/AcroForm" in pdf.Root
    widget_count = 0
    for page in pdf.pages:
        for annot in page.obj.get("/Annots", []):
            if str(annot.get("/Subtype")) == "/Widget":
                widget_count += 1
    fields = list_result(FormDoc(pdf))["fields"]

doc = PdfDocument(path)
try:
    page = doc[0]
    pil = page.render(scale=2).to_pil().convert("L")
    dark_pixels = sum(1 for b in pil.tobytes() if b < 240)
    textpage = page.get_textpage()
    raw_text = textpage.get_text_range()
    textpage.close()
    page.close()
finally:
    doc.close()

text = unicodedata.normalize("NFC", raw_text)
print(json.dumps({
    "hasAcroForm": has_acroform,
    "widgetCount": widget_count,
    "fieldCount": len(fields),
    "darkPixels": dark_pixels,
    "hasName": "Nguyễn Văn Phẳng" in text,
    "hasProvince": "HCM" in text,
    "textSample": text[:300],
}, ensure_ascii=False))
'@

$inspectSigPy = @'
import json, sys, pikepdf
from chef_core.forms.model import FormDoc
from chef_core.forms.listing import list_result
from chef_core.signing.fields import list_signature_fields

path = sys.argv[1]
with pikepdf.open(path) as pdf:
    sig_fields = list_signature_fields(pdf)
    fields = list_result(FormDoc(pdf))["fields"]

print(json.dumps({
    "sigCount": len(sig_fields),
    "fields": [{"name": f["name"], "type": f["type"]} for f in fields],
}, ensure_ascii=False))
'@

try {
    New-Item -ItemType Directory -Force -Path $work, $dataDir | Out-Null
    Push-Location (Join-Path $repo 'core')
    try {
        & uv run --no-project python -c $fixturePy (Join-Path $repo 'core\tests') $editablePdf $signedFieldPdf
        if ($LASTEXITCODE -ne 0) { throw 'fixture generation failed' }
    } finally { Pop-Location }

    # Pass 1: Lazy-core view -> Biểu mẫu PDF -> edit 4 fields -> Flatten cancel preserves draft ->
    # Flatten confirm burns fields -> Undo/Redo -> Ctrl+S
    Start-FormsApp @($editablePdf) 'pass1'
    WaitFor {
        $s = State
        $s.tabs.Count -eq 1 -and
        $s.cached -gt 0 -and
        $s.pending -eq 0 -and
        $s.forms.pendingPages -eq 0 -and
        $s.forms.widgets.Count -ge 10
    } 'editable form ready'

    $s0 = State
    $core0 = @(Get-CoreProcesses $proc.Id).Count
    Expect 'initial view renders form widgets without spawning chef-core' (
        $core0 -eq 0 -and
        $s0.forms.formType -eq 'acroform' -and
        $s0.forms.formEnvActive -eq $true -and
        $s0.forms.widgets.Count -ge 10
    ) "core=$core0 type=$($s0.forms.formType) env=$($s0.forms.formEnvActive) widgets=$($s0.forms.widgets.Count)"

    Send 'action openforms' | Out-Null
    WaitFor { $s = State; $s.forms.dialogOpen -eq $true -and $s.forms.dialogFields.Count -ge 10 } 'forms dialog opens with fields'

    Click-Control 'form-field-hoten'
    Send 'action selectall' | Out-Null
    Send 'char Nguyễn Văn Phẳng' | Out-Null
    WaitFor { (Field-ByName (State) 'hoten').value -eq 'Nguyễn Văn Phẳng' } 'hoten text edited in draft'

    Click-Control 'form-field-dongy'
    WaitFor { (Field-ByName (State) 'dongy').value -eq $false } 'dongy checkbox toggled off in draft'

    Click-Control 'form-field-tinh'
    Click-Control 'form-field-tinh-opt-2'
    WaitFor { (Field-ByName (State) 'tinh').value -eq 'HCM' } 'tinh dropdown chosen in draft'

    Click-Control 'form-field-gioitinh-opt-1'
    WaitFor { (Field-ByName (State) 'gioitinh').value -eq 'nu' } 'gioitinh radio chosen in draft'

    WaitFor { (State).forms.changedCount -eq 4 } '4 unsaved edits tracked before flatten'

    # Open flatten confirmation and cancel: unsaved edits must stay intact
    Click-Control 'forms-flatten'
    WaitFor { (State).forms.flattenConfirmOpen -eq $true } 'flatten confirmation prompt opens'
    Click-Control 'forms-flatten-cancel'
    WaitFor { $s = State; (-not $s.forms.flattenConfirmOpen) -and $s.forms.dialogOpen } 'cancel closes flatten confirmation'
    $sAfterCancel = State
    Expect 'cancelling flatten prompt keeps unsaved fill edits intact' (
        $sAfterCancel.forms.changedCount -eq 4 -and
        (Field-ByName $sAfterCancel 'hoten').value -eq 'Nguyễn Văn Phẳng' -and
        (Field-ByName $sAfterCancel 'dongy').value -eq $false -and
        (Field-ByName $sAfterCancel 'tinh').value -eq 'HCM' -and
        (Field-ByName $sAfterCancel 'gioitinh').value -eq 'nu'
    ) "changed=$($sAfterCancel.forms.changedCount) hoten=$((Field-ByName $sAfterCancel 'hoten').value)"

    # Open flatten confirmation and confirm: unsaved fill edits are applied then flattened
    Click-Control 'forms-flatten'
    WaitFor { (State).forms.flattenConfirmOpen -eq $true } 'flatten confirmation prompt reopens'
    Click-Control 'forms-flatten-confirm-action'
    WaitFor {
        $s = State
        (-not $s.forms.flattenConfirmOpen) -and
        $s.forms.dialogOpen -and
        $s.forms.dialogFields.Count -eq 0 -and
        $s.pending -eq 0 -and
        $s.forms.pendingPages -eq 0 -and
        $s.tabs[0].dirty
    } 'forms.flatten completes and removes editable widgets'

    $sAfterFlatten = State
    Expect 'confirming flatten removes all widgets, updates formType=none, disables button, marks dirty' (
        $sAfterFlatten.forms.formType -eq 'none' -and
        $sAfterFlatten.forms.formEnvActive -eq $false -and
        $sAfterFlatten.forms.widgets.Count -eq 0 -and
        $sAfterFlatten.forms.dialogFields.Count -eq 0 -and
        $sAfterFlatten.tabs[0].dirty -and
        (Control-Disabled $sAfterFlatten 'forms-flatten') -and
        (-not (Control-Disabled $sAfterFlatten 'viewer-undo'))
    ) "type=$($sAfterFlatten.forms.formType) env=$($sAfterFlatten.forms.formEnvActive) widgets=$($sAfterFlatten.forms.widgets.Count) fields=$($sAfterFlatten.forms.dialogFields.Count)"

    Click-Control 'forms-cancel'
    WaitFor { -not (State).forms.dialogOpen } 'forms dialog closes'

    # Undo restores form widgets + applied filled values; Redo flattens again
    Send 'action undoedit' | Out-Null
    WaitFor {
        $s = State
        (-not (Control-Disabled $s 'viewer-redo')) -and
        $s.pending -eq 0 -and
        $s.forms.pendingPages -eq 0 -and
        $s.forms.widgets.Count -ge 10
    } 'undo restores interactive form widgets'
    $sAfterUndo = State
    $uHoten = Widget-ByName $sAfterUndo 'hoten'
    Expect 'Undo restores interactive widgets with filled value intact' (
        $sAfterUndo.forms.formType -eq 'acroform' -and
        $null -ne $uHoten -and
        $uHoten.value -eq 'Nguyễn Văn Phẳng'
    ) "type=$($sAfterUndo.forms.formType) hoten=$($uHoten.value)"

    Send 'action redoedit' | Out-Null
    WaitFor {
        $s = State
        (Control-Disabled $s 'viewer-redo') -and
        $s.pending -eq 0 -and
        $s.forms.pendingPages -eq 0 -and
        $s.forms.widgets.Count -eq 0
    } 'redo re-flattens form'
    Expect 'Redo removes form widgets and sets formType=none' ((State).forms.formType -eq 'none')

    Send 'action saveedit' | Out-Null
    WaitFor { $s = State; (-not $s.tabs[0].dirty) -and $s.pending -eq 0 } 'Ctrl+S saves flattened PDF'
    Expect 'Ctrl+S saves flattened PDF cleanly' (-not (State).tabs[0].dirty)
    Stop-FormsApp 'pass1'

    # Disk verification via pikepdf + chef_core + pypdfium2
    Push-Location (Join-Path $repo 'core')
    try {
        $flatJsonRaw = & uv run --no-project python -c $inspectFlatPy $editablePdf
        if ($LASTEXITCODE -ne 0) { throw 'python disk inspection failed' }
    } finally { Pop-Location }
    $flatInfo = $flatJsonRaw | ConvertFrom-Json
    Expect 'flattened PDF on disk has no AcroForm or Widget annots and retains rendered/extractable text' (
        (-not $flatInfo.hasAcroForm) -and
        $flatInfo.widgetCount -eq 0 -and
        $flatInfo.fieldCount -eq 0 -and
        $flatInfo.darkPixels -gt 50 -and
        $flatInfo.hasName -and
        $flatInfo.hasProvince
    ) $flatJsonRaw

    # Pass 2: Reopen flattened PDF in fresh chef-app instance and search flattened text with 0 chef-core
    Start-FormsApp @($editablePdf) 'pass2'
    WaitFor { $s = State; $s.tabs.Count -eq 1 -and $s.cached -gt 0 -and $s.pending -eq 0 } 'reopened flattened PDF ready'
    $reopenS = State
    $reopenCore0 = @(Get-CoreProcesses $proc.Id).Count
    Expect 'reopened flattened PDF opens cleanly without form widgets or chef-core' (
        $reopenCore0 -eq 0 -and
        $reopenS.forms.formType -eq 'none' -and
        $reopenS.forms.formEnvActive -eq $false -and
        $reopenS.forms.widgets.Count -eq 0
    ) "core=$reopenCore0 type=$($reopenS.forms.formType) widgets=$($reopenS.forms.widgets.Count)"

    Send 'action focussearch' | Out-Null
    WaitFor { $s = State; $null -ne $s.input -and $s.input.focused } 'search input focused'
    Send 'char Nguyễn Văn Phẳng' | Out-Null
    WaitFor {
        $s = State
        $s.find.query -eq 'Nguyễn Văn Phẳng' -and $s.find.total -ge 1 -and (-not $s.find.scanning)
    } 'find locates flattened Vietnamese text'
    $reopenCoreAfterFind = @(Get-CoreProcesses $proc.Id).Count
    Expect 'find locates flattened Vietnamese text with 0 chef-core processes' (
        (State).find.total -ge 1 -and $reopenCoreAfterFind -eq 0
    ) "total=$((State).find.total) core=$reopenCoreAfterFind"
    Stop-FormsApp 'pass2'

    # Pass 3: Command Palette forms.flatten preserves unsigned /FT /Sig signature field
    Start-FormsApp @($signedFieldPdf) 'pass3'
    WaitFor {
        $s = State
        $s.tabs.Count -eq 1 -and
        $s.cached -gt 0 -and
        $s.pending -eq 0 -and
        $s.forms.pendingPages -eq 0 -and
        $s.forms.widgets.Count -ge 10
    } 'signed-field form ready'

    Send 'action openpalette' | Out-Null
    WaitFor { (State).palette.open } 'command palette opens'
    Send 'char lam phang bieu mau' | Out-Null
    WaitFor { $s = State; $s.palette.results.Count -gt 0 -and $s.palette.results[0].id -eq 'forms.flatten' } 'forms.flatten matched in palette'
    Send 'action submit' | Out-Null
    WaitFor { $s = State; $s.forms.dialogOpen -eq $true -and $s.forms.flattenConfirmOpen -eq $true } 'palette command opens forms flatten confirmation'

    Click-Control 'forms-flatten-confirm-action'
    WaitFor {
        $s = State
        (-not $s.forms.flattenConfirmOpen) -and
        $s.forms.dialogOpen -and
        $s.forms.dialogFields.Count -eq 1 -and
        $s.pending -eq 0 -and
        $s.forms.pendingPages -eq 0
    } 'palette flatten keeps signature field only'

    $sSig = State
    Expect 'Command Palette forms.flatten preserves unsigned /FT /Sig signature field' (
        $sSig.forms.dialogFields.Count -eq 1 -and
        $sSig.forms.dialogFields[0].name -eq 'chuky' -and
        $sSig.forms.dialogFields[0].kind -eq 'signature'
    ) ($sSig.forms.dialogFields | ConvertTo-Json -Compress)

    Click-Control 'forms-cancel'
    WaitFor { -not (State).forms.dialogOpen } 'forms dialog closes after signature-kept flatten'
    Send 'action saveedit' | Out-Null
    WaitFor { $s = State; (-not $s.tabs[0].dirty) -and $s.pending -eq 0 } 'saved signature-kept flattened PDF'
    Stop-FormsApp 'pass3'

    Push-Location (Join-Path $repo 'core')
    try {
        $sigJsonRaw = & uv run --no-project python -c $inspectSigPy $signedFieldPdf
        if ($LASTEXITCODE -ne 0) { throw 'python signature inspection failed' }
    } finally { Pop-Location }
    $sigInfo = $sigJsonRaw | ConvertFrom-Json
    Expect 'persisted PDF keeps only unsigned signature field chuky' (
        $sigInfo.sigCount -eq 1 -and
        $sigInfo.fields.Count -eq 1 -and
        $sigInfo.fields[0].name -eq 'chuky' -and
        $sigInfo.fields[0].type -eq 'signature'
    ) $sigJsonRaw
}
finally {
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Restore-Env 'CHEF_E2E_SAVE_AS_PATH' $oldSaveAs
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
    if ($script:fails -gt 0 -and $script:log -and (Test-Path -LiteralPath $script:log)) {
        Write-Output '--- app log tail ---'
        Get-Content -LiteralPath $script:log -Tail 60
    }
    if (Test-Path -LiteralPath $work) {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($script:fails -gt 0) {
    Write-Output "FAILS: $script:fails"
    exit 1
}
Write-Output 'PASS: R4.24 forms flatten, cancel, Undo/Redo, Save, Reopen/Find, and signature preservation E2E completed cleanly (FAILS: 0)'
