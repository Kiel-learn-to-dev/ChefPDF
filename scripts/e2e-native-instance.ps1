<#
.SYNOPSIS
  R2.17 single-instance E2E: a second launch forwards multiple Unicode PDF paths to the first.
.DESCRIPTION
  Windows only. Requires chef-app.exe, pdfium.dll, uv and pikepdf via the core project.
  Dragging a file from Explorer still needs a Windows desktop interaction run.
#>
param([string]$Exe)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path $Exe)) { throw "chef-app.exe not found: $Exe" }
$work = Join-Path $env:TEMP ('chef-native-instance-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
$first = Join-Path $work 'bản đầu.pdf'
$second = Join-Path $work 'tài liệu số 02.pdf'
$third = Join-Path $work 'ghi chú mẫu.pdf'
$missing = Join-Path $work 'không tồn tại.pdf'
$fixture = @'
import pikepdf, sys
for path in sys.argv[1:]:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(path)
'@
Push-Location (Join-Path $repo 'core')
try {
    & uv run --no-project python -c $fixture $first $second $third
    if ($LASTEXITCODE) { throw 'PDF fixture generation failed' }
} finally { Pop-Location }

$oldE2E = $env:CHEF_E2E
$oldUserData = $env:CHEF_USER_DATA_DIR
$env:CHEF_E2E = '1'
$env:CHEF_USER_DATA_DIR = Join-Path $work 'userdata'
$primaryLog = Join-Path $work 'primary.log'
$secondaryLog = Join-Path $work 'secondary.log'
$primary = $null
$secondary = $null
try {
    $primaryArgs = '"' + $first + '"'
    $primary = Start-Process -FilePath $Exe -ArgumentList $primaryArgs -PassThru -RedirectStandardError $primaryLog -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline -and ((-not (Test-Path $primaryLog)) -or ((Get-Content $primaryLog -Raw) -notmatch 'CHEF_DEBUG_TOKEN='))) {
        Start-Sleep -Milliseconds 200
    }
    if (-not (Test-Path $primaryLog)) { throw 'primary instance did not create its log' }
    $logText = Get-Content $primaryLog -Raw
    $pipe = [regex]::Match($logText, 'chef-native-\d+').Value
    $token = [regex]::Match($logText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    if (-not $pipe -or -not $token) { throw 'primary debug pipe/token missing' }

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

    WaitFor { $s = State; $s.tabs.Count -eq 1 -and $s.tabs[0].title -eq [IO.Path]::GetFileName($first) } 'first app window and initial PDF tab'
    $secondArgs = @($second, $missing, $third) | ForEach-Object { '"' + $_ + '"' }
    $secondary = Start-Process -FilePath $Exe -ArgumentList ($secondArgs -join ' ') -PassThru -RedirectStandardError $secondaryLog -WindowStyle Hidden
    if (-not $secondary.WaitForExit(10000)) { throw 'second launch stayed alive; a duplicate app window may have opened' }
    if ($secondary.ExitCode -ne 0) { throw "second launch failed with exit code $($secondary.ExitCode): $(Get-Content $secondaryLog -Raw)" }

    WaitFor { $s = State; $s.tabs.Count -eq 3 -and $s.tabs[2].active -and $s.tabMessage -match 'không tồn tại.pdf' } 'two valid forwarded files and one per-file validation error'
    WaitFor { $s = State; $s.foreground } 'original window brought to the foreground'
    $final = State
    $titles = @($final.tabs | ForEach-Object { $_.title })
    if ($titles[0] -ne [IO.Path]::GetFileName($first) -or $titles[1] -ne [IO.Path]::GetFileName($second) -or $titles[2] -ne [IO.Path]::GetFileName($third)) {
        throw "forwarded tab order/title mismatch: $($titles -join ', ')"
    }
    if (-not $final.tabs[2].active) { throw 'last forwarded PDF did not become active' }
    Send 'quit' | Out-Null
    Write-Output 'PASS R2.17: second launch forwarded Unicode paths to the original process; valid files opened, missing file reported, no duplicate process remained'
}
finally {
    $env:CHEF_E2E = $oldE2E
    $env:CHEF_USER_DATA_DIR = $oldUserData
    if ($primary -and -not $primary.HasExited) { Stop-Process -Id $primary.Id -Force }
    if ($secondary -and -not $secondary.HasExited) { Stop-Process -Id $secondary.Id -Force }
}
