#requires -Version 7.0
<#
.SYNOPSIS
  R4.23 E2E: interactive PDF form creation (text, comb, checkbox, radio, dropdown, signature),
  duplicate & invalid name checks, Undo/Redo, Ctrl+S save, pikepdf/PDFium readback, and Electron cross-open.
.DESCRIPTION
  Windows only. Runs off-screen through the authenticated debug pipe.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-forms-create-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$electronDataDir = Join-Path $work 'electron-userdata'
$formPdf = Join-Path $work 'form-create.pdf'
$electronScript = Join-Path $work 'electron_check.mjs'
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

function Click-Control([string]$Id, [switch]$AllowDisabled) {
    $script:targetControl = $null
    $script:targetSnapshot = $null
    WaitFor {
        $snap = State
        $c = $snap.controls.controls | Where-Object {
            $_.id -eq $Id -and $null -ne $_.bounds -and ($AllowDisabled -or (-not $_.disabled))
        } | Select-Object -First 1
        if ($null -ne $c) {
            $script:targetSnapshot = $snap
            $script:targetControl = $c
            return $true
        }
        return $false
    } "bounds for $Id" 15
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

function Stop-FormsApp([string]$Tag) {
    Send 'quit' | Out-Null
    if (-not $proc.WaitForExit(5000)) { throw "${Tag}: chef-app did not exit after quit" }
    Expect "clean exit ($Tag)" ($proc.ExitCode -eq 0) "exit=$($proc.ExitCode)"
    $script:proc = $null
}

function Draw-FormRect([double]$X1Ratio, [double]$Y1Ratio, [double]$X2Ratio, [double]$Y2Ratio) {
    WaitFor {
        $s = State
        $s.forms.drawing -eq $true -and $null -ne $s.forms.page0Rect
    } 'draw mode and page0Rect ready'
    $s = State
    $pr = $s.forms.page0Rect
    $scale = [double]$s.controls.scale
    $sx = [int](([double]$pr[0] + ([double]$pr[2] - [double]$pr[0]) * $X1Ratio) * $scale)
    $sy = [int](([double]$pr[1] + ([double]$pr[3] - [double]$pr[1]) * $Y1Ratio) * $scale)
    $tx = [int](([double]$pr[0] + ([double]$pr[2] - [double]$pr[0]) * $X2Ratio) * $scale)
    $ty = [int](([double]$pr[1] + ([double]$pr[3] - [double]$pr[1]) * $Y2Ratio) * $scale)
    Send "mouse move $sx $sy" | Out-Null
    Start-Sleep -Milliseconds 60
    Send "mouse down $sx $sy" | Out-Null
    Start-Sleep -Milliseconds 70
    Send "mouse move $tx $ty" | Out-Null
    Start-Sleep -Milliseconds 70
    Send "mouse up $tx $ty" | Out-Null
    WaitFor {
        $st = State
        $st.forms.createOpen -eq $true -and $st.pending -eq 0
    } 'create field dialog opens'
}

function Create-FormField(
    [int]$KindIndex,
    [string]$KindWire,
    [double]$X1Ratio,
    [double]$Y1Ratio,
    [double]$X2Ratio,
    [double]$Y2Ratio,
    [string]$Name,
    [string]$Label = '',
    [string]$Options = '',
    [string]$MaxLen = '',
    [bool]$Required = $false
) {
    if (-not (State).forms.drawing) {
        if ((State).forms.dialogOpen) {
            Click-Control 'forms-add-field'
        } else {
            Send 'action addformfield' | Out-Null
        }
        WaitFor { (State).forms.drawing -eq $true } "enter form draw mode for $Name"
    }
    Draw-FormRect $X1Ratio $Y1Ratio $X2Ratio $Y2Ratio

    if ($KindIndex -ne 0) {
        Click-Control 'form-create-kind'
        Click-Control "form-create-kind-opt-$KindIndex"
        WaitFor { (State).forms.createKind -eq $KindWire } "select kind $KindWire"
    }

    Click-Control 'form-create-name'
    Send 'action selectall' | Out-Null
    Send "char $Name" | Out-Null

    if ($Label) {
        Click-Control 'form-create-label'
        Send 'action selectall' | Out-Null
        Send "char $Label" | Out-Null
    }
    if ($Options) {
        Click-Control 'form-create-options'
        Send 'action selectall' | Out-Null
        Send "char $Options" | Out-Null
    }
    if ($MaxLen) {
        Click-Control 'form-create-maxlen'
        Send 'action selectall' | Out-Null
        Send "char $MaxLen" | Out-Null
    }
    if ($Required) {
        Click-Control 'form-create-required'
    }

    WaitFor {
        $st = State
        (-not (Control-Disabled $st 'forms-create-submit')) -and $null -eq $st.forms.createIssue
    } "submit button enabled for $Name"
    Click-Control 'forms-create-submit'
    WaitFor {
        $st = State
        $st.forms.dialogOpen -eq $true -and (-not $st.forms.createOpen) -and $st.pending -eq 0 -and $st.forms.pendingPages -eq 0 -and $null -ne (Field-ByName $st $Name)
    } "created field $Name listed in Biểu mẫu PDF"
}

$fixturePy = @'
import pikepdf, sys
pdf = pikepdf.Pdf.new()
pdf.add_blank_page(page_size=(612, 792))
pdf.save(sys.argv[1], static_id=True)
'@

$verifyPy = @'
import json, sys, pikepdf
from chef_core.forms.model import FormDoc
from chef_core.forms.listing import list_result
from chef_core.signing.fields import list_signature_fields

with pikepdf.open(sys.argv[1]) as pdf:
    fd = FormDoc(pdf)
    listed = list_result(fd)
    sigs = list_signature_fields(pdf)
    out = {
        "fields": {f["name"]: f for f in listed["fields"]},
        "sigs": [{"name": s.name, "signed": s.signed, "page": s.page} for s in sigs],
    }
    print(json.dumps(out, ensure_ascii=False))
'@

$exportValuesPy = @'
import json, sys, pikepdf
from chef_core.forms.model import FormDoc
from chef_core.forms.data import export_values

with pikepdf.open(sys.argv[1]) as pdf:
    print(json.dumps(export_values(FormDoc(pdf)), ensure_ascii=False))
'@

$electronCheckJs = @'
import { createRequire } from 'node:module';
import path from 'node:path';

const [, , repoRoot, pdfPath, userDataDir] = process.argv;
const reqE2E = createRequire(path.join(repoRoot, 'tests', 'e2e', 'package.json'));
const reqDesktop = createRequire(path.join(repoRoot, 'apps', 'desktop', 'package.json'));
const { _electron } = reqE2E('@playwright/test');
const electronBin = reqDesktop('electron');

const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) env[k] = v;
}
delete env.CHEF_DEV_SERVER_URL;
delete env.ELECTRON_RUN_AS_NODE;
env.CHEF_E2E = '1';
env.CHEF_USER_DATA_DIR = userDataDir;
env.CHEF_CORE_CMD = `uv run --project "${path.join(repoRoot, 'core')}" python -m chef_core`;

