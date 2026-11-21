#requires -Version 7.0
<#
.SYNOPSIS
  R4.02 E2E: multi-page selection (plain, Shift, Ctrl, Ctrl+Shift), list/grid sync,
  invert, odd/even, select-all, and clear.
.DESCRIPTION
  Windows only. Requires chef-app.exe and pdfium.dll. Uses CHEF_E2E=1 and the authenticated debug pipe.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-pagesel-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$log = Join-Path $work 'app.log'
$pdf = Join-Path $work 'select-6.pdf'

$oldE2E = $env:CHEF_E2E
$oldUserData = $env:CHEF_USER_DATA_DIR
$proc = $null
$passed = $false
$script:pipe = $null
$script:token = $null
$script:fails = 0

function Restore-Env([string]$Name, [AllowNull()][string]$Value) {
    if ($null -eq $Value) { Remove-Item "Env:$Name" -ErrorAction SilentlyContinue }
    else { Set-Item "Env:$Name" $Value }
}

function Expect([string]$Name, [bool]$Condition, [string]$Detail) {
    if ($Condition) {
        Write-Output "PASS $Name"
    } else {
        $script:fails++
        Write-Output "FAIL $Name : $Detail"
    }
}

function Send([string]$Command) {
    if (-not $script:pipe -or -not $script:token) { throw 'Debug pipe/token are not ready.' }
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
    } finally {
        $client.Dispose()
    }
}

function State() { return (Send 'state' | ConvertFrom-Json) }

function WaitFor([scriptblock]$Predicate, [string]$What, [int]$Seconds = 45) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($proc -and $proc.HasExited) {
            throw "chef-app exited ($($proc.ExitCode)) while waiting for $What. Log: $(Get-Content $log -Raw -ErrorAction SilentlyContinue)"
        }
        if (& $Predicate) { return }
        Start-Sleep -Milliseconds 150
    }
    throw "Timed out waiting for $What. Log: $(Get-Content $log -Raw -ErrorAction SilentlyContinue)"
}

function Click-Control([string]$Id, [string]$Mods = '') {
    $script:targetControl = $null
    $script:targetSnapshot = $null
    WaitFor {
        $snap = State
        $c = $snap.controls.controls | Where-Object { $_.id -eq $Id } | Select-Object -First 1
        if ($null -ne $c -and $null -ne $c.bounds) {
            $script:targetSnapshot = $snap
            $script:targetControl = $c
            return $true
        }
        return $false
    } "control bounds for $Id" 15
    $snapshot = $script:targetSnapshot
    $control = $script:targetControl
    $scale = [double]$snapshot.controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $scale)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $scale)
    if ($Mods) {
        Send "click $x $y $Mods" | Out-Null
    } else {
        Send "click $x $y" | Out-Null
    }
}

function SelectionEquals([object]$Sel, [int[]]$Expected) {
    $actual = @($Sel.selected | ForEach-Object { [int]$_ })
    if ($actual.Count -ne $Expected.Count) { return $false }
    for ($i = 0; $i -lt $Expected.Count; $i++) {
        if ($actual[$i] -ne $Expected[$i]) { return $false }
    }
    return $true
}

function WaitSelection([int[]]$Expected, [string]$Label) {
    WaitFor {
        $s = State
        SelectionEquals $s.pageSelection $Expected
    } $Label 15
    $s = State
    $got = (@($s.pageSelection.selected) -join ',')
    Expect $Label (SelectionEquals $s.pageSelection $Expected) "expected [$($Expected -join ',')], got [$got]"
    return $s
}

