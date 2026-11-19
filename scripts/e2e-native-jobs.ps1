#requires -Version 7.0
<#
.SYNOPSIS
  Native R3.09 E2E: JobPanel toggle, real core job tracking, live progress updates,
  job cancellation, failed job error retention until dismissed, and clear-finished behavior.
.DESCRIPTION
  Windows only. Requires chef-app.exe, pdfium.dll, and core/.venv.
  Uses CHEF_E2E=1 with isolated TEMP/CHEF_USER_DATA_DIR and drives UI via the authenticated debug pipe.
#>
[CmdletBinding()]
param([string]$Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-jobs-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $work 'userdata'
$log = Join-Path $work 'app.log'
$pdf = Join-Path $work 'jobs.pdf'

$oldE2E = $env:CHEF_E2E
$oldUserData = $env:CHEF_USER_DATA_DIR
$oldSaveAs = $env:CHEF_E2E_SAVE_AS_PATH
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
        Start-Sleep -Milliseconds 200
    }
    throw "Timed out waiting for $What. Log: $(Get-Content $log -Raw -ErrorAction SilentlyContinue)"
}

function Click-Control([string]$Id) {
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
    } "control bounds for $Id" 10
    $snapshot = $script:targetSnapshot
    $control = $script:targetControl
    $scale = [double]$snapshot.controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $scale)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $scale)
    Send "mouse move $x $y" | Out-Null
    Start-Sleep -Milliseconds 50
    Send "mouse down $x $y" | Out-Null
    Start-Sleep -Milliseconds 40
    Send "mouse up $x $y" | Out-Null
}

function Find-Job($StateObj, [string]$JobId) {
    return ($StateObj.jobs.items | Where-Object { $_.id -eq $JobId } | Select-Object -First 1)
}

try {
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $fixture = @'
import pikepdf, sys
p = pikepdf.Pdf.new()
p.add_blank_page(page_size=(612, 792))
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
    $env:CHEF_E2E_SAVE_AS_PATH = $null
    try {
        $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $pdf + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
    } finally {
        Restore-Env 'CHEF_E2E' $oldE2E
        Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
        Restore-Env 'CHEF_E2E_SAVE_AS_PATH' $oldSaveAs
    }

    WaitFor {
        if (-not (Test-Path -LiteralPath $log)) { return $false }
        $text = [string](Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue)
        $script:pipe = [regex]::Match($text, 'chef-native-\d+').Value
        $script:token = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
        if (-not $script:pipe -or -not $script:token) { return $false }
        try { return $null -ne (State).view } catch { return $false }
    } 'viewer ready' 60

    # 1. Real core operation tracks and completes via RPC event fan-out (Viewer focused)
    Send 'action rotatepage' | Out-Null
    WaitFor {
        $s = State
        $rot = $s.jobs.items | Where-Object { $_.opId -eq 'page.rotate' } | Select-Object -First 1
        ($null -ne $rot) -and ($rot.status -eq 'finished')
    } 'real page.rotate job tracked and finished'
    $rotJob = (State).jobs.items | Where-Object { $_.opId -eq 'page.rotate' } | Select-Object -First 1
    Expect 'real core op finished in JobStore' ($rotJob.status -eq 'finished' -and [double]$rotJob.progress -eq 1.0) 'rotatepage job did not finish cleanly'

    # 2. Open jobs panel via jobs-toggle
    Click-Control 'jobs-toggle'
    WaitFor {
        $s = State
        $s.jobs.open -eq $true -and ($null -ne ($s.controls.controls | Where-Object { $_.id -eq 'jobs-panel' }))
    } 'jobs panel opens'
    Expect 'jobs-toggle opens jobs-panel' ((State).jobs.open -eq $true) 'jobs.open was false'

    # 3. Live progress updates and cancellation via job-cancel-<id>
    Send 'jobtrack test-job-run page.duplicate Nhân đôi trang' | Out-Null
    WaitFor {
        $s = State
        $j = Find-Job $s 'test-job-run'
        ($null -ne $j) -and ($j.status -eq 'running') -and ($s.jobs.runningCount -eq 1)
    } 'running job tracked in JobStore'

    Send 'jobnotify job.progress {"jobId":"test-job-run","done":2,"total":5,"message":"Đang xử lý 2/5"}' | Out-Null
    WaitFor {
        $s = State
        $j = Find-Job $s 'test-job-run'
        ($null -ne $j) -and ([int]$j.done -eq 2) -and ([int]$j.total -eq 5) -and ($j.message -eq 'Đang xử lý 2/5')
    } 'job.progress updates done/total/message'
    $progJob = Find-Job (State) 'test-job-run'
    Expect 'job.progress updates progress fraction' ([math]::Abs([double]$progJob.progress - 0.4) -lt 0.01) ("got progress=$($progJob.progress)")

    Click-Control 'job-cancel-test-job-run'
    WaitFor {
        $s = State
        $j = Find-Job $s 'test-job-run'
        ($null -ne $j) -and ($j.status -eq 'cancelled') -and ($s.jobs.runningCount -eq 0)
    } 'cancelling running job sets status to cancelled'
    Expect 'job-cancel marks job cancelled' ((Find-Job (State) 'test-job-run').status -eq 'cancelled') 'job not cancelled'

    # 4. Failed job retains error until user dismisses or clears finished
    Send 'jobtrack test-job-fail pdf.merge Ghép tài liệu' | Out-Null
    WaitFor { $null -ne (Find-Job (State) 'test-job-fail') } 'failed-test job tracked'
    Send 'jobnotify job.failed {"jobId":"test-job-fail","error":{"code":"E_IO","message":"Lỗi đọc tệp nguồn"}}' | Out-Null
    WaitFor {
        $j = Find-Job (State) 'test-job-fail'
        ($null -ne $j) -and ($j.status -eq 'failed') -and ($j.error -eq 'Lỗi đọc tệp nguồn')
    } 'job.failed records error message'
    Start-Sleep -Milliseconds 400
    $retained = Find-Job (State) 'test-job-fail'
    Expect 'failed job retains error until dismissed' ($null -ne $retained -and $retained.error -eq 'Lỗi đọc tệp nguồn') 'error was not retained'

    Click-Control 'job-dismiss-test-job-fail'
    WaitFor { $null -eq (Find-Job (State) 'test-job-fail') } 'job-dismiss removes failed job'
    Expect 'job-dismiss removes failed entry while keeping others' ($null -eq (Find-Job (State) 'test-job-fail') -and (State).jobs.items.Count -ge 1) 'unexpected job list after dismiss'

    # 5. Clear finished and close panel
    Click-Control 'jobs-clear-finished'
    WaitFor { (State).jobs.items.Count -eq 0 } 'clear-finished clears finished/cancelled jobs'
    Expect 'jobs-clear-finished clears completed entries' ((State).jobs.items.Count -eq 0) 'items still present'

    Click-Control 'jobs-panel-close'
    WaitFor { (State).jobs.open -eq $false } 'jobs panel closes'
    Expect 'jobs-panel-close closes panel' ((State).jobs.open -eq $false) 'jobs.open stayed true'

    Send 'quit' | Out-Null
    if (-not $proc.WaitForExit(5000)) { throw 'chef-app did not exit cleanly after quit' }

    if ($script:fails -gt 0) { throw "R3.09 jobs E2E failed with $($script:fails) failure(s)" }
    $passed = $true
} finally {
    Restore-Env 'CHEF_E2E' $oldE2E
    Restore-Env 'CHEF_USER_DATA_DIR' $oldUserData
    Restore-Env 'CHEF_E2E_SAVE_AS_PATH' $oldSaveAs
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
