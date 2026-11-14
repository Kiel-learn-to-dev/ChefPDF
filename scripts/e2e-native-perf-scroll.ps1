# R2.19 continuous navigation and scroll timing.
# OS keyboard/mouse input, visible app window, and a topmost helper window are opt-in only.
param([string] $Exe)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }

$work = Join-Path $env:TEMP ('chef-native-perf-scroll-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$pdf = Join-Path $work '1000-pages.pdf'
Push-Location (Join-Path $repo 'core')
try {
  & uv run --no-project python -c 'import pikepdf,sys; p=pikepdf.Pdf.new(); [p.add_blank_page(page_size=(595,842)) for _ in range(1000)]; p.save(sys.argv[1])' $pdf
  if ($LASTEXITCODE -ne 0) { throw 'fixture generation failed' }
} finally { Pop-Location }

$savedE2E = $env:CHEF_E2E
$savedUserData = $env:CHEF_USER_DATA_DIR
$env:CHEF_E2E = '1'
$env:CHEF_USER_DATA_DIR = Join-Path $work 'userdata'
$log = Join-Path $work 'app.log'
$proc = $null
$pipe = $null
$token = $null
$topWindow = $null
$stopTop = Join-Path $work 'top-window.stop'

function Send([string] $Command) {
  $client = [IO.Pipes.NamedPipeClientStream]::new('.', $script:pipe, [IO.Pipes.PipeDirection]::InOut)
  try {
    $client.Connect(5000)
    $writer = [IO.StreamWriter]::new($client, [Text.UTF8Encoding]::new($false))
    $writer.AutoFlush = $true
    $reader = [IO.StreamReader]::new($client, [Text.UTF8Encoding]::new($false))
    $writer.WriteLine("$script:token $Command")
    $line = $reader.ReadLine()
    if (-not $line) { throw "No response to debug command '$Command'." }
    $result = $line | ConvertFrom-Json
    if ($result.ok -eq $false) { throw "Debug command '$Command' failed: $line" }
    return $result
  } finally { $client.Dispose() }
}

function Get-State { Send 'state' }

function Wait-For([scriptblock] $Predicate, [string] $Description, [int] $Seconds = 45) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (& $Predicate) { return }
    Start-Sleep -Milliseconds 150
  }
  throw "Timed out: $Description"
}

function Wait-ForPage([int] $Page, [double] $ScrollSign) {
  Wait-For {
    $state = Get-State
    return ([int]$state.view.firstPage -eq $Page) -and
      (($ScrollSign -eq 0 -and [math]::Abs([double]$state.view.scrollY) -le 2) -or
        ($ScrollSign -gt 0 -and [double]$state.view.scrollY -gt 0))
  } "viewer reaches page $Page"
}

