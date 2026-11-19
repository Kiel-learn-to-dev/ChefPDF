#requires -Version 7.0
<#
.SYNOPSIS
  R4.01 E2E: render a 1000-page document in the thumbnail grid, enforce the thumbnail cap,
  and navigate to a page by clicking its grid cell.
.DESCRIPTION
  Windows only. Requires chef-app.exe, pdfium.dll, core/.venv. Uses the authenticated debug pipe.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }
$work = Join-Path $env:TEMP ('chef-native-grid-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$pdf = Join-Path $work 'grid-1000.pdf'
$fixture = @'
import pikepdf, sys
p = pikepdf.Pdf.new()
for _ in range(1000): p.add_blank_page(page_size=(612, 792))
p.save(sys.argv[1])
'@
Push-Location (Join-Path $repo 'core')
try {
    & uv run --no-project python -c $fixture $pdf
    if ($LASTEXITCODE) { throw '1000-page fixture generation failed' }
} finally { Pop-Location }

$prevE2E = $env:CHEF_E2E
$prevData = $env:CHEF_USER_DATA_DIR
$data = Join-Path $work 'userdata'
$log = Join-Path $work 'app.log'
$proc = $null
$env:CHEF_E2E = '1'
$env:CHEF_USER_DATA_DIR = $data
try {
    $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $pdf + '"') -PassThru -WindowStyle Hidden -RedirectStandardError $log
} finally {
    $env:CHEF_E2E = $prevE2E
    $env:CHEF_USER_DATA_DIR = $prevData
}
try {
    $end = [DateTime]::UtcNow.AddSeconds(45)
    while ([DateTime]::UtcNow -lt $end -and (([string](Get-Content $log -Raw -ErrorAction SilentlyContinue)) -notmatch 'CHEF_DEBUG_TOKEN=')) {
        if ($proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)): $(Get-Content $log -Raw -ErrorAction SilentlyContinue)" }
        Start-Sleep -Milliseconds 200
    }
    $logText = Get-Content -LiteralPath $log -Raw
    $pipe = [regex]::Match($logText, 'chef-native-\d+').Value
    $token = [regex]::Match($logText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    if (-not $pipe -or -not $token) { throw 'debug pipe/token missing from app log' }
    function Send([string]$command) {
        $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipe, [System.IO.Pipes.PipeDirection]::InOut)
        try {
            $client.Connect(5000)
            $writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false)); $writer.AutoFlush = $true
            $reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false))
            $writer.WriteLine("$token $command")
            $line = $reader.ReadLine()
            if (-not $line -and $command -eq 'quit') { return }
            if (-not $line) { throw "debug command returned no response: $command" }
            $response = $line | ConvertFrom-Json
            if ($response.PSObject.Properties['ok'] -and $response.ok -eq $false) { throw "debug command failed: $command -- $($response.error)" }
            return $line
        } finally { $client.Dispose() }
    }
    function State() { return (Send 'state' | ConvertFrom-Json) }
    function WaitFor([scriptblock]$predicate, [string]$what) {
        $deadline = [DateTime]::UtcNow.AddSeconds(60)
        while ([DateTime]::UtcNow -lt $deadline) {
            if ($proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)) while waiting for $what" }
            if (& $predicate) { return }
            Start-Sleep -Milliseconds 250
        }
        throw "Timed out waiting for $what"
    }
    function Click-Control([string]$id) {
        $script:control = $null
        WaitFor {
            $script:snap = State
            $script:control = $script:snap.controls.controls | Where-Object id -eq $id | Select-Object -First 1
            $script:control -and $script:control.bounds
        } "bounds for control $id"
        $snap = $script:snap
        $control = $script:control
        $scale = [double]$snap.controls.scale
        $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $scale)
        $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $scale)
        Send "mouse move $x $y" | Out-Null
        Send "mouse down $x $y" | Out-Null
        Send "mouse up $x $y" | Out-Null
    }

    WaitFor { $s = State; $s.view.visiblePages.Count -gt 0 } '1000-page document open'
    Click-Control 'sidebar-grid'
    WaitFor { $s = State; $s.sidebarGrid -and ($s.sidebarThumbnails + $s.sidebarThumbnailPending) -gt 0 } 'grid thumbnail render'
    $snapshot = State
    if ($snapshot.sidebarThumbnails + $snapshot.sidebarThumbnailPending -gt 60) {
        throw "grid retained/scheduled more than 60 thumbnails: cached=$($snapshot.sidebarThumbnails), pending=$($snapshot.sidebarThumbnailPending)"
    }
    Write-Output "PASS grid thumbnail cap: cached=$($snapshot.sidebarThumbnails), pending=$($snapshot.sidebarThumbnailPending)"
    Send 'scrollsidebar 10000' | Out-Null
    Click-Control 'sidebar-grid' # The click requests a render frame that consumes the queued debug scroll.
    WaitFor { (State).sidebarScrollY -gt 0 } 'debug scroll advances the grid'
    WaitFor {
        $s = State
        $s.sidebarGrid -and ($s.controls.controls | Where-Object id -eq 'thumbnail-1000')
    } 'scrolling the grid exposes page 1000 (state is queried below on timeout)'
    $snapshot = State
    if ($snapshot.sidebarThumbnails + $snapshot.sidebarThumbnailPending -gt 60) {
        throw "scrolled grid retained/scheduled more than 60 thumbnails: cached=$($snapshot.sidebarThumbnails), pending=$($snapshot.sidebarThumbnailPending)"
    }
    Write-Output "PASS grid scroll cap at page 1000: cached=$($snapshot.sidebarThumbnails), pending=$($snapshot.sidebarThumbnailPending)"
    Click-Control 'thumbnail-1000'
    WaitFor { $s = State; $s.view.visiblePages -contains 999 } 'clicking grid page 1000 navigates viewer'
    Write-Output 'PASS grid click navigates to page 1000'
    Click-Control 'sidebar-pages'
    WaitFor { -not (State).sidebarGrid } 'switching back to page list clears grid mode'
    Write-Output 'PASS switching back to page list clears grid mode'
    Send 'quit' | Out-Null
    if (-not $proc.WaitForExit(5000)) { throw 'chef-app did not exit after quit' }
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    $tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    $workFullPath = [System.IO.Path]::GetFullPath($work)
    if ($workFullPath.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $workFullPath -Recurse -Force -ErrorAction SilentlyContinue
    }
}
