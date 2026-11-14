<#
.SYNOPSIS
  R2.15 host tab E2E: open three PDF argv files, switch, reject a dirty close, close a clean tab,
  and assert that inactive viewers retain no page bitmaps.
.DESCRIPTION
  Windows only. Requires chef-app.exe, pdfium.dll, and core/.venv. Uses the authenticated debug
  pipe for deterministic actions and state; it does not exercise mouse clicks or OS file picker.
#>
param([string]$Exe)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path $Exe)) { throw "chef-app.exe not found: $Exe" }
$work = Join-Path $env:TEMP ('chef-native-tabs-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
$paths = 1..3 | ForEach-Object { Join-Path $work "doc-$_.pdf" }
$fixture = @'
import pikepdf, sys
p = pikepdf.Pdf.new()
p.add_blank_page(page_size=(612, 792))
p.save(sys.argv[1])
'@
Push-Location (Join-Path $repo 'core')
try {
    foreach ($path in $paths) {
        & uv run --no-project python -c $fixture $path
        if ($LASTEXITCODE) { throw 'fixture generation failed' }
    }
} finally { Pop-Location }

$previousE2E = $env:CHEF_E2E
$previousUserDataDir = $env:CHEF_USER_DATA_DIR
$previousSaveAsPath = $env:CHEF_E2E_SAVE_AS_PATH
$dataDir = Join-Path $work 'userdata'
$env:CHEF_USER_DATA_DIR = $dataDir
$env:CHEF_E2E = '1'
$env:CHEF_E2E_SAVE_AS_PATH = $null
$log = Join-Path $work 'app.log'
$proc = $null
try {
    $arguments = ($paths | ForEach-Object { '"' + $_ + '"' }) -join ' '
    try { $proc = Start-Process -FilePath $Exe -ArgumentList $arguments -PassThru -RedirectStandardError $log -WindowStyle Hidden }
    finally {
        $env:CHEF_E2E = $previousE2E
        $env:CHEF_USER_DATA_DIR = $previousUserDataDir
        $env:CHEF_E2E_SAVE_AS_PATH = $previousSaveAsPath
    }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $log)) { Start-Sleep -Milliseconds 100 }
    while ((Get-Date) -lt $deadline -and ((Get-Content $log -Raw) -notmatch 'CHEF_DEBUG_TOKEN=')) { Start-Sleep -Milliseconds 200 }
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

    WaitFor { $s = State; $s.tabs.Count -eq 3 -and $s.tabs[2].active -and $s.tabs[2].cachedPages -gt 0 } 'three argv tabs, last active, and rendered bitmap'
    Send 'action tabprev' | Out-Null
    WaitFor { $s = State; $s.tabs[1].active -and @($s.tabs | Where-Object { -not $_.active -and $_.cachedPages -gt 0 }).Count -eq 0 } 'switch to second tab and clear inactive bitmap cache'
    Send 'action tabprev' | Out-Null
    WaitFor { $s = State; $s.tabs[0].active -and @($s.tabs | Where-Object { -not $_.active -and $_.cachedPages -gt 0 }).Count -eq 0 } 'switch to first tab with inactive caches empty'

    Send 'action rotatepage' | Out-Null
    WaitFor { $s = State; $s.tabs[0].dirty } 'first tab becomes dirty after edit'
    Send 'action closetab' | Out-Null
    WaitFor { $s = State; $s.tabs.Count -eq 3 -and $s.tabs[0].active -and $s.tabs[0].dirty -and $s.tabMessage -match 'Lưu thay đổi' } 'dirty active tab close is rejected'

    Send 'action tabnext' | Out-Null
    WaitFor { $s = State; $s.tabs[1].active } 'switch away while retaining the dirty tab'
    Send 'action closetab' | Out-Null
    WaitFor { $s = State; $s.tabs.Count -eq 2 -and $s.tabs[1].active } 'clean active tab closes and selects its next neighbor'
    $final = State
    if (@($final.tabs | Where-Object { -not $_.active -and $_.cachedPages -gt 0 }).Count -gt 0) { throw 'inactive tab retained page bitmap cache' }
    Send 'quit' | Out-Null
    Write-Output 'PASS R2.15 tab host: argv tabs, switch/cache eviction, dirty close guard, clean close selection'
}
finally {
    $env:CHEF_E2E = $previousE2E
    $env:CHEF_USER_DATA_DIR = $previousUserDataDir
    $env:CHEF_E2E_SAVE_AS_PATH = $previousSaveAsPath
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
