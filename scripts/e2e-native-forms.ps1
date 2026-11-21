#requires -Version 7.0
<#
.SYNOPSIS
  R4.21 E2E: PDFium form-fill FFI lifecycle, widget overlay accuracy across 3 widths, JS/XFA
  isolation, and clean teardown without starting chef-core.
.DESCRIPTION
  Windows only. Runs off-screen through the authenticated debug pipe.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-forms-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$formPdf = Join-Path $work 'form.pdf'
$plainPdf = Join-Path $work 'plain.pdf'
$flatPdf = Join-Path $work 'flattened.pdf'
$log = Join-Path $work 'app.log'
$proc = $null
$passed = $false
$script:fails = 0
$script:pipe = $null
$script:token = $null

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
            throw "chef-app exited ($($proc.ExitCode)) waiting for $What. $(Get-Content $log -Raw -ErrorAction SilentlyContinue)"
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
from chef_core.forms.model import FormDoc
from chef_core.forms.flatten import flatten

form_path = Path(sys.argv[2])
plain_path = Path(sys.argv[3])
flat_path = Path(sys.argv[4])

pikepdf_form(form_path)
with pikepdf.open(form_path) as src:
    flatten(FormDoc(src))
    src.save(flat_path)

with pikepdf.open(form_path, allow_overwriting_input=True) as pdf:
    page = pdf.pages[0]
    sig = pdf.make_indirect(Dictionary(
        Type=Name.Annot,
        Subtype=Name.Widget,
        F=4,
        P=page.obj,
        FT=Name.Sig,
        T=pikepdf.String("chuky"),
        Rect=Array([160, 4, 280, 22]),
    ))
    page.obj.Annots.append(sig)
    pdf.Root.AcroForm.Fields.append(sig)
    # Inject a catalog /OpenAction JavaScript to verify JS suppression under FPDFDOC_InitFormFillEnvironment.
    pdf.Root.OpenAction = pdf.make_indirect(Dictionary(
        Type=Name.Action,
        S=Name.JavaScript,
        JS=pikepdf.String('this.getField("hoten").value = "JS_RAN"; app.alert("JS_RAN");'),
    ))
    pdf.save(form_path)

with pikepdf.new() as plain:
    plain.add_blank_page(page_size=(595, 842))
    plain.save(plain_path)
'@

