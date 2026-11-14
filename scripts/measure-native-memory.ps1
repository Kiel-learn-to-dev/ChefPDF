#requires -Version 7.0
# Measure native app working set at open, after exact scrolling, and after returning to top.
# Default starts the edit core with one rotate-page E2E action; -NoCore measures native-only.
param(
  [Parameter(Mandatory = $true)] [string] $Pdf,
  [int] $Screens = 350,
  [string] $Exe = "",
  [switch] $NoCore
)

if ($Screens -lt 1 -or $Screens -gt 10000) { throw 'Screens must be between 1 and 10000.' }
if (-not $Exe) {
  $Exe = Join-Path $PSScriptRoot '..\apps\native\target\debug\chef-app.exe'
}

function Get-ProcessSnapshot([int] $RootPid) {
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize, CommandLine, ExecutablePath, Name)
  $byId = @{}
  foreach ($row in $all) { $byId[[int]$row.ProcessId] = $row }
  if (-not $byId.ContainsKey($RootPid)) { throw "chef-app process $RootPid is no longer running." }
  $tree = [System.Collections.Generic.HashSet[int]]::new()
  [void]$tree.Add($RootPid)
  do {
    $changed = $false
    foreach ($row in $all) {
      $processId = [int]$row.ProcessId
      if ($tree.Contains([int]$row.ParentProcessId) -and $tree.Add($processId)) { $changed = $true }
    }
  } while ($changed)

  $coreRoots = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($processId in $tree) {
    if ($processId -eq $RootPid) { continue }
    $row = $byId[$processId]
    $commandLine = if ($null -ne $row.CommandLine) { [string]$row.CommandLine } else { '' }
    $executablePath = if ($null -ne $row.ExecutablePath) { [string]$row.ExecutablePath } else { '' }
    $processName = if ($null -ne $row.Name) { [string]$row.Name } else { '' }
    $identity = "$commandLine $executablePath $processName"
    if ($identity -match '(?i)(-m\s+chef_core|[\\/]core[\\/]|[\\/]\.venv[\\/])') { [void]$coreRoots.Add($processId) }
  }
  $coreTree = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($processId in $coreRoots) { [void]$coreTree.Add($processId) }
  do {
    $changed = $false
    foreach ($row in $all) {
      $processId = [int]$row.ProcessId
      if ($tree.Contains($processId) -and $coreTree.Contains([int]$row.ParentProcessId) -and $coreTree.Add($processId)) { $changed = $true }
    }
  } while ($changed)

  $nativeBytes = [int64]0; $coreBytes = [int64]0
  foreach ($processId in $tree) {
    $bytes = [int64]$byId[$processId].WorkingSetSize
    if ($coreTree.Contains($processId)) { $coreBytes += $bytes } else { $nativeBytes += $bytes }
  }
  return [pscustomobject]@{
    NativeMB = [math]::Round($nativeBytes / 1MB, 1)
    CoreMB = [math]::Round($coreBytes / 1MB, 1)
    CoreProcesses = $coreTree.Count
    NativeProcessIds = @($tree | Where-Object { -not $coreTree.Contains($_) })
    CoreProcessIds = @($coreTree)
  }
}

function Get-GpuMetricMB([int[]] $ProcessIds, [string] $Metric) {
  if ($ProcessIds.Count -eq 0) { return 'unavailable' }
  $counterPaths = foreach ($processId in $ProcessIds) { "\GPU Process Memory(pid_${processId}*)\$Metric Usage" }
  try {
    $samples = @(Get-Counter -Counter $counterPaths -MaxSamples 1 -ErrorAction Stop | ForEach-Object CounterSamples)
  } catch {
    return 'unavailable'
  }

  $totalBytes = [double]0
  $found = [System.Collections.Generic.HashSet[int]]::new()
  $pattern = '(?i)GPU Process Memory\(pid_(\d+)(?:_[^)]*)?\)\\' + [regex]::Escape($Metric) + ' Usage$'
  foreach ($sample in $samples) {
    if ($sample.Path -match $pattern) {
      $processId = [int]$Matches[1]
      if (($ProcessIds -contains $processId) -and $null -ne $sample.CookedValue) {
        $totalBytes += [double]$sample.CookedValue
        [void]$found.Add($processId)
      }
    }
  }
  if (@($ProcessIds | Where-Object { $found.Contains($_) }).Count -ne $ProcessIds.Count) { return 'unavailable' }
  return [math]::Round($totalBytes / 1MB, 1)
}

function Get-GpuProcessMemory([int[]] $ProcessIds) {
  return [pscustomobject]@{
    DedicatedMB = (Get-GpuMetricMB -ProcessIds $ProcessIds -Metric 'Dedicated')
    SharedMB = (Get-GpuMetricMB -ProcessIds $ProcessIds -Metric 'Shared')
  }
}

