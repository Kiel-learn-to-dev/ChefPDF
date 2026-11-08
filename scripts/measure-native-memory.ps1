# Đo RAM của bản native (TASKS_RUST R1.37, bản tối thiểu). Chạy ngoài màn hình (CHEF_E2E=1).
# Dùng: powershell -ExecutionPolicy Bypass -File scripts/measure-native-memory.ps1 -Pdf <tệp.pdf> [-Screens 350]
# In một dòng PERFMEM cho mỗi mốc: tổng working set của cây tiến trình chef-app (MB), kèm số lần vẽ.
param(
  [Parameter(Mandatory = $true)] [string] $Pdf,
  [int] $Screens = 350,
  [string] $Exe = ""
)
# $PSScriptRoot không có sẵn trong giá trị mặc định khi chạy bằng -File, nên tính ở đây.
if (-not $Exe) {
  $Exe = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\apps\native\target\debug\chef-app.exe"
}

function Get-TreeMb([int]$rootPid) {
  if ($rootPid -le 0) { throw "không có tiến trình để đo (rootPid=$rootPid)" }
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize
  $ids = @($rootPid)
  $added = $true
  while ($added) {
    $added = $false
    foreach ($row in $all) {
      if (($ids -contains [int]$row.ParentProcessId) -and -not ($ids -contains [int]$row.ProcessId)) {
        $ids += [int]$row.ProcessId
        $added = $true
      }
    }
  }
  $sum = ($all | Where-Object { $ids -contains [int]$_.ProcessId } | Measure-Object -Property WorkingSetSize -Sum).Sum
  return [math]::Round($sum / 1MB, 1)
}

function Ask($app, [string]$cmd) {
  $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $app.Pipe, [System.IO.Pipes.PipeDirection]::InOut)
  $client.Connect(3000)
  $writer = New-Object System.IO.StreamWriter($client)
  $writer.AutoFlush = $true
  $writer.NewLine = "`n"
  $reader = New-Object System.IO.StreamReader($client)
  $writer.WriteLine($app.Token + ' ' + $cmd)
  $reply = $reader.ReadLine()
  $client.Dispose()
  return $reply
}

$exePath = Resolve-Path -LiteralPath $Exe -ErrorAction Stop
$env:CHEF_E2E = '1'
$env:CHEF_E2E_SCROLL_SCREENS = [string]$Screens
$log = Join-Path $env:TEMP ('chef-perf-' + [guid]::NewGuid().ToString('N') + '.txt')
$proc = Start-Process -FilePath $exePath.Path -ArgumentList ('"' + $Pdf + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
Remove-Item Env:CHEF_E2E_SCROLL_SCREENS
Remove-Item Env:CHEF_E2E
Start-Sleep -Seconds 3
$text = Get-Content $log -Raw
$app = [pscustomobject]@{
  Proc = $proc
  Pipe = [regex]::Match($text, 'chef-native-\d+').Value
  Token = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
}

if ($null -eq $proc) { throw 'không khởi động được chef-app' }
if (-not $app.Pipe) { throw 'không tìm thấy pipe kênh debug (CHEF_E2E không có hiệu lực?)' }
Write-Output ('PERFMEM open nativeMB=' + (Get-TreeMb $proc.Id) + ' renders=' + ((Ask $app 'state') | ConvertFrom-Json).renders)

# Cuộn xong (mỗi bước 150 ms) rồi chờ render ổn định.
$expectedSeconds = [math]::Ceiling($Screens * 0.15) + 3
Start-Sleep -Seconds $expectedSeconds
$state = (Ask $app 'state') | ConvertFrom-Json
Write-Output ('PERFMEM after-scroll-' + $Screens + ' nativeMB=' + (Get-TreeMb $proc.Id) + ' renders=' + $state.renders + ' cached=' + $state.cached + ' pending=' + $state.pending)

Start-Sleep -Seconds 5
Write-Output ('PERFMEM settled nativeMB=' + (Get-TreeMb $proc.Id))

Ask $app 'quit' | Out-Null
Start-Sleep -Milliseconds 300
if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