const app = await _electron.launch({
  executablePath: electronBin,
  args: [path.join(repoRoot, 'apps', 'desktop'), pdfPath],
  env,
  cwd: repoRoot,
});

const errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  await page.waitForFunction(() => typeof window.chef === 'object', null, { timeout: 30_000 });
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });

  await page.keyboard.press('Control+k');
  await page.locator('.palette__input').fill('Biểu mẫu PDF');
  await page.locator('[id="cmd-forms.open"]').click();
  const dialog = page.getByRole('dialog', { name: 'Biểu mẫu PDF' });
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });

  for (const name of ['hoten', 'cmnd', 'dongy', 'gioitinh', 'tinh', 'chuky']) {
    await dialog.getByText(name, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
  }
  const hotenVal = await dialog.getByRole('textbox', { name: 'hoten', exact: true }).inputValue();
  if (hotenVal !== 'Nguyễn Văn Tạo') {
    throw new Error(`Expected Electron hoten="Nguyễn Văn Tạo", got ${JSON.stringify(hotenVal)}`);
  }
  if (errors.length) {
    throw new Error(`Electron page errors: ${errors.join('; ')}`);
  }
  console.log('ELECTRON_VERIFIED');
} finally {
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
  await Promise.race([
    app.waitForEvent('close'),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]).catch(() => {});
}
'@

