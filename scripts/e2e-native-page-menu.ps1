#requires -Version 7.0
<#
.SYNOPSIS
  R4.05/R4.06 E2E: signed-page context menu, source protection, and extraction to a new tab.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-pagemenu-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$log = Join-Path $work 'app.log'
$source = Join-Path $work 'signed.pdf'
$extracted = Join-Path $work 'extracted.pdf'
$proc = $null
$passed = $false
$fails = 0
$pipe = $null
$token = $null
$oldE2E = $env:CHEF_E2E
$oldUserData = $env:CHEF_USER_DATA_DIR
$oldExtractPath = $env:CHEF_E2E_EXTRACT_PATH

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
function WaitFor([scriptblock]$Predicate, [string]$What, [int]$Seconds = 60) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($proc -and $proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)) waiting for $What. $(Get-Content $log -Raw -ErrorAction SilentlyContinue)" }
        if (& $Predicate) { return }
        Start-Sleep -Milliseconds 150
    }
    throw "Timed out waiting for $What. $(Get-Content $log -Raw -ErrorAction SilentlyContinue)"
}
function Expect([string]$Name, [bool]$Condition, [string]$Detail) {
    if ($Condition) { Write-Output "PASS $Name" }
    else { $script:fails++; Write-Output "FAIL $Name : $Detail" }
}
function Click-Control([string]$Id, [string]$Button = '') {
    $snapshot = State
    $control = $snapshot.controls.controls | Where-Object { $_.id -eq $Id } | Select-Object -First 1
    if ($null -eq $control -or $null -eq $control.bounds) { throw "Missing control bounds for $Id" }
    $scale = [double]$snapshot.controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $scale)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $scale)
    if ($Button -eq 'right') {
        Send "mouse move $x $y" | Out-Null
        Start-Sleep -Milliseconds 80
        Send "mouse rdown $x $y" | Out-Null
        Start-Sleep -Milliseconds 60
        Send "mouse rup $x $y" | Out-Null
    } else {
        Send "click $x $y" | Out-Null
    }
    Start-Sleep -Milliseconds 180
}

try {
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $fixture = @'
import pikepdf, sys
pdf = pikepdf.Pdf.new()
page = pdf.add_blank_page(page_size=(612, 792))
sig = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Sig, Filter=pikepdf.Name('/Adobe.PPKLite'), SubFilter=pikepdf.Name('/adbe.pkcs7.detached'), Contents=pikepdf.String(b'\x00' * 16), ByteRange=pikepdf.Array([0, 0, 0, 0])))
widget = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget, FT=pikepdf.Name.Sig, T=pikepdf.String('Signature1'), V=sig, Rect=pikepdf.Array([0, 0, 0, 0]), F=132, P=page.obj))
page.obj.Annots = pikepdf.Array([widget])
pdf.Root.AcroForm = pikepdf.Dictionary(Fields=pikepdf.Array([widget]), SigFlags=3)
pdf.save(sys.argv[1], static_id=True)
'@
    Push-Location (Join-Path $repo 'core')
    try {
        & uv run --no-project python -c $fixture $source
        if ($LASTEXITCODE -ne 0) { throw 'signed fixture generation failed' }
    } finally { Pop-Location }
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash

    $env:CHEF_E2E = '1'
    $env:CHEF_USER_DATA_DIR = $dataDir
    $env:CHEF_E2E_EXTRACT_PATH = $extracted
    $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $source + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden -Environment @{
        CHEF_E2E = '1'
        CHEF_USER_DATA_DIR = $dataDir
        CHEF_E2E_EXTRACT_PATH = $extracted
    }
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Restore-Env 'CHEF_E2E_EXTRACT_PATH' $oldExtractPath

    WaitFor {
        if (-not (Test-Path -LiteralPath $log)) { return $false }
        $text = [string](Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue)
        $script:pipe = [regex]::Match($text, 'chef-native-\d+').Value
        $script:token = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
        if (-not $script:pipe -or -not $script:token) { return $false }
        try { return ((State).view.pageCount -eq 1) } catch { return $false }
    } 'signed PDF opens' 60

    Click-Control 'thumbnail-1' 'right'
    WaitFor { $null -ne (Control 'page-context-menu') } 'signed page menu opens'
    Expect 'signed PDF locks rotate' ((Control 'page-menu-rotate-left').disabled -eq $true) 'rotate was enabled'
    Expect 'signed PDF locks delete' ((Control 'page-menu-delete').disabled -eq $true) 'delete was enabled'
    Expect 'signed PDF keeps create-PDF available' ((Control 'page-menu-create-pdf').disabled -eq $false) 'create-PDF was disabled'
    WaitFor { (Control 'page-menu-create-pdf').focused -eq $true } 'create-PDF menu item receives focus'
    Send 'key 13' | Out-Null
    WaitFor { (Test-Path -LiteralPath $extracted) -and (State).tabs.Count -eq 2 } 'signed page extraction opens new tab'
    Expect 'signed source file hash remains unchanged' ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -eq $sourceHash) 'source SHA-256 changed'

    Send 'closewindow' | Out-Null
    if (-not $proc.WaitForExit(15000)) { throw 'chef-app did not exit cleanly' }
    Expect 'signed extraction closes cleanly' ($proc.ExitCode -eq 0) "exit=$($proc.ExitCode)"
    if ($fails -gt 0) { throw "R4.05/R4.06 signed E2E failed with $fails failure(s)" }
    $passed = $true
} finally {
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Restore-Env 'CHEF_E2E_EXTRACT_PATH' $oldExtractPath
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        $proc.WaitForExit(5000) | Out-Null
    }
    if ($passed) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    else { Write-Warning "E2E artifacts retained for diagnosis: $work" }
}

Write-Output "FAILS: $fails"
if ($fails -gt 0) { exit 1 }
