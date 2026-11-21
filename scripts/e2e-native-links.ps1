#requires -Version 7.0
<#
.SYNOPSIS
  R4.15 E2E for links manager, bad URL allowlist rejection, hover overlay, link activation and undo.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-links-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$source = Join-Path $work 'links.pdf'
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
import sys
c = canvas.Canvas(sys.argv[1], pagesize=(612, 792))
c.setFont("Helvetica", 18)
c.drawString(72, 720, "Page 1 links fixture")
c.showPage()
c.setFont("Helvetica", 18)
c.drawString(72, 720, "Page 2 target")
c.save()
'@

$verifyTwoPy = @'
import pikepdf, sys
with pikepdf.open(sys.argv[1]) as pdf:
    annots = [a for a in (pdf.pages[0].get('/Annots') or []) if str(a.get('/Subtype')) == '/Link']
    assert len(annots) == 2, annots
    dest = annots[0].get('/Dest')
    assert dest is not None and dest[0] == pdf.pages[1].obj, annots[0]
    act = annots[1].get('/A')
    assert act is not None and str(act.get('/URI')) == 'mailto:hello@example.com', annots[1]
print('VERIFIED two links persisted in PDF')
'@

$verifyOnePy = @'
import pikepdf, sys
with pikepdf.open(sys.argv[1]) as pdf:
    annots = [a for a in (pdf.pages[0].get('/Annots') or []) if str(a.get('/Subtype')) == '/Link']
    assert len(annots) == 1, annots
print('VERIFIED one link persisted after remove')
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

    # 1-2. Open Links manager and add internal page link (page 1 -> page 2)
    Click-Control 'links-manager'
    WaitFor { (Control 'links-add') -ne $null } 'links manager open'
    Click-Control 'links-add'
    Click-Control 'links-kind'
    WaitFor { (Control 'links-kind').name -match 'Page|Trang' } 'switch link kind to Page'
    Type-Field 'links-target' '2'
    Click-Control 'links-apply'
    WaitFor { (Control 'links-row-0') -ne $null } 'page link added'

    # 3. Reject bad URLs (javascript:, file:, ftp:)
    Click-Control 'links-add'
    if ((Control 'links-kind').name -match 'Page|Trang') {
        Click-Control 'links-kind'
        WaitFor { (Control 'links-kind').name -match 'Web' } 'switch link kind back to Web'
    }
    foreach ($badUrl in @('javascript:alert(1)', 'file:///C:/Windows/win.ini', 'ftp://example.com')) {
        Type-Field 'links-target' $badUrl -Replace
        Click-Control 'links-apply'
        WaitFor { $null -ne (State).message -and (State).message -match 'http|mailto' } "reject $badUrl"
        if ((Control 'links-row-1') -ne $null) { throw "Bad URL $badUrl created a link!" }
    }
    Write-Host 'VERIFIED bad URLs rejected'

    # 4. Add valid web link
    Type-Field 'links-target' 'https://example.com/docs' -Replace
    Click-Control 'links-apply'
    WaitFor { (Control 'links-row-1') -ne $null } 'web link added'

    # 5. Edit 2nd link to mailto:hello@example.com
    Click-Control 'links-row-1'
    Type-Field 'links-target' 'mailto:hello@example.com' -Replace
    Click-Control 'links-apply'
    WaitFor { (Control 'links-row-1').name -match 'mailto:hello@example\.com' } 'edited link to mailto'

    # 6. Close dialog, save and verify 2 links in PDF
    Click-Control 'links-close'
    WaitFor { (Control 'links-close') -eq $null } 'links dialog closed'
    Save-Doc 'two links'
    Py $verifyTwoPy @($source)

    # 7. Hover over link 1 -> verify hoveredLink, then click -> verify openedUrl
    $st = State
    if ($st.linksOverlay.Count -lt 2) { throw "Expected 2 links in overlay, got $($st.linksOverlay.Count)" }
    $scale = [double]$st.scale
    $link1 = $st.linksOverlay[1]
    $cx1 = [int](($link1.bounds[0] + $link1.bounds[2] / 2) * $scale)
    $cy1 = [int](($link1.bounds[1] + $link1.bounds[3] / 2) * $scale)
    Send "pointer move $cx1 $cy1" | Out-Null
    WaitFor { (State).hoveredLink -eq $link1.id } 'hover overlay on mailto link'
    Write-Host 'VERIFIED hover overlay highlights link'

    Send "click $cx1 $cy1" | Out-Null
    WaitFor { (State).openedUrl -eq 'mailto:hello@example.com' } 'opened mailto url'
    Write-Host 'VERIFIED click opened external mailto URL'

    # 8. Click link 0 -> jumps to page 2 (firstPage == 1)
    $link0 = $st.linksOverlay[0]
    $cx0 = [int](($link0.bounds[0] + $link0.bounds[2] / 2) * $scale)
    $cy0 = [int](($link0.bounds[1] + $link0.bounds[3] / 2) * $scale)
    Send "click $cx0 $cy0" | Out-Null
    WaitFor { (State).view.firstPage -eq 1 } 'page link jumped to page 2'
    Write-Host 'VERIFIED page link jumped to page 2'

    # 9. Delete link 1, save, then Ctrl+Z undo + save -> both links restored
    Click-Control 'links-manager'
    WaitFor { (Control 'links-row-1') -ne $null } 'links dialog reopened'
    Click-Control 'links-row-1'
    Click-Control 'links-delete'
    WaitFor { (Control 'links-row-1') -eq $null } 'link 1 deleted'
    Click-Control 'links-close'
    WaitFor { (Control 'links-close') -eq $null } 'links dialog closed before save'
    Save-Doc 'one link after delete'
    Py $verifyOnePy @($source)

    Send 'keystroke ctrl-z' | Out-Null
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $true } 'undo delete revision'
    Save-Doc 'undo restore links'
    Py $verifyTwoPy @($source)
    Write-Host 'VERIFIED delete and undo restore links'

    try { Send 'quit' | Out-Null } catch { }
    Write-Output 'PASS R4.15 links E2E'
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