function Ask($App, [string] $Command) {
  $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $App.Pipe, [System.IO.Pipes.PipeDirection]::InOut)
  try {
    $client.Connect(5000)
    $writer = [System.IO.StreamWriter]::new($client); $writer.AutoFlush = $true; $writer.NewLine = "`n"
    $reader = [System.IO.StreamReader]::new($client)
    $writer.WriteLine($App.Token + ' ' + $Command)
    $readTask = $reader.ReadLineAsync()
    if (-not $readTask.Wait(10000)) { throw "Timed out waiting for E2E response to '$Command'." }
    $line = $readTask.GetAwaiter().GetResult()
    if (-not $line) { throw "No response to E2E command '$Command'." }
    $result = $line | ConvertFrom-Json
    if ($result.ok -eq $false) { throw "E2E command '$Command' failed: $line" }
    return $result
  } finally { $client.Dispose() }
}

function Get-State($App) { return Ask $App 'state' }

function Wait-For([scriptblock] $Predicate, [string] $Description, [int] $TimeoutSeconds = 60) {
  $until = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $until) {
    if (& $Predicate) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Timed out waiting for $Description."
}

function Wait-ForIdle($App, [bool] $RequireCore) {
  $track = @{ stable = 0; lastRenders = -1 }
  Wait-For {
    $state = Get-State $App
    $coreCount = (Get-ProcessSnapshot $App.Proc.Id).CoreProcesses
    if ($RequireCore -and $coreCount -eq 0) { $track.stable = 0; return $false }
    if ($null -eq $state.view -or $state.pending -gt 0) { $track.stable = 0; return $false }
    if ([int]$state.renders -eq $track.lastRenders) { $track.stable++ } else { $track.stable = 0; $track.lastRenders = [int]$state.renders }
    return $track.stable -ge 5
  } 'viewer/core idle' 120
}

function Wait-ForEditIdle($App) {
  $track = @{ stable = 0; lastRenders = -1 }
  Wait-For {
    $state = Get-State $App
    $coreCount = (Get-ProcessSnapshot $App.Proc.Id).CoreProcesses
    $rotate = @($state.controls.controls | Where-Object id -EQ 'viewer-rotate' | Select-Object -First 1)
    $undo = @($state.controls.controls | Where-Object id -EQ 'viewer-undo' | Select-Object -First 1)
    if ($coreCount -eq 0 -or $rotate.Count -eq 0 -or $undo.Count -eq 0) { $track.stable = 0; return $false }
    if ($rotate[0].disabled -or $undo[0].disabled -or $state.pending -gt 0) { $track.stable = 0; return $false }
    if ([int]$state.renders -eq $track.lastRenders) { $track.stable++ } else { $track.stable = 0; $track.lastRenders = [int]$state.renders }
    return $track.stable -ge 5
  } 'core revision reload and edit UI idle' 120
  $final = Get-State $App
  if ($final.message) { throw "The core edit/revision reload reported an error: $($final.message)" }
}

function Wait-ForScrollComplete($App, [double] $Screens) {
  $total = [int][math]::Ceiling([math]::Abs($Screens))
  $timeout = [int][math]::Ceiling($total * 0.15) + 30
  Wait-For {
    $progress = (Get-State $App).scrollProgress
    return ([int]$progress.total -eq $total) -and ([int]$progress.completed -eq $total) -and (-not $progress.active)
  } "paced scroll sequence ($total steps)" $timeout
}

function Write-Mark([string] $Name, $App, [bool] $CoreExpected) {
  $mem = Get-ProcessSnapshot $App.Proc.Id
  $nativeGpu = Get-GpuProcessMemory $mem.NativeProcessIds
  $coreGpu = Get-GpuProcessMemory $mem.CoreProcessIds
  if ($CoreExpected -and $mem.CoreProcesses -eq 0) { throw "Core-active mark '$Name' has no detected core process." }
  if (-not $CoreExpected -and $mem.CoreProcesses -ne 0) { throw "No-core mark '$Name' unexpectedly has $($mem.CoreProcesses) core process(es)." }
  $state = Get-State $App
  $rect = $state.rect
  if (-not $state.rectOk -or -not $state.visible -or [int]$rect.left -gt -10000 -or [int]$rect.right -ge 0 -or [int]$rect.top -gt -10000 -or [int]$rect.bottom -ge 0) {
    throw "Window is not verified visible and off-screen at '$Name': visible=$($state.visible), rectOk=$($state.rectOk), rect=[$($rect.left),$($rect.top),$($rect.right),$($rect.bottom)]."
  }
  $mode = if ($CoreExpected) { 'core-active' } else { 'no-core' }
  Write-Output ("PERFMEM {0} mode={1} nativeMB={2} coreMB={3} coreProcesses={4} nativeGpuDedicatedMB={5} nativeGpuSharedMB={6} coreGpuDedicatedMB={7} coreGpuSharedMB={8} dpr={9} visible={10} rect=[{11},{12},{13},{14}] renders={15} cached={16} pending={17} viewportH={18} scrollY={19} firstPage={20}" -f $Name, $mode, $mem.NativeMB, $mem.CoreMB, $mem.CoreProcesses, $nativeGpu.DedicatedMB, $nativeGpu.SharedMB, $coreGpu.DedicatedMB, $coreGpu.SharedMB, $state.scale, $state.visible, $rect.left, $rect.top, $rect.right, $rect.bottom, $state.renders, $state.cached, $state.pending, $state.view.viewportH, $state.view.scrollY, $state.view.firstPage)
}