try {
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $fixture = @'
import pikepdf, sys
p = pikepdf.Pdf.new()
for _ in range(6):
    p.add_blank_page(page_size=(612, 300))
p.save(sys.argv[1])
'@
    Push-Location (Join-Path $repo 'core')
    try {
        & uv run --no-project python -c $fixture $pdf
        if ($LASTEXITCODE -ne 0) { throw 'fixture generation failed' }
    } finally {
        Pop-Location
    }

    $env:CHEF_E2E = '1'
    $env:CHEF_USER_DATA_DIR = $dataDir
    try {
        $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $pdf + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
    } finally {
        Restore-Env 'CHEF_E2E' $oldE2E
        Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    }

    WaitFor {
        if (-not (Test-Path -LiteralPath $log)) { return $false }
        $text = [string](Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue)
        $script:pipe = [regex]::Match($text, 'chef-native-\d+').Value
        $script:token = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
        if (-not $script:pipe -or -not $script:token) { return $false }
        try {
            $s = State
            return ($null -ne $s.view -and $s.view.pageCount -eq 6 -and $null -ne ($s.controls.controls | Where-Object id -eq 'thumbnail-6'))
        } catch {
            return $false
        }
    } '6-page document and thumbnails ready' 60

    # Plain click -> [1], anchor = 1
    Click-Control 'thumbnail-2'
    $s = WaitSelection @(1) 'plain click selects page 2 (index 1)'
    Expect 'plain click sets anchor=1 focus=1' ($s.pageSelection.anchor -eq 1 -and $s.pageSelection.focus -eq 1) "anchor=$($s.pageSelection.anchor) focus=$($s.pageSelection.focus)"
    WaitFor {
        $snap = State
        $ctrl = $snap.controls.controls | Where-Object id -eq 'thumbnail-2' | Select-Object -First 1
        $null -ne $ctrl -and $ctrl.checked -eq 'true'
    } 'selected thumbnail checked in a11y' 15
    $s = State
    $t2 = $s.controls.controls | Where-Object id -eq 'thumbnail-2' | Select-Object -First 1
    Expect 'selected thumbnail exposes checked=true in a11y' ($t2.checked -eq 'true') "checked=$($t2.checked)"

    # Shift+click forward -> [1,2,3,4], anchor stays 1
    Click-Control 'thumbnail-5' 'shift'
    $s = WaitSelection @(1, 2, 3, 4) 'shift+click selects range 2..5'
    Expect 'shift+click preserves anchor=1' ($s.pageSelection.anchor -eq 1 -and $s.pageSelection.focus -eq 4) "anchor=$($s.pageSelection.anchor) focus=$($s.pageSelection.focus)"

    # Shift+click backward -> [0,1]
    Click-Control 'thumbnail-1' 'shift'
    $s = WaitSelection @(0, 1) 'shift+click backward selects range 1..2'
    Expect 'backward shift+click preserves anchor=1' ($s.pageSelection.anchor -eq 1 -and $s.pageSelection.focus -eq 0) "anchor=$($s.pageSelection.anchor) focus=$($s.pageSelection.focus)"

    # Ctrl+click toggles page 5 on -> [0,1,4], anchor = 4
    Click-Control 'thumbnail-5' 'ctrl'
    $null = WaitSelection @(0, 1, 4) 'ctrl+click adds page 5'

    # Ctrl+click toggles page 2 off -> [0,4], anchor = 1
    Click-Control 'thumbnail-2' 'ctrl'
    $null = WaitSelection @(0, 4) 'ctrl+click removes page 2'

    # Ctrl+click sets anchor at page 4 ([0,3,4], anchor=3), then Ctrl+Shift+click page 6 adds [3..5] -> [0,3,4,5]
    Click-Control 'thumbnail-4' 'ctrl'
    $null = WaitSelection @(0, 3, 4) 'ctrl+click sets anchor at page 4'
    Click-Control 'thumbnail-6' 'ctrl+shift'
    $null = WaitSelection @(0, 3, 4, 5) 'ctrl+shift+click adds range preserving existing selection'

    # Switch to grid -> selection preserved and reflected in grid controls
    Click-Control 'sidebar-grid'
    WaitFor {
        $s = State
        $s.sidebarGrid -and $null -ne ($s.controls.controls | Where-Object id -eq 'thumbnail-6')
    } 'grid mode opens'
    $s = State
    Expect 'sidebar list selection syncs to grid' (SelectionEquals $s.pageSelection @(0, 3, 4, 5)) "selected=[$($s.pageSelection.selected -join ',')]"
    $gridChecked = @(
        1..6 | Where-Object {
            $ctrl = $s.controls.controls | Where-Object id -eq "thumbnail-$_" | Select-Object -First 1
            $ctrl -and $ctrl.checked -eq 'true'
        }
    )
    Expect 'grid controls expose checked state for selected pages' (($gridChecked -join ',') -eq '1,4,5,6') "checked=[$($gridChecked -join ',')]"

    # Ctrl+click in grid syncs back to sidebar list
    Click-Control 'thumbnail-2' 'ctrl'
    $null = WaitSelection @(0, 1, 3, 4, 5) 'ctrl+click in grid updates shared selection'
    Click-Control 'sidebar-pages'
    WaitFor {
        $s = State
        (-not $s.sidebarGrid) -and $null -ne ($s.controls.controls | Where-Object id -eq 'thumbnail-2')
    } 'return to sidebar list'
    $s = State
    Expect 'grid selection syncs back to sidebar list' (SelectionEquals $s.pageSelection @(0, 1, 3, 4, 5)) "selected=[$($s.pageSelection.selected -join ',')]"

    # Invert, odd, even, select all, clear
    Send 'action invertpageselection' | Out-Null
    $null = WaitSelection @(2) 'invert selection yields [2]'

    Send 'action selectoddpages' | Out-Null
    $null = WaitSelection @(0, 2, 4) 'select odd pages yields [0,2,4]'

    Send 'action selectevenpages' | Out-Null
    $null = WaitSelection @(1, 3, 5) 'select even pages yields [1,3,5]'

    Send 'action selectallpages' | Out-Null
    $null = WaitSelection @(0, 1, 2, 3, 4, 5) 'select all pages yields [0..5]'

    Send 'action clearpageselection' | Out-Null
    $null = WaitSelection @() 'clear selection yields []'

    Send 'quit' | Out-Null
    if (-not $proc.WaitForExit(5000)) { throw 'chef-app did not exit cleanly after quit' }

    if ($script:fails -gt 0) { throw "R4.02 page selection E2E failed with $($script:fails) failure(s)" }
    $passed = $true
} finally {
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        $proc.WaitForExit(5000) | Out-Null
    }
    if ($passed) {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Write-Warning "E2E artifacts retained for diagnosis: $work"
    }
}

Write-Output "FAILS: $($script:fails)"
if ($script:fails -gt 0) { exit 1 }