try {
    New-Item -ItemType Directory -Force -Path $work, $dataDir, $electronDataDir | Out-Null
    Push-Location (Join-Path $repo 'core')
    try {
        & uv run --no-project python -c $fixturePy $formPdf
        if ($LASTEXITCODE -ne 0) { throw 'fixture creation failed' }
    } finally { Pop-Location }

    # Pass 1: Blank PDF -> draw and create 6 field kinds, validate duplicate/invalid names, Undo/Redo, Save
    Start-FormsApp @($formPdf) 'pass1'
    WaitFor {
        $s = State
        $s.tabs.Count -eq 1 -and $s.cached -gt 0 -and $s.pending -eq 0 -and $null -ne $s.forms.page0Rect
    } 'blank PDF rendered cleanly'

    $s0 = State
    $coreBefore = @(Get-CoreProcesses $proc.Id).Count
    Expect 'blank PDF opens as formType=none with zero chef-core processes' (
        $coreBefore -eq 0 -and $s0.forms.formType -eq 'none' -and (-not $s0.forms.formEnvActive)
    ) "core=$coreBefore formType=$($s0.forms.formType)"

    # Open Biểu mẫu PDF via Command Palette, start draw mode, verify draw hint, cancel with Escape
    Send 'action openpalette' | Out-Null
    WaitFor { (State).palette.open } 'command palette opens for forms.open'
    Send 'char bieu mau' | Out-Null
    WaitFor { $s = State; $s.palette.results.Count -gt 0 -and $s.palette.results[0].id -eq 'forms.open' } 'forms.open matched'
    Send 'action submit' | Out-Null
    WaitFor { $s = State; $s.forms.dialogOpen -eq $true -and $s.forms.dialogFields.Count -eq 0 } 'empty forms dialog opens'

    Click-Control 'forms-add-field'
    WaitFor {
        $s = State
        $hint = $s.controls.controls | Where-Object { $_.id -eq 'forms-draw-hint' } | Select-Object -First 1
        (-not $s.forms.dialogOpen) -and $s.forms.drawing -eq $true -and $null -ne $hint
    } 'form draw mode entered from Thêm trường button'

    Send 'action exitslideshow' | Out-Null
    WaitFor {
        $s = State
        $hint = $s.controls.controls | Where-Object { $_.id -eq 'forms-draw-hint' } | Select-Object -First 1
        (-not $s.forms.drawing) -and $null -eq $hint
    } 'Escape cancels form draw mode'
    $sEsc = State
    $hintAfterEsc = $sEsc.controls.controls | Where-Object { $_.id -eq 'forms-draw-hint' } | Select-Object -First 1
    Expect 'Escape cancels form draw mode cleanly' ((-not $sEsc.forms.drawing) -and $null -eq $hintAfterEsc) "drawing=$($sEsc.forms.drawing) hint=$($null -ne $hintAfterEsc)"

    # Re-enter draw mode via Command Palette (forms.addField)
    Send 'action openpalette' | Out-Null
    WaitFor { (State).palette.open } 'command palette opens for forms.addField'
    Send 'char them truong' | Out-Null
    WaitFor { $s = State; $s.palette.results.Count -gt 0 -and $s.palette.results[0].id -eq 'forms.addField' } 'forms.addField matched'
    Send 'action submit' | Out-Null
    WaitFor { (State).forms.drawing -eq $true } 'Command Palette starts form draw mode'

    # Create all 6 required field kinds on page 0
    Create-FormField 0 'text' 0.10 0.06 0.45 0.11 'hoten' 'Họ và tên' '' '' $true
    Create-FormField 2 'comb' 0.10 0.13 0.45 0.18 'cmnd' '' '' '9' $false
    Create-FormField 3 'checkbox' 0.10 0.20 0.18 0.25 'dongy' '' '' '' $false
    Create-FormField 4 'radio' 0.10 0.27 0.40 0.32 'gioitinh' '' 'nam, nu' '' $false
    Create-FormField 5 'dropdown' 0.10 0.34 0.45 0.39 'tinh' '' 'Ha Noi, HCM, Da Nang' '' $false
    Create-FormField 6 'signature' 0.10 0.41 0.45 0.47 'chuky' 'Giám đốc' '' '' $false

    $sCreated = State
    $createdNames = @($sCreated.forms.dialogFields | ForEach-Object { $_.name })
    $hasAllSix = ($createdNames -contains 'hoten') -and
        ($createdNames -contains 'cmnd') -and
        ($createdNames -contains 'dongy') -and
        ($createdNames -contains 'gioitinh') -and
        ($createdNames -contains 'tinh') -and
        ($createdNames -contains 'chuky')
    Expect 'all six created fields (text, comb, checkbox, radio, dropdown, signature) appear in dialog' (
        $hasAllSix -and $sCreated.forms.dialogFields.Count -eq 6
    ) "fields=$($createdNames -join ',')"

    # Duplicate and invalid field name enforcement
    Click-Control 'forms-add-field'
    Draw-FormRect 0.10 0.49 0.45 0.54
    Click-Control 'form-create-name'
    Send 'char hoten' | Out-Null
    WaitFor { (State).forms.createIssue -eq 'duplicate' } 'duplicate issue detected'
    $sDup = State
    $dupBlocked = $sDup.forms.createIssue -eq 'duplicate' -and (Control-Disabled $sDup 'forms-create-submit')

    Click-Control 'form-create-name'
    Send 'action selectall' | Out-Null
    Send 'char bad name' | Out-Null
    WaitFor { (State).forms.createIssue -eq 'name' } 'invalid name issue detected'
    $sBad = State
    $badBlocked = $sBad.forms.createIssue -eq 'name' -and (Control-Disabled $sBad 'forms-create-submit')
    Click-Control 'forms-create-cancel'
    WaitFor { -not (State).forms.dialogOpen } 'create form canceled cleanly'
    Expect 'duplicate and invalid field names disable submit and report validation issues' (
        $dupBlocked -and $badBlocked
    ) "dupBlocked=$dupBlocked badBlocked=$badBlocked"

    # Undo & Redo verification
    Create-FormField 0 'text' 0.10 0.49 0.45 0.54 'tam_xoa'
    Click-Control 'forms-cancel'
    WaitFor {
        $s = State
        (-not $s.forms.dialogOpen) -and $s.pending -eq 0 -and $s.forms.pendingPages -eq 0 -and $null -ne (Widget-ByName $s 'tam_xoa')
    } 'tam_xoa rendered on PDFium overlay'

    Send 'action undoedit' | Out-Null
    WaitFor {
        $s = State
        $s.pending -eq 0 -and $s.forms.pendingPages -eq 0 -and $null -eq (Widget-ByName $s 'tam_xoa') -and (-not (Control-Disabled $s 'viewer-redo'))
    } 'Undo removes tam_xoa widget'
    $sUndo = State
    $undoOk = $null -eq (Widget-ByName $sUndo 'tam_xoa') -and $null -ne (Widget-ByName $sUndo 'hoten') -and $null -ne (Widget-ByName $sUndo 'chuky')

    Send 'action redoedit' | Out-Null
    WaitFor {
        $s = State
        $s.pending -eq 0 -and $s.forms.pendingPages -eq 0 -and $null -ne (Widget-ByName $s 'tam_xoa')
    } 'Redo restores tam_xoa widget'
    $redoOk = $null -ne (Widget-ByName (State) 'tam_xoa')

    Send 'action undoedit' | Out-Null
    WaitFor {
        $s = State
        $s.pending -eq 0 -and $s.forms.pendingPages -eq 0 -and $null -eq (Widget-ByName $s 'tam_xoa')
    } 'Second Undo removes tam_xoa cleanly before save'
    Expect 'Undo and Redo cleanly add/remove created form field' ($undoOk -and $redoOk) "undo=$undoOk redo=$redoOk"

    # Save via Ctrl+S
    Send 'action saveedit' | Out-Null
    WaitFor { $s = State; (-not $s.tabs[0].dirty) -and $s.pending -eq 0 } 'Ctrl+S saves created form'
    Expect 'Ctrl+S saves created form PDF cleanly' (-not (State).tabs[0].dirty)
    Stop-FormsApp 'pass1'

    # Core / pikepdf inspection on disk
    Push-Location (Join-Path $repo 'core')
    try {
        $verifiedRaw = & uv run --no-project python -c $verifyPy $formPdf
        if ($LASTEXITCODE -ne 0) { throw "core verify failed: $verifiedRaw" }
    } finally { Pop-Location }
    $verified = $verifiedRaw | ConvertFrom-Json
    $vf = $verified.fields
    $vsig = @($verified.sigs | Where-Object { $_.name -eq 'chuky' })
    Expect 'saved PDF on disk contains all 6 core/pikepdf fields with properties' (
        $null -eq $vf.tam_xoa -and
        $vf.hoten.type -eq 'text' -and $vf.hoten.flags.required -eq $true -and $vf.hoten.tooltip -eq 'Họ và tên' -and
        $vf.cmnd.type -eq 'comb' -and $vf.cmnd.flags.maxLen -eq 9 -and
        $vf.dongy.type -eq 'checkbox' -and
        $vf.gioitinh.type -eq 'radio' -and (@($vf.gioitinh.options | ForEach-Object { $_.export }) -join ',') -eq 'nam,nu' -and
        $vf.tinh.type -eq 'dropdown' -and (@($vf.tinh.options | ForEach-Object { $_.export }) -join ',') -eq 'Ha Noi,HCM,Da Nang' -and
        $vf.chuky.type -eq 'signature' -and $vsig.Count -eq 1 -and $vsig[0].signed -eq $false
    ) $verifiedRaw

    # Pass 2: Reopen saved PDF in fresh chef-app.exe, verify PDFium overlay (without core), then fill hoten & save
    Start-FormsApp @($formPdf) 'pass2'
    WaitFor {
        $s = State
        $s.tabs.Count -eq 1 -and $s.cached -gt 0 -and $s.pending -eq 0 -and $s.forms.pendingPages -eq 0 -and $s.forms.widgets.Count -ge 7
    } 'reopened created form PDF loaded in PDFium'
    $sReopen = State
    $coreReopen = @(Get-CoreProcesses $proc.Id).Count
    $radioWidgets = @($sReopen.forms.widgets | Where-Object { $_.name -eq 'gioitinh' })
    Expect 'reopened PDF loads all created widgets in PDFium with zero chef-core' (
        $coreReopen -eq 0 -and
        $sReopen.forms.formType -eq 'acroform' -and
        $sReopen.forms.formEnvActive -eq $true -and
        $null -ne (Widget-ByName $sReopen 'hoten') -and
        $null -ne (Widget-ByName $sReopen 'cmnd') -and
        $null -ne (Widget-ByName $sReopen 'dongy') -and
        $radioWidgets.Count -eq 2 -and
        $null -ne (Widget-ByName $sReopen 'tinh') -and
        $null -ne (Widget-ByName $sReopen 'chuky')
    ) "core=$coreReopen formType=$($sReopen.forms.formType) widgets=$($sReopen.forms.widgets.Count) radios=$($radioWidgets.Count)"

    Send 'action openforms' | Out-Null
    WaitFor { $s = State; $s.forms.dialogOpen -eq $true -and $s.forms.dialogFields.Count -eq 6 } 'reopened Biểu mẫu PDF lists all 6 fields'
    Click-Control 'form-field-hoten'
    Send 'action selectall' | Out-Null
    Send 'char Nguyễn Văn Tạo' | Out-Null
    WaitFor { (Field-ByName (State) 'hoten').value -eq 'Nguyễn Văn Tạo' } 'filled hoten on newly created form'
    Click-Control 'forms-apply'
    WaitFor {
        $s = State
        (-not $s.forms.dialogOpen) -and $s.pending -eq 0 -and $s.forms.pendingPages -eq 0 -and $s.tabs[0].dirty
    } 'filled value applied on created form'
    Send 'action saveedit' | Out-Null
    WaitFor { $s = State; (-not $s.tabs[0].dirty) -and $s.pending -eq 0 } 'filled created form saved'
    Expect 'created fields can be filled and saved back to PDF' (-not (State).tabs[0].dirty)
    Stop-FormsApp 'pass2'

    # Confirm filled value on disk with core export_values
    Push-Location (Join-Path $repo 'core')
    try {
        $exportedRaw = & uv run --no-project python -c $exportValuesPy $formPdf
        if ($LASTEXITCODE -ne 0) { throw "export_values failed: $exportedRaw" }
    } finally { Pop-Location }
    $exported = $exportedRaw | ConvertFrom-Json
    Expect 'core export_values reads filled value on newly created field' ($exported.hoten -eq 'Nguyễn Văn Tạo') $exportedRaw

    # Pass 3: Cross-open in real Electron app when UI/desktop dist are built
    $uiDist = Join-Path $repo 'apps\ui\dist\index.html'
    $desktopDist = Join-Path $repo 'apps\desktop\dist'
    if ((Test-Path -LiteralPath $uiDist) -and (Test-Path -LiteralPath $desktopDist)) {
        Set-Content -LiteralPath $electronScript -Value $electronCheckJs -Encoding UTF8
        $electronOut = & node $electronScript $repo $formPdf $electronDataDir 2>&1
        $electronOk = ($LASTEXITCODE -eq 0) -and (($electronOut -join "`n") -match 'ELECTRON_VERIFIED')
        Expect 'saved created-form PDF opens and displays all 6 fields cleanly in real Electron' $electronOk ($electronOut -join "`n")
    } else {
        throw "Electron dist missing ($uiDist / $desktopDist); build required before R4.23 cross-open check"
    }

    Write-Output "PASS: R4.23 form creation, validation, Undo/Redo, PDFium, pikepdf, and Electron E2E completed cleanly (FAILS: $($script:fails))"
    if ($script:fails -gt 0) { throw "R4.23 E2E failed with $($script:fails) failure(s)" }
} finally {
    if ($proc -and -not $proc.HasExited) {
        try { Send 'quit' | Out-Null; Start-Sleep -Milliseconds 300 } catch {}
        if (-not $proc.HasExited) { $proc.Kill() }
    }
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Restore-Env 'CHEF_E2E_SAVE_AS_PATH' $oldSaveAs
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