$exePath = (Resolve-Path -LiteralPath $Exe -ErrorAction Stop).Path
$pdfPath = (Resolve-Path -LiteralPath $Pdf -ErrorAction Stop).Path
$log = Join-Path ([IO.Path]::GetTempPath()) ('chef-perf-' + [guid]::NewGuid().ToString('N') + '.txt')
$savedChefEnv = @{}
Get-ChildItem Env: | Where-Object Name -Like 'CHEF_*' | ForEach-Object { $savedChefEnv[$_.Name] = $_.Value; Remove-Item "Env:$($_.Name)" }
$proc = $null
$app = $null
$completedRun = $false
try {
  $env:CHEF_E2E = '1'
  $proc = Start-Process -FilePath $exePath -ArgumentList ('"' + $pdfPath.Replace('"', '\"') + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
} finally {
  Get-ChildItem Env: | Where-Object Name -Like 'CHEF_*' | ForEach-Object { Remove-Item "Env:$($_.Name)" }
  foreach ($name in $savedChefEnv.Keys) { Set-Item "Env:$name" $savedChefEnv[$name] }
}

try {
  if (-not $proc) { throw 'chef-app did not start.' }
  Wait-For {
    if ($proc.HasExited) { throw "chef-app exited with code $($proc.ExitCode): $(Get-Content $log -Raw)" }
    $text = if (Test-Path $log) { Get-Content $log -Raw } else { '' }
    $pipe = [regex]::Match($text, 'chef-native-\d+').Value
    $token = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    if (-not $pipe -or -not $token) { return $false }
    $script:app = [pscustomobject]@{ Proc = $proc; Pipe = $pipe; Token = $token }
    try { return $null -ne (Get-State $script:app).view } catch { return $false }
  } 'initial viewer state' 30
  $app = $script:app

  $hasCore = -not $NoCore
  if ($hasCore) {
    Ask $app 'action rotatepage' | Out-Null
    Wait-ForEditIdle $app
  } else { Wait-ForIdle $app $false }
  Write-Mark 'open' $app $hasCore

  $before = Get-State $app
  Ask $app "scrollscreens $Screens" | Out-Null
  Wait-ForScrollComplete $app $Screens
  $expectedDelta = [double]$before.view.viewportH * $Screens
  $threshold = [double]$before.view.scrollY + ($expectedDelta * 0.99)
  Wait-For { $s = Get-State $app; [double]$s.view.scrollY -ge $threshold } "scroll by $Screens screens"
  $scrolled = Get-State $app
  $actualDelta = [double]$scrolled.view.scrollY - [double]$before.view.scrollY
  if ($actualDelta -lt ($expectedDelta * 0.99)) { throw "Requested $Screens screens ($expectedDelta px), observed only $actualDelta px; PDF may be too short." }
  Wait-ForIdle $app $hasCore
  Write-Mark "after-scroll-$Screens" $app $hasCore

  Ask $app "scrollscreens -$Screens" | Out-Null
  Wait-ForScrollComplete $app (-$Screens)
  Wait-For {
    $s = Get-State $app
    ([int]$s.view.firstPage -eq 0) -and ([math]::Abs([double]$s.view.scrollY) -le 2.0)
  } 'return to document top'
  Wait-ForIdle $app $hasCore
  Write-Mark 'return-top' $app $hasCore
  $completedRun = $true
} finally {
  if ($app) { try { Ask $app 'quit' | Out-Null } catch {} }
  if ($proc -and -not $proc.HasExited) {
    try { $proc.Kill($true); [void]$proc.WaitForExit(5000) } catch {}
  }
  if ($completedRun) { Remove-Item $log -ErrorAction SilentlyContinue }
  elseif (Test-Path $log) {
    Write-Warning "Run failed; diagnostic log retained at: $log"
    Get-Content $log -Tail 80 | ForEach-Object { Write-Warning $_ }
  }
}
