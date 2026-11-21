#requires -Version 7.0
<#
.SYNOPSIS
  R4.22 E2E: PDF form filling (text, checkbox, radio, dropdown), page-reading-order Tab navigation,
  direct overlay click toggle, Undo/Redo, Ctrl+S save, and reopen verification.
.DESCRIPTION
  Windows only. Runs off-screen through the authenticated debug pipe.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-forms-fill-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$formPdf = Join-Path $work 'form-fill.pdf'
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

form_path = Path(sys.argv[2])
pikepdf_form(form_path)

with pikepdf.open(form_path, allow_overwriting_input=True) as pdf:
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

    p1 = pdf.add_blank_page(page_size=(300, 300))
    da = pikepdf.String("/Helv 12 Tf 0 g")
    # Append p2_right before p2_left in both /Annots and /Fields to verify geometric page reading order.
    p2_right = pdf.make_indirect(Dictionary(
        Type=Name.Annot,
        Subtype=Name.Widget,
        F=4,
        P=p1.obj,
        FT=Name.Tx,
        T=pikepdf.String("p2_right"),
        DA=da,
        Rect=Array([180, 240, 280, 260]),
    ))
    p2_left = pdf.make_indirect(Dictionary(
        Type=Name.Annot,
        Subtype=Name.Widget,
        F=4,
        P=p1.obj,
        FT=Name.Tx,
        T=pikepdf.String("p2_left"),
        DA=da,
        Rect=Array([20, 240, 120, 260]),
    ))
    p1.obj.Annots = Array([p2_right, p2_left])
    pdf.Root.AcroForm.Fields.append(p2_right)
    pdf.Root.AcroForm.Fields.append(p2_left)
    pdf.save(form_path)
'@

$inspectPy = @'
import json, sys, pikepdf
from chef_core.forms.model import FormDoc
from chef_core.forms.data import export_values

with pikepdf.open(sys.argv[1]) as pdf:
    print(json.dumps(export_values(FormDoc(pdf))))
'@

