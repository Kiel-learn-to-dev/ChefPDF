<#
.SYNOPSIS
  R2.16 Start screen E2E: check newest-first shared recent files and open the newest entry.
.DESCRIPTION
  Windows only. Requires chef-app.exe, pdfium.dll, Python/pikepdf via uv, and the debug pipe.
#>
param([string]$Exe)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path $Exe)) { throw "chef-app.exe not found: $Exe" }
$work = Join-Path $env:TEMP ('chef-native-start-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
$paths = 1..3 | ForEach-Object { Join-Path $work "recent-$_.pdf" }
$fixture = @'
import pikepdf, sys
pdf = pikepdf.Pdf.new()
pdf.add_blank_page(page_size=(612, 792))
pdf.save(sys.argv[1])
'@
Push-Location (Join-Path $repo 'core')
try {
    foreach ($path in $paths) {
        & uv run --no-project python -c $fixture $path
        if ($LASTEXITCODE) { throw 'PDF fixture generation failed' }
    }
} finally { Pop-Location }

$userData = Join-Path $work 'userdata'
New-Item -ItemType Directory -Force $userData | Out-Null
$recent = @(
    @{ path = $paths[2]; name = 'recent-3.pdf'; openedAt = '2026-11-14T03:00:00.000Z' },
    @{ path = $paths[1]; name = 'recent-2.pdf'; openedAt = '2026-11-14T02:00:00.000Z' },
    @{ path = $paths[0]; name = 'recent-1.pdf'; openedAt = '2026-11-14T01:00:00.000Z' }
)
$settings = @{ version = 1; language = 'en'; theme = 'dark'; defaultSaveDir = $null; recentFiles = $recent }
$settings | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $userData 'settings.json')

$oldE2E = $env:CHEF_E2E
$oldUserData = $env:CHEF_USER_DATA_DIR
$env:CHEF_E2E = '1'
$env:CHEF_USER_DATA_DIR = $userData
$log = Join-Path $work 'app.log'
$proc = $null
try {
    try { $proc = Start-Process -FilePath $Exe -PassThru -RedirectStandardError $log -WindowStyle Hidden }
    finally {
        $env:CHEF_E2E = $oldE2E
        $env:CHEF_USER_DATA_DIR = $oldUserData
    }
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline -and ((-not (Test-Path $log)) -or ((Get-Content $log -Raw) -notmatch 'CHEF_DEBUG_TOKEN='))) { Start-Sleep -Milliseconds 200 }
    $logText = Get-Content $log -Raw
    $pipe = [regex]::Match($logText, 'chef-native-\d+').Value
    $token = [regex]::Match($logText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    if (-not $pipe -or -not $token) { throw 'debug pipe/token missing from app log' }
    function Send([string]$command) {
        $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipe, [System.IO.Pipes.PipeDirection]::InOut)
        $client.Connect(5000)
        try {
            $writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false)); $writer.AutoFlush = $true
            $reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false))
            $writer.WriteLine("$token $command"); return $reader.ReadLine()
        } finally { $client.Dispose() }
    }
    function State() { return (Send 'state' | ConvertFrom-Json) }
    function WaitFor([scriptblock]$predicate, [string]$what) {
        $end = (Get-Date).AddSeconds(45)
        while ((Get-Date) -lt $end) { if (& $predicate) { return }; Start-Sleep -Milliseconds 250 }
        throw "Timed out waiting for $what"
    }
    function Click-Client([double]$x, [double]$y, [double]$scale) {
        $px = [int][math]::Round($x * $scale); $py = [int][math]::Round($y * $scale)
        Send "mouse down $px $py" | Out-Null
        Send "mouse up $px $py" | Out-Null
    }

    WaitFor { $s = State; $s.tabs.Count -eq 0 -and $s.startRecentFiles.Count -eq 3 -and $s.themeDark } 'dark Start screen with three recent files'
    $state = State
    if ($state.startRecentFiles[0] -ne $paths[2] -or $state.startRecentFiles[1] -ne $paths[1] -or $state.startRecentFiles[2] -ne $paths[0]) {
        throw 'recent files are not newest first'
    }
    Write-Output 'PASS settings recentFiles render newest first; Start follows the dark theme'

    # At the default 1200px window, the first recent row is below the 4-column task grid.
    Click-Client 600 541 $state.scale
    WaitFor { $s = State; $s.tabs.Count -eq 1 -and $s.tabs[0].title -eq 'recent-3.pdf' -and $s.tabs[0].active } 'opening the newest recent file in a tab'
    Write-Output 'PASS clicking the newest recent file opens its document tab'
    Send 'quit' | Out-Null
}
finally {
    $env:CHEF_E2E = $oldE2E
    $env:CHEF_USER_DATA_DIR = $oldUserData
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
