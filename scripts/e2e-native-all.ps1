#requires -Version 7.0
<#
.SYNOPSIS
  Run every native E2E script sequentially and report one aggregate result.
.DESCRIPTION
  Scripts are discovered by name, so newly added e2e-native scripts join the suite automatically.
  Each test runs in a hidden child PowerShell process; the test scripts themselves use their
  authenticated debug pipe and do not synthesize mouse input.

  Use -SelfTest to validate discovery, continuation after a deliberate failure, output parsing,
  and the aggregate exit code without launching the Windows-only application.
#>
[CmdletBinding()]
param(
    [switch]$SelfTest,
    [ValidateRange(1, 240)]
    [int]$TimeoutMinutes = 30
)

$ErrorActionPreference = 'Stop'

function Get-PowerShellExecutable {
    if ($IsWindows) {
        return Join-Path $PSHOME 'pwsh.exe'
    }
    return Join-Path $PSHOME 'pwsh'
}

function Get-CheckCounts([string[]]$Lines, [int]$ExitCode) {
    $passes = @($Lines | Where-Object { $_ -match '^\s*PASS\b' }).Count
    $failLines = @($Lines | Where-Object { $_ -match '^\s*FAIL\b' }).Count
    $reported = @($Lines | Where-Object { $_ -match '^\s*FAILS:\s*\d+\s*$' } | Select-Object -Last 1)

    if ($reported.Count -gt 0) {
        $summaryFailures = [int]([regex]::Match($reported[0], 'FAILS:\s*(\d+)', 'IgnoreCase').Groups[1].Value)
    } else {
        $summaryFailures = 0
    }
    $failures = [math]::Max($failLines, $summaryFailures)

    # A script can throw before printing its own FAILS summary. Count that as one failed check
    # unless the script already reported one or more explicit failed checks.
    if ($ExitCode -ne 0 -and $failures -eq 0) {
        $failures = 1
    }
    $checks = $passes + [math]::Max($failLines, $summaryFailures)
    if ($checks -eq 0 -and $failures -gt 0) {
        $checks = $failures
    }

    return [pscustomobject]@{
        Checks   = $checks
        Failures = $failures
    }
}

function Stop-ProcessTreeBounded([System.Diagnostics.Process]$Process) {
    try {
        $Process.Kill($true)
    } catch {
        if ($IsWindows) {
            $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
            if (Test-Path -LiteralPath $taskkill) {
                & $taskkill /PID $Process.Id /T /F *> $null
            } else {
                Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
            }
        } else {
            Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        }
    }
    return $Process.WaitForExit(5000)
}

function Invoke-E2EScript {
    param(
        [Parameter(Mandatory)] [System.IO.FileInfo]$ScriptFile,
        [Parameter(Mandatory)] [string]$PowerShellExe,
        [Parameter(Mandatory)] [string]$LogDirectory,
        [Parameter(Mandatory)] [int]$TimeoutSeconds
    )

    $stdout = Join-Path $LogDirectory ($ScriptFile.BaseName + '.stdout.txt')
    $stderr = Join-Path $LogDirectory ($ScriptFile.BaseName + '.stderr.txt')
    $argumentLine = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $ScriptFile.FullName
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $exitCode = 1
    $lines = @()
    $timedOut = $false

    try {
        $options = @{
            FilePath               = $PowerShellExe
            ArgumentList           = $argumentLine
            PassThru               = $true
            RedirectStandardOutput = $stdout
            RedirectStandardError  = $stderr
        }
        if ($IsWindows) {
            $options.WindowStyle = 'Hidden'
        }
        $process = Start-Process @options
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $timedOut = $true
            if (-not (Stop-ProcessTreeBounded -Process $process)) {
                $lines += 'FAIL runner could not stop the timed-out process tree within 5 seconds'
            }
        }
        $process.Refresh()
        $exitCode = if ($timedOut) { 124 } else { $process.ExitCode }
    } catch {
        $lines += "FAIL runner could not start $($ScriptFile.Name): $_"
        $exitCode = 1
    } finally {
        $clock.Stop()
    }

    try {
        if (Test-Path -LiteralPath $stdout) {
            $lines += Get-Content -LiteralPath $stdout -ErrorAction Stop
        }
        if (Test-Path -LiteralPath $stderr) {
            $lines += Get-Content -LiteralPath $stderr -ErrorAction Stop | ForEach-Object { "STDERR $_" }
        }
    } catch {
        $lines += "FAIL runner could not read logs for $($ScriptFile.Name): $_"
        $exitCode = 1
    }

    if ($timedOut) {
        $lines += "FAIL runner timed out after $TimeoutSeconds seconds"
    }

    try {
        $counts = Get-CheckCounts -Lines $lines -ExitCode $exitCode
    } catch {
        $lines += "FAIL runner could not parse results for $($ScriptFile.Name): $_"
        $exitCode = 1
        $counts = [pscustomobject]@{ Checks = 1; Failures = 1 }
    }

    return [pscustomobject]@{
        Name     = $ScriptFile.BaseName
        Checks   = $counts.Checks
        Failures = $counts.Failures
        Seconds  = [math]::Round($clock.Elapsed.TotalSeconds, 2)
        ExitCode = $exitCode
        Output   = $lines
    }
}