try {
    New-Item -ItemType Directory -Force -Path $work, $dataDir | Out-Null
    Push-Location (Join-Path $repo 'core')
    try {
        & uv run --no-project python -c $fixturePy (Join-Path $repo 'core\tests') $formPdf
        if ($LASTEXITCODE -ne 0) { throw 'fixture generation failed' }
    } finally { Pop-Location }

    # Pass 1: Lazy-core, page reading-order Tab, Command Palette open, Fill, Undo/Redo, Click toggle, Save
    Start-FormsApp @($formPdf) 'pass1'
    WaitFor {
        $s = State
        $s.tabs.Count -eq 1 -and
        $s.cached -gt 0 -and
        $s.pending -eq 0 -and
        $s.forms.pendingPages -eq 0 -and
        ($s.forms.tabOrder | Where-Object { $_.pageIndex -eq 1 }).Count -eq 2
    } 'multi-page form widgets ready'

    $s0 = State
    $coreBeforeTab = @(Get-CoreProcesses $proc.Id).Count
    $tabOrder = @($s0.forms.tabOrder)
    $tabNames = @($tabOrder | ForEach-Object { $_.name })
    $p1Order = @($tabOrder | Where-Object { $_.pageIndex -eq 1 } | ForEach-Object { $_.name })
    $excludesNonEditable = ($tabNames -notcontains 'ma') -and ($tabNames -notcontains 'chuky')
    $page0BeforePage1 = ($tabOrder[0].pageIndex -eq 0) -and ($tabOrder[$tabOrder.Count - 2].pageIndex -eq 1)
    Expect 'on-page tab order follows geometric reading order across pages and skips read-only/signature' (
        $tabOrder.Count -ge 10 -and $excludesNonEditable -and $page0BeforePage1 -and $p1Order[0] -eq 'p2_left' -and $p1Order[1] -eq 'p2_right'
    ) "p1=$($p1Order -join ',') all=$($tabNames -join ',')"

    # Focus canvas empty margin and step Tab / Shift+Tab across every editable widget without starting chef-core
    $firstWidget = $s0.forms.widgets | Select-Object -First 1
    $pb = $firstWidget.pageBounds
    $scale0 = [double]$s0.controls.scale
    $canvasX = [int](([double]$pb[0] + 4.0) * $scale0)
    $canvasY = [int](([double]$pb[1] + 4.0) * $scale0)
    Send "click $canvasX $canvasY" | Out-Null
    Start-Sleep -Milliseconds 120

    $visitedIds = @()
    foreach ($expectedItem in $tabOrder) {
        Send 'action focusnext' | Out-Null
        $expectedId = $expectedItem.id
        WaitFor { (State).forms.focusedWidget -eq $expectedId } "tab focus to $expectedId"
        $visitedIds += (State).forms.focusedWidget
    }
    $sAfterP1 = State
    $scrolledToP1 = $sAfterP1.view.visiblePages -contains 1

    # Wrap forward back to index 0, then step backward with Shift+Tab twice to p2_right -> p2_left
    Send 'action focusnext' | Out-Null
    WaitFor { (State).forms.focusedWidget -eq $tabOrder[0].id } 'tab wrap to first widget'
    Send 'action focusprev' | Out-Null
    WaitFor { (State).forms.focusedWidget -eq $tabOrder[$tabOrder.Count - 1].id } 'shift-tab wrap to p2_right'
    Send 'action focusprev' | Out-Null
    WaitFor { (State).forms.focusedWidget -eq $tabOrder[$tabOrder.Count - 2].id } 'shift-tab to p2_left'

    $coreAfterTab = @(Get-CoreProcesses $proc.Id).Count
    $expectedIds = @($tabOrder | ForEach-Object { $_.id })
    $tabMatchesExact = (($visitedIds -join ',') -eq ($expectedIds -join ','))
    Expect 'Tab and Shift+Tab visit all editable widgets in page reading order and scroll across pages' ($tabMatchesExact -and $scrolledToP1) "scrolled=$scrolledToP1 visited=$($visitedIds -join ',') expected=$($expectedIds -join ',')"
    Expect 'viewing and Tab-stepping form widgets never spawns chef-core' ($coreBeforeTab -eq 0 -and $coreAfterTab -eq 0) "before=$coreBeforeTab after=$coreAfterTab"

    # Scroll cleanly back to the top of page 0 before opening Forms dialog and testing on-page click
    while ([double](State).view.scrollY -gt 40.0) {
        Send 'action prevpage' | Out-Null
        Start-Sleep -Milliseconds 120
    }
    WaitFor { $s = State; $w = Widget-ByName $s 'dongy'; $null -ne $w -and [double]$w.bounds[1] -gt 80.0 } 'page 0 top scrolled into view'

    # Open Biểu mẫu PDF via Command Palette
    Send 'action openpalette' | Out-Null
    WaitFor { (State).palette.open } 'command palette opens'
    Send 'char bieu mau' | Out-Null
    WaitFor { $s = State; $s.palette.results.Count -gt 0 -and $s.palette.results[0].id -eq 'forms.open' } 'forms command matched'
    Send 'action submit' | Out-Null
    WaitFor { $s = State; $s.forms.dialogOpen -eq $true -and $s.forms.dialogFields.Count -ge 12 } 'forms dialog opens with fields'

    $sd0 = State
    $dlgNames = @($sd0.forms.dialogFields | ForEach-Object { $_.name })
    $dlgP2LeftIdx = [array]::IndexOf($dlgNames, 'p2_left')
    $dlgP2RightIdx = [array]::IndexOf($dlgNames, 'p2_right')
    $dlgEditable = @($sd0.forms.dialogFields | Where-Object { $_.editable })
    Expect 'Biểu mẫu PDF dialog lists fields in page reading order' ($dlgP2LeftIdx -ge 0 -and $dlgP2LeftIdx -lt $dlgP2RightIdx) "names=$($dlgNames -join ',')"

    # Verify Tab cycles dialog fields in page reading order
    Click-Control $dlgEditable[0].controlId
    WaitFor { (State).forms.focusedField -eq $dlgEditable[0].name } 'first editable dialog field focused'
    Send 'action focusnext' | Out-Null
    WaitFor { (State).forms.focusedField -eq $dlgEditable[1].name } 'dialog Tab moves to second editable field'
    Expect 'Tab inside Biểu mẫu PDF advances to next editable field in page order' ((State).forms.focusedField -eq $dlgEditable[1].name) "focused=$((State).forms.focusedField)"

    # Fill text (hoten), toggle checkbox (dongy), choose dropdown (tinh -> HCM), choose radio (gioitinh -> nu), fill page 2 text (p2_left)
    Click-Control 'form-field-hoten'
    Send 'action selectall' | Out-Null
    Send 'char Nguyễn Văn A' | Out-Null
    WaitFor { (Field-ByName (State) 'hoten').value -eq 'Nguyễn Văn A' } 'hoten text updated'

    Click-Control 'form-field-dongy'
    WaitFor { (Field-ByName (State) 'dongy').value -eq $false } 'dongy toggled off'

    Click-Control 'form-field-tinh'
    Click-Control 'form-field-tinh-opt-2'
    WaitFor { (Field-ByName (State) 'tinh').value -eq 'HCM' } 'tinh dropdown set to HCM'

    Click-Control 'form-field-gioitinh-opt-1'
    WaitFor { (Field-ByName (State) 'gioitinh').value -eq 'nu' } 'gioitinh radio set to nu'

    Click-Control 'form-field-p2_left'
    Send 'action selectall' | Out-Null
    Send 'char Trang hai' | Out-Null
    WaitFor { (Field-ByName (State) 'p2_left').value -eq 'Trang hai' } 'p2_left text updated'

    WaitFor { (State).forms.changedCount -eq 5 } '5 changed fields tracked'
    Click-Control 'forms-apply'
    WaitFor {
        $s = State
        (-not $s.forms.dialogOpen) -and $s.pending -eq 0 -and $s.forms.pendingPages -eq 0 -and $s.tabs[0].dirty
    } 'forms.fill revision applied'

    WaitFor { $s = State; $w = Widget-ByName $s 'hoten'; $null -ne $w -and $w.value -eq 'Nguyễn Văn A' } 'page 0 widgets refreshed after apply'
    $sAfterApply = State
    $wHoten = Widget-ByName $sAfterApply 'hoten'
    $wDongy = Widget-ByName $sAfterApply 'dongy'
    $wTinh = Widget-ByName $sAfterApply 'tinh'
    $wGioitinhNu = @($sAfterApply.forms.widgets | Where-Object { $_.name -eq 'gioitinh' -and $_.checked -eq $true })
    Expect 'forms.fill applies text, checkbox, dropdown, and radio values and marks tab dirty' (
        $sAfterApply.tabs[0].dirty -and
        (-not (Control-Disabled $sAfterApply 'viewer-undo')) -and
        $wHoten.value -eq 'Nguyễn Văn A' -and
        $wDongy.checked -eq $false -and
        $wTinh.value -eq 'HCM' -and
        $wGioitinhNu.Count -eq 1
    ) "dirty=$($sAfterApply.tabs[0].dirty) hoten=$($wHoten.value) dongy=$($wDongy.checked) tinh=$($wTinh.value) radios=$($wGioitinhNu.Count)"

    # Verify Undo and Redo via viewer actions
    Send 'action undoedit' | Out-Null
    WaitFor {
        $s = State
        (-not (Control-Disabled $s 'viewer-redo')) -and $s.pending -eq 0 -and $s.forms.pendingPages -eq 0
    } 'undo completed'
    $sAfterUndo = State
    $uHoten = Widget-ByName $sAfterUndo 'hoten'
    $uDongy = Widget-ByName $sAfterUndo 'dongy'
    Expect 'Undo reverts filled form values cleanly' ($uHoten.value -ne 'Nguyễn Văn A' -and $uDongy.checked -eq $true) "hoten=$($uHoten.value) dongy=$($uDongy.checked)"

    Send 'action redoedit' | Out-Null
    WaitFor {
        $s = State
        (Control-Disabled $s 'viewer-redo') -and $s.pending -eq 0 -and $s.forms.pendingPages -eq 0
    } 'redo completed'
    $sAfterRedo = State
    $rHoten = Widget-ByName $sAfterRedo 'hoten'
    $rDongy = Widget-ByName $sAfterRedo 'dongy'
    Expect 'Redo restores filled form values cleanly' ($rHoten.value -eq 'Nguyễn Văn A' -and $rDongy.checked -eq $false) "hoten=$($rHoten.value) dongy=$($rDongy.checked)"

    # Direct on-page checkbox click toggles dongy via forms.fill, then Undo reverts it
    Click-Control $rDongy.id
    WaitFor {
        $s = State
        $w = Widget-ByName $s 'dongy'
        $s.pending -eq 0 -and $s.forms.pendingPages -eq 0 -and $null -ne $w -and $w.checked -eq $true
    } 'direct on-page checkbox click checks dongy'
    Send 'action undoedit' | Out-Null
    WaitFor {
        $s = State
        $w = Widget-ByName $s 'dongy'
        $s.pending -eq 0 -and $s.forms.pendingPages -eq 0 -and $null -ne $w -and $w.checked -eq $false
    } 'undo reverts direct on-page checkbox toggle'
    Expect 'clicking checkbox on page toggles via forms.fill and supports Undo' ((Widget-ByName (State) 'dongy').checked -eq $false)

    # Save via Ctrl+S action and quit cleanly
    Send 'action saveedit' | Out-Null
    WaitFor { $s = State; (-not $s.tabs[0].dirty) -and $s.pending -eq 0 } 'save clears dirty flag'
    Expect 'Ctrl+S saves filled form cleanly' (-not (State).tabs[0].dirty)
    Stop-FormsApp 'pass1'

    # Inspect persisted PDF with core directly
    Push-Location (Join-Path $repo 'core')
    try {
        $exportedRaw = & uv run --no-project python -c $inspectPy $formPdf
        if ($LASTEXITCODE -ne 0) { throw 'python export_values failed' }
    } finally { Pop-Location }
    $exported = $exportedRaw | ConvertFrom-Json
    Expect 'saved PDF on disk contains exact form values' (
        $exported.hoten -eq 'Nguyễn Văn A' -and
        $exported.dongy -eq $false -and
        $exported.tinh -eq 'HCM' -and
        $exported.gioitinh -eq 'nu' -and
        $exported.p2_left -eq 'Trang hai' -and
        $exported.ma -eq 'MA-01'
    ) $exportedRaw

    # Pass 2: Reopen saved PDF in fresh chef-app instance and verify read-back
    Start-FormsApp @($formPdf) 'pass2'
    WaitFor {
        $s = State
        $s.tabs.Count -eq 1 -and
        $s.cached -gt 0 -and
        $s.pending -eq 0 -and
        $s.forms.pendingPages -eq 0 -and
        $s.forms.widgets.Count -ge 10
    } 'reopened saved form ready'
    $reopenCore0 = @(Get-CoreProcesses $proc.Id).Count
    $reopenS0 = State
    $reopenHoten = Widget-ByName $reopenS0 'hoten'
    $reopenDongy = Widget-ByName $reopenS0 'dongy'
    Send 'action openforms' | Out-Null
    WaitFor { $s = State; $s.forms.dialogOpen -eq $true -and $s.forms.dialogFields.Count -ge 12 } 'forms dialog loads persisted values'
    $reopenDlg = State
    Expect 'reopened PDF displays and reloads saved values accurately' (
        $reopenCore0 -eq 0 -and
        $reopenHoten.value -eq 'Nguyễn Văn A' -and
        $reopenDongy.checked -eq $false -and
        (Field-ByName $reopenDlg 'hoten').value -eq 'Nguyễn Văn A' -and
        (Field-ByName $reopenDlg 'dongy').value -eq $false -and
        (Field-ByName $reopenDlg 'tinh').value -eq 'HCM' -and
        (Field-ByName $reopenDlg 'gioitinh').value -eq 'nu' -and
        (Field-ByName $reopenDlg 'p2_left').value -eq 'Trang hai'
    ) "core=$reopenCore0 hoten=$($reopenHoten.value) dongy=$($reopenDongy.checked)"
    Stop-FormsApp 'pass2'
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
Write-Output 'PASS: R4.22 form fill, page-order Tab, Undo/Redo, Save, and Reopen E2E completed cleanly (FAILS: 0)'