function Enable-VisibleWindow([int] $Hwnd) {
  if (-not ('ChefPerfWindow' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ChefPerfWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
  }
  $hwnd = [IntPtr]::new([long]$Hwnd)
  [void][ChefPerfWindow]::ShowWindow($hwnd, 9) # SW_RESTORE
  [void][ChefPerfWindow]::SetWindowPos($hwnd, [IntPtr]::Zero, 100, 100, 1280, 900, 0x0040) # SWP_SHOWWINDOW
  Start-Sleep -Milliseconds 500
  [void][ChefPerfWindow]::SetForegroundWindow($hwnd)
  return $hwnd
}

function Send-RealKey([byte] $VirtualKey) {
  [void][ChefPerfWindow]::keybd_event($VirtualKey, 0, 0, [UIntPtr]::Zero)
  [void][ChefPerfWindow]::keybd_event($VirtualKey, 0, 2, [UIntPtr]::Zero) # KEYEVENTF_KEYUP
}

try {
  $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $pdf + '"') -PassThru `
    -RedirectStandardError $log -WindowStyle Hidden
} finally {
  if ($null -eq $savedE2E) { Remove-Item Env:CHEF_E2E -ErrorAction SilentlyContinue }
  else { $env:CHEF_E2E = $savedE2E }
  if ($null -eq $savedUserData) { Remove-Item Env:CHEF_USER_DATA_DIR -ErrorAction SilentlyContinue }
  else { $env:CHEF_USER_DATA_DIR = $savedUserData }
}

try {
  Wait-For {
    if ($proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)): $(Get-Content $log -Raw)" }
    if (-not (Test-Path -LiteralPath $log)) { return $false }
    $text = Get-Content -LiteralPath $log -Raw
    $script:pipe = [regex]::Match($text, 'chef-native-\d+').Value
    $script:token = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    if (-not $script:pipe -or -not $script:token) { return $false }
    try { return $null -ne (Get-State).view } catch { return $false }
  } 'native debug pipe and initial viewer' 60

  $initial = Get-State
  if ($initial.view.pageMode -ne 'continuous') { throw 'Continuous is not the default viewing mode.' }
  if ($initial.view.firstPage -ne 0 -or [double]$initial.view.scrollY -gt 2) {
    throw 'The viewer did not start at the top of page 0.'
  }

  Send 'action nextpage' | Out-Null
  Wait-ForPage 1 1
  Send 'action prevpage' | Out-Null
  Wait-ForPage 0 0

  Send 'resetrendertiming' | Out-Null
  Send 'scrollscreens 350' | Out-Null
  Wait-For {
    $state = Get-State
    return ($state.scrollProgress.total -eq 350) -and
      ($state.scrollProgress.completed -eq 350) -and (-not $state.scrollProgress.active)
  } '350-screen paced scroll' 120
  $perf = Get-State
  $delta = [double]$perf.view.scrollY - [double]$initial.view.scrollY
  $minimum = [double]$initial.view.viewportH * 345
  if ($delta -lt $minimum) { throw "Document scroll was too short: $delta px; expected at least $minimum px." }
  $timing = $perf.renderTiming
  if ($timing.samples -le 0) { throw 'No GPUI Render timing samples were collected.' }
  Write-Output ("PERF-WHEEL-R2.19 mode=debug-viewport screens=350 deltaPx={0:N0} renderBodyMaxMs={1} renderBodyOver50ms={2} renderCallGapMaxMs={3} renderCallGapOver50ms={4}" -f `
    $delta, $timing.maxBodyMs, $timing.bodyOver50ms, $timing.maxRenderCallGapMs, $timing.renderCallGapOver50ms)
  Write-Output 'TIMING NOTE: Render-body duration and gaps between Render starts are proxies; neither is a presented-frame interval.'

  if ($env:CHEF_E2E_OS_INPUT -eq '1') {
    $hwnd = Enable-VisibleWindow ([int]$perf.hwnd)
    $state = Get-State
    Send-RealKey 0x22 # VK_NEXT / PageDown
    Wait-ForPage 1 1
    Send-RealKey 0x21 # VK_PRIOR / PageUp
    Wait-ForPage 0 0
    Write-Output 'OS PageDown/PageUp input smoke passed.'

    $rect = $state.rect
    $contentHeight = [int]$rect.bottom - [int]$rect.top
    if ($contentHeight -lt 400) { throw "Visible test window is too small: $contentHeight px." }
    $topScript = Join-Path $repo 'tests/e2e/fixtures/b2_top_window.ps1'
    $wheelScript = Join-Path $repo 'tests/e2e/fixtures/b2_os_wheel.ps1'
    $topHeight = 72
    $topWindow = Start-Process -FilePath 'pwsh' -ArgumentList @(
      '-NoProfile', '-NonInteractive', '-File', ('"' + $topScript + '"'),
      '-X', [string]$rect.left, '-Y', [string]$rect.top,
      '-W', '380', '-H', [string]$topHeight, '-Stop', ('"' + $stopTop + '"')
    ) -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 2
    if ((Get-State).foreground) { throw 'The B2 topmost helper did not take foreground.' }

    $scrollY = [double](Get-State).view.scrollY
    $viewerX = [int]($rect.left + ([int]$rect.right - [int]$rect.left) / 2)
    $viewerY = [int]($rect.top + [int]($contentHeight * 0.65))
    & pwsh -NoProfile -NonInteractive -File $wheelScript -X $viewerX -Y $viewerY -Delta -600
    if ($LASTEXITCODE -ne 0) { throw 'B2 wheel helper failed over the viewer.' }
    Wait-For { [double](Get-State).view.scrollY -gt $scrollY } 'real wheel over Viewer while another window is on top' 15
    $afterViewer = [double](Get-State).view.scrollY

    $coveredY = [int]($rect.top + 24)
    & pwsh -NoProfile -NonInteractive -File $wheelScript -X ([int]($rect.left + 120)) -Y $coveredY -Delta -600
    if ($LASTEXITCODE -ne 0) { throw 'B2 wheel helper failed over the covered top strip.' }
    Start-Sleep -Seconds 1
    if ([math]::Abs([double](Get-State).view.scrollY - $afterViewer) -gt 2) {
      throw 'Wheel over the other window covering Chef scrolled the viewer.'
    }
    Write-Output 'B2 OS wheel passed: wheel over the uncovered viewer scrolls while inactive; wheel over the covered title strip does not scroll Chef.'
    Set-Content -LiteralPath $stopTop -Value 'stop'
    if ($topWindow) { [void]$topWindow.WaitForExit(5000) }
  } else {
    Write-Output 'OS PageUp/PageDown, wheel, and B2 other-window input skipped. Set CHEF_E2E_OS_INPUT=1 to opt in.'
  }
  Send 'quit' | Out-Null
} finally {
  if ($topWindow -and -not $topWindow.HasExited) {
    Set-Content -LiteralPath $stopTop -Value 'stop'
    [void]$topWindow.WaitForExit(5000)
    if (-not $topWindow.HasExited) { Stop-Process -Id $topWindow.Id -Force }
  }
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
