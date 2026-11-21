#requires -Version 7.0
<#
.SYNOPSIS
  R4.10 E2E for bookmark add, rename, delete, reorder, and undo.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-bookmarks-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$source = Join-Path $work 'bookmarks.pdf'
$log = Join-Path $work 'app.log'
$proc = $null
$pipe = $null
$token = $null
$fails = 0
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
function Expect([string]$Name, [bool]$Condition, [string]$Detail) {
    if ($Condition) { Write-Output "PASS $Name" }
    else { $script:fails++; Write-Output "FAIL $Name : $Detail" }
}
function Click-Control([string]$Id) {
    WaitFor { $c = Control $Id; $null -ne $c -and $null -ne $c.bounds } "bounds for $Id"
    $snapshot = State
    $control = $snapshot.controls.controls | Where-Object id -eq $Id | Select-Object -First 1
    $scale = [double]$snapshot.controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $scale)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $scale)
    Send "click $x $y" | Out-Null
    Start-Sleep -Milliseconds 180
}
function Row-Names() {
    return @((State).controls.controls | Where-Object { $_.id -like 'bookmark-row-*' } | ForEach-Object name)
}
function Drag-Control([string]$From, [string]$To, [bool]$After) {
    WaitFor { $a = Control $From; $b = Control $To; $a -and $a.bounds -and $b -and $b.bounds } "drag controls $From/$To"
    $snapshot = State
    $a = $snapshot.controls.controls | Where-Object id -eq $From | Select-Object -First 1
    $b = $snapshot.controls.controls | Where-Object id -eq $To | Select-Object -First 1
    $scale = [double]$snapshot.controls.scale
    $sx = [int](($a.bounds[0] + $a.bounds[2] / 2) * $scale)
    $sy = [int](($a.bounds[1] + $a.bounds[3] / 2) * $scale)
    $tx = [int](($b.bounds[0] + $b.bounds[2] / 2) * $scale)
    $fraction = if ($After) { 0.8 } else { 0.2 }
    $ty = [int](($b.bounds[1] + $b.bounds[3] * $fraction) * $scale)
    Send "mouse move $sx $sy" | Out-Null
    Send "mouse down $sx $sy" | Out-Null
    Start-Sleep -Milliseconds 120
    Send "mouse move $($sx + 5) $($sy + 5)" | Out-Null
    Start-Sleep -Milliseconds 100
    Send "mouse move $tx $ty" | Out-Null
    Start-Sleep -Milliseconds 100
    Start-Sleep -Milliseconds 150
    Send "mouse up $tx $ty" | Out-Null
    Start-Sleep -Milliseconds 250
}

try {
    New-Item -ItemType Directory -Force -Path $work, $dataDir | Out-Null
    $fixture = @'
import pikepdf, sys
pdf = pikepdf.Pdf.new()
for _ in range(3): pdf.add_blank_page(page_size=(612, 792))
with pdf.open_outline() as outline:
    outline.root.append(pikepdf.OutlineItem("Alpha", 0, color=(1.0, 0.0, 0.0), flags=pikepdf.OutlineItemFlag.Bold))
    outline.root.append(pikepdf.OutlineItem("Beta", 1))
    outline.root.append(pikepdf.OutlineItem("Gamma", 2))
pdf.save(sys.argv[1], static_id=True)
'@
    Push-Location (Join-Path $repo 'core')
    try {
        & uv run --no-project python -c $fixture $source
        if ($LASTEXITCODE -ne 0) { throw 'bookmark fixture generation failed' }
    } finally { Pop-Location }

    $env:CHEF_E2E = '1'
    $env:CHEF_USER_DATA_DIR = $dataDir
    $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $source + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $log)) {
        if ($proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)) before startup. $(Get-Content $log -Raw -ErrorAction SilentlyContinue)" }
        Start-Sleep -Milliseconds 100
    }
    WaitFor { (Get-Content $log -Raw -ErrorAction SilentlyContinue) -match 'CHEF_DEBUG_TOKEN=' } 'debug pipe startup'
    $logText = Get-Content $log -Raw
    $pipe = [regex]::Match($logText, 'chef-native-\d+').Value
    $token = [regex]::Match($logText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    if (-not $pipe -or -not $token) { throw 'debug pipe/token missing from app log' }

    Send 'action openpalette' | Out-Null
    Send 'char bookmarks' | Out-Null
    WaitFor { ((State).palette.results | Where-Object id -eq 'bookmarks.edit').Count -gt 0 } 'bookmark command search result'
    Send 'key 13' | Out-Null
    WaitFor { (Control 'bookmarks-apply') -ne $null } 'bookmark editor'
    Expect 'initial outline has three entries' ((Row-Names).Count -eq 3) 'expected Alpha, Beta, Gamma'

    Drag-Control 'bookmark-row-0' 'bookmark-row-2' $true
    $names = Row-Names
    Expect 'drag reorders sibling bookmarks' (($names.Count -eq 3) -and $names[0].StartsWith('Beta') -and $names[2].StartsWith('Alpha')) ($names -join ', ')

    Click-Control 'bookmarks-add'
    Expect 'add inserts a bookmark' ((Row-Names).Count -eq 4) 'expected four rows after add'
    Click-Control 'bookmarks-delete'
    Expect 'delete removes the selected bookmark' ((Row-Names).Count -eq 3) 'expected three rows after delete'

    Click-Control 'bookmark-row-0'
    $initialTitle = (Control 'bookmarks-title').value
    Expect 'selected bookmark title fills the field' ($initialTitle -eq 'Beta') "value was [$initialTitle]"
    Click-Control 'bookmarks-title'
    $titleControl = Control 'bookmarks-title'
    Expect 'bookmark title field receives focus' $titleControl.focused 'title textbox is not focused'
    Send 'action selectall' | Out-Null
    Start-Sleep -Milliseconds 300
    Send 'action backspace' | Out-Null
    Start-Sleep -Milliseconds 300
    Send 'char Renamed' | Out-Null
    Start-Sleep -Milliseconds 300
    $titleControl = Control 'bookmarks-title'
    Expect 'title field accepts replacement text' ($titleControl.value -eq 'Renamed') "value was [$($titleControl.value)]"
    Click-Control 'bookmarks-apply'
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $true } 'bookmark revision'

    Send 'action editbookmarks' | Out-Null
    WaitFor { (Control 'bookmarks-apply') -ne $null } 'reopen bookmark editor'
    $names = Row-Names
    Expect 'rename appears in refreshed outline' ($names[0].StartsWith('Renamed')) ($names -join ', ')
    Click-Control 'bookmarks-cancel'
    Send 'action undoedit' | Out-Null
    WaitFor { ((State).tabs | Where-Object active | Select-Object -First 1).dirty -eq $false } 'bookmark undo'
    Send 'action editbookmarks' | Out-Null
    WaitFor { (Control 'bookmarks-apply') -ne $null } 'reopen after undo'
    $names = Row-Names
    Expect 'undo restores the original outline' (($names.Count -eq 3) -and $names[0].StartsWith('Alpha') -and $names[1].StartsWith('Beta') -and $names[2].StartsWith('Gamma')) ($names -join ', ')

    Send 'quit' | Out-Null
    if ($fails -gt 0) { throw "R4.10 E2E failed with $fails failure(s)" }
    Write-Output 'PASS R4.10 native bookmark E2E'
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