try {
    New-Item -ItemType Directory -Force -Path $work, $dataDir | Out-Null
    Push-Location (Join-Path $repo 'core')
    try {
        & uv run --no-project python -c $fixturePy (Join-Path $repo 'core\tests') $formPdf $plainPdf $flatPdf
        if ($LASTEXITCODE -ne 0) { throw 'fixture generation failed' }
    } finally { Pop-Location }

    # Pass 1: form.pdf + plain.pdf
    Start-FormsApp @($formPdf, $plainPdf) 'pass1'
    WaitFor { $s = State; $s.tabs.Count -eq 2 -and $s.tabs[1].active -and $s.cached -gt 0 -and $s.pending -eq 0 } 'initial tabs ready'
    $formTabId = [int](State).tabs[0].id
    Click-Control "doc-tab-$formTabId"
    WaitFor { $s = State; $s.tabs[0].active -and $s.cached -gt 0 -and $s.pending -eq 0 -and $s.forms.pendingPages -eq 0 -and $s.forms.widgets.Count -ge 12 } 'form widgets loaded'

    $s0 = State
    $coreCount0 = @(Get-CoreProcesses $proc.Id).Count
    Expect 'viewing form PDF never spawns chef-core' ($coreCount0 -eq 0) "core=$coreCount0"
    Expect 'form-fill initializes with AcroForm and JS/XFA disabled' ($s0.forms.formType -eq 'acroForm' -and $s0.forms.formEnvActive -eq $true -and $s0.forms.activeFormEnvs -eq 1 -and $s0.forms.jsEnabled -eq $false -and $s0.forms.xfaLoaded -eq $false) "type=$($s0.forms.formType) active=$($s0.forms.activeFormEnvs) js=$($s0.forms.jsEnabled) xfa=$($s0.forms.xfaLoaded)"

    $byName = @{}
    foreach ($w in $s0.forms.widgets) {
        if (-not $byName.ContainsKey($w.name)) { $byName[$w.name] = @() }
        $byName[$w.name] += $w
    }
    $hoten = $byName['hoten'] | Select-Object -First 1
    $tong = $byName['tong'] | Select-Object -First 1
    $ghichu = $byName['ghichu'] | Select-Object -First 1
    $cmnd = $byName['cmnd'] | Select-Object -First 1
    $dongy = $byName['dongy'] | Select-Object -First 1
    $radios = @($byName['gioitinh'])
    $tinh = $byName['tinh'] | Select-Object -First 1
    $ngonngu = $byName['ngonngu'] | Select-Object -First 1
    $ma = $byName['ma'] | Select-Object -First 1
    $chuky = $byName['chuky'] | Select-Object -First 1

    Expect 'JavaScript actions in /OpenAction and /AA did not run' ($hoten.value -ne 'JS_RAN' -and $tong.value -ne '1') "hoten=$($hoten.value) tong=$($tong.value)"
    Expect 'every expected widget kind and state is parsed' (
        $hoten.kind -eq 'text' -and
        $ghichu.kind -eq 'multiline' -and
        $cmnd.kind -eq 'comb' -and
        $dongy.kind -eq 'checkbox' -and $dongy.checked -eq $true -and
        $radios.Count -eq 2 -and ($radios | Where-Object { $_.checked -eq $false }).Count -eq 2 -and
        $tinh.kind -eq 'dropdown' -and $tinh.options.Count -ge 2 -and
        $ngonngu.kind -eq 'listbox' -and $ngonngu.options.Count -eq 3 -and
        $ma.readOnly -eq $true -and $ma.value -eq 'MA-01' -and
        $chuky.kind -eq 'signature'
    ) "kinds=$(($s0.forms.widgets | ForEach-Object { "$($_.name):$($_.kind)" }) -join ',')"

    # Audit overlay geometry across 3 viewport widths (R4.21): 800, 1184, 1484
    $zooms = @()
    $prevZoom = [double]$s0.view.zoom
    foreach ($width in @(800, 1184, 1484)) {
        Send "resize $width 860" | Out-Null
        WaitFor {
            $s = State
            [math]::Abs([double]$s.view.zoom - $prevZoom) -gt 0.05 -and $s.pending -eq 0 -and $s.forms.pendingPages -eq 0 -and $s.forms.widgets.Count -ge 12
        } "viewport settle at width $width"
        Start-Sleep -Milliseconds 120
        $sw = State
        $zoom = [double]$sw.view.zoom
        $prevZoom = $zoom
        $zooms += $zoom

        $controlsById = @{}
        foreach ($c in $sw.controls.controls) { $controlsById[$c.id] = $c }

        $maxDelta = 0.0
        $insidePage = $true
        $a11yMatch = $true
        foreach ($w in $sw.forms.widgets) {
            $pb = $w.pageBounds
            $rp = $w.rectPt
            $b = $w.bounds
            $expX = [double]$pb[0] + [double]$rp[0] * $zoom
            $expY = [double]$pb[1] + [double]$rp[1] * $zoom
            $expW = [math]::Max(2.0, ([double]$rp[2] - [double]$rp[0]) * $zoom)
            $expH = [math]::Max(2.0, ([double]$rp[3] - [double]$rp[1]) * $zoom)
            $d = @([math]::Abs([double]$b[0] - $expX), [math]::Abs([double]$b[1] - $expY), [math]::Abs([double]$b[2] - $expW), [math]::Abs([double]$b[3] - $expH))
            foreach ($dv in $d) { if ($dv -gt $maxDelta) { $maxDelta = $dv } }
            if ([double]$b[0] -lt ([double]$pb[0] - 1.0) -or [double]$b[1] -lt ([double]$pb[1] - 1.0) -or
                ([double]$b[0] + [double]$b[2]) -gt ([double]$pb[0] + [double]$pb[2] + 1.0) -or
                ([double]$b[1] + [double]$b[3]) -gt ([double]$pb[1] + [double]$pb[3] + 1.0)) {
                $insidePage = $false
            }
            $ctrl = $controlsById[$w.id]
            if ($null -eq $ctrl -or $null -eq $ctrl.bounds) {
                $a11yMatch = $false
            } else {
                for ($k = 0; $k -lt 4; $k++) {
                    if ([math]::Abs([double]$ctrl.bounds[$k] - [double]$b[$k]) -gt 1.5) { $a11yMatch = $false }
                }
            }
        }
        Expect "widget overlay tracks zoom & page bounds at width $width" ($maxDelta -lt 1.5 -and $insidePage -and $a11yMatch) "maxDelta=$maxDelta inside=$insidePage a11y=$a11yMatch zoom=$zoom"
    }
    Expect 'auto-fit zoom scales monotonically across 800/1184/1484' ($zooms[0] -lt $zooms[1] -and $zooms[1] -lt $zooms[2]) "zooms=$($zooms -join ',')"

    # Closing the form tab must release its PDFium form-fill environment cleanly
    $inits = [int]$s0.forms.totalFormInits
    Send 'action closetab' | Out-Null
    WaitFor { $s = State; $s.tabs.Count -eq 1 -and $s.tabs[0].title -eq 'plain.pdf' -and $s.forms.activeFormEnvs -eq 0 } 'form tab closed and form env exited'
    $sClosed = State
    $coreEnd = @(Get-CoreProcesses $proc.Id).Count
    Expect 'closing form tab frees form-fill environment cleanly' ($sClosed.forms.activeFormEnvs -eq 0 -and $sClosed.forms.totalFormExits -eq $inits -and $sClosed.forms.widgets.Count -eq 0 -and $coreEnd -eq 0) "exits=$($sClosed.forms.totalFormExits) inits=$inits widgets=$($sClosed.forms.widgets.Count) core=$coreEnd"

    Stop-FormsApp 'pass1'

    # Pass 2: flattened form PDF has zero interactive widgets & no active form env
    Start-FormsApp @($flatPdf) 'pass2'
    WaitFor { $s = State; $s.tabs.Count -eq 1 -and $s.cached -gt 0 -and $s.pending -eq 0 } 'flattened pdf ready'
    $sFlat = State
    $coreFlat = @(Get-CoreProcesses $proc.Id).Count
    Expect 'flattened PDF shows no interactive form widgets and spawns no core' ($sFlat.forms.formType -eq 'none' -and $sFlat.forms.activeFormEnvs -eq 0 -and $sFlat.forms.widgets.Count -eq 0 -and $coreFlat -eq 0) "formType=$($sFlat.forms.formType) envs=$($sFlat.forms.activeFormEnvs) widgets=$($sFlat.forms.widgets.Count)"

    Stop-FormsApp 'pass2'

    Write-Output "FAILS: $script:fails"
    if ($script:fails -gt 0) { exit 1 }
    $passed = $true
    exit 0
} finally {
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Restore-Env 'CHEF_E2E_SAVE_AS_PATH' $oldSaveAs
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        if (-not $proc.WaitForExit(5000)) { Write-Warning "chef-app $($proc.Id) did not exit during cleanup." }
    }
    if ($passed) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    else { Write-Warning "E2E artifacts retained for diagnosis: $work" }
}