function Invoke-E2ESuite {
    param(
        [Parameter(Mandatory)] [string]$Directory,
        [Parameter(Mandatory)] [string]$PowerShellExe,
        [Parameter(Mandatory)] [string]$LogDirectory,
        [Parameter(Mandatory)] [int]$TimeoutSeconds
    )

    $scripts = @(
        Get-ChildItem -LiteralPath $Directory -File -Filter 'e2e-native-*.ps1' |
            Where-Object { $_.Name -ine 'e2e-native-all.ps1' } |
            Sort-Object Name
    )

    if ($scripts.Count -eq 0) {
        throw "No e2e-native scripts found in $Directory"
    }

    $results = [System.Collections.Generic.List[object]]::new()
    foreach ($scriptFile in $scripts) {
        Write-Host "RUN  $($scriptFile.Name)"
        try {
            $result = Invoke-E2EScript -ScriptFile $scriptFile -PowerShellExe $PowerShellExe `
                -LogDirectory $LogDirectory -TimeoutSeconds $TimeoutSeconds
        } catch {
            $result = [pscustomobject]@{
                Name = $scriptFile.BaseName; Checks = 1; Failures = 1; Seconds = 0
                ExitCode = 1; Output = @("FAIL runner exception for $($scriptFile.Name): $_")
            }
        }
        $results.Add($result)

        if ($result.Failures -gt 0 -or $result.ExitCode -ne 0) {
            Write-Host "FAIL $($scriptFile.Name): $($result.Failures) failure(s), exit $($result.ExitCode)"
            $result.Output | ForEach-Object { Write-Host "  $_" }
        } else {
            Write-Host "PASS $($scriptFile.Name): $($result.Checks) check(s)"
        }
    }
    return ,$results.ToArray()
}

function Show-Summary([object[]]$Results) {
    Write-Host ''
    Write-Host 'E2E native summary'
    $Results |
        Select-Object Name, Checks, Failures, Seconds |
        Format-Table -AutoSize |
        Out-String |
        Write-Host

    $totalChecks = ($Results | Measure-Object -Property Checks -Sum).Sum
    $totalFailures = ($Results | Measure-Object -Property Failures -Sum).Sum
    Write-Host "TOTAL: $($Results.Count) scripts, $totalChecks checks, $totalFailures failure(s)"
    return Get-AggregateExitCode -Results $Results
}

function Get-AggregateExitCode([object[]]$Results) {
    $totalFailures = ($Results | Measure-Object -Property Failures -Sum).Sum
    if ($totalFailures -gt 0 -or @($Results | Where-Object ExitCode -ne 0).Count -gt 0) {
        return 1
    }
    return 0
}

function Invoke-SelfTest([string]$PowerShellExe, [int]$TimeoutSeconds) {
    $root = Join-Path ([System.IO.Path]::GetTempPath()) ('chef-native-e2e-selftest-' + [guid]::NewGuid().ToString('N'))
    $scripts = Join-Path $root 'scripts'
    $logs = Join-Path $root 'logs'
    New-Item -ItemType Directory -Force $scripts, $logs | Out-Null

    $encoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText((Join-Path $scripts 'e2e-native-01-success.ps1'), @'
Write-Output 'PASS synthetic success'
Write-Output 'FAILS: 0'
exit 0
'@, $encoding)
    [System.IO.File]::WriteAllText((Join-Path $scripts 'e2e-native-02-explicit-failures.ps1'), @'
Write-Output 'PASS before intentional failure'
Write-Output 'FAIL intentional self-test case one'
Write-Output 'FAIL intentional self-test case two'
Write-Output 'FAILS: 1'
exit 1
'@, $encoding)
    [System.IO.File]::WriteAllText((Join-Path $scripts 'e2e-native-03-summary-failures.ps1'), @'
Write-Output 'PASS before summary failure'
Write-Output 'FAILS: 3'
exit 1
'@, $encoding)
    [System.IO.File]::WriteAllText((Join-Path $scripts 'e2e-native-04-synthesized-failure.ps1'), @'
exit 1
'@, $encoding)
    [System.IO.File]::WriteAllText((Join-Path $scripts 'e2e-native-05-after-failure.ps1'), @'
Write-Output 'PASS runner continued after failure'
Write-Output 'FAILS: 0'
exit 0
'@, $encoding)
    [System.IO.File]::WriteAllText((Join-Path $scripts 'e2e-native-all.ps1'), @'
Write-Output 'FAIL self must not run'
Write-Output 'FAILS: 1'
exit 1
'@, $encoding)

    try {
        $results = Invoke-E2ESuite -Directory $scripts -PowerShellExe $PowerShellExe `
            -LogDirectory $logs -TimeoutSeconds $TimeoutSeconds
        $aggregateExitCode = Show-Summary -Results $results
        $continued = $results.Count -eq 5 -and $results[4].Name -eq 'e2e-native-05-after-failure'
        $aggregated = $aggregateExitCode -eq 1 -and $results[1].Failures -eq 2 -and `
            $results[2].Failures -eq 3 -and $results[3].Failures -eq 1
        $countsCorrect = $results[0].Checks -eq 1 -and $results[1].Checks -eq 3 -and `
            $results[2].Checks -eq 4 -and $results[3].Checks -eq 1 -and $results[4].Checks -eq 1
        $selfExcluded = @($results | Where-Object Name -eq 'e2e-native-all').Count -eq 0
        $passingExitCode = Get-AggregateExitCode -Results @($results[0], $results[4])
        if (-not $continued -or -not $aggregated -or -not $countsCorrect -or -not $selfExcluded -or `
            $passingExitCode -ne 0 -or $results[0].Failures -ne 0 -or $results[4].Failures -ne 0) {
            throw 'self-test did not verify discovery, continuation, or aggregate failure behavior'
        }
        Write-Host 'SELFTEST PASS: discovery, self-exclusion, count maxima, synthesized failures, continuation, and aggregate exit codes verified'
        return 0
    } finally {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$powerShellExe = Get-PowerShellExecutable
if (-not (Test-Path -LiteralPath $powerShellExe)) {
    throw "PowerShell executable was not found: $powerShellExe"
}

if ($SelfTest) {
    exit (Invoke-SelfTest -PowerShellExe $powerShellExe -TimeoutSeconds ($TimeoutMinutes * 60))
}

$scriptDirectory = $PSScriptRoot
$logDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('chef-native-e2e-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $logDirectory | Out-Null
try {
    $results = Invoke-E2ESuite -Directory $scriptDirectory -PowerShellExe $powerShellExe `
        -LogDirectory $logDirectory -TimeoutSeconds ($TimeoutMinutes * 60)
    $aggregateExitCode = Show-Summary -Results $results
    if ($aggregateExitCode -ne 0) {
        Write-Output "Full logs: $logDirectory"
        exit 1
    }
    Remove-Item -LiteralPath $logDirectory -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
} catch {
    Write-Error $_
    Write-Output "Full logs: $logDirectory"
    exit 1
}
