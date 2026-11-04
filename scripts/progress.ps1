# Tiến độ Chef PDF v1 trong PowerShell.
#
#   powershell -ExecutionPolicy Bypass -File scripts\progress.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\progress.ps1 -Log "<đường dẫn log e2e>" -Follow
#
# -Log      file log của lần chạy test (tail hiển thị 15 dòng cuối)
# -Follow   theo dõi log trực tiếp (Ctrl+C để thoát)

param(
    [string]$Log = "",
    [switch]$Follow
)

$root = Split-Path -Parent $PSScriptRoot
$tasks = Join-Path $root "docs\TASKS.md"

$rows = Get-Content $tasks -Encoding UTF8 | Where-Object { $_ -match '^\| T\d+\.\d+ \|' }
$total = 0; $done = 0; $open = 0; $paused = 0
$pointsTotal = 0.0; $pointsDone = 0.0
foreach ($row in $rows) {
    $cells = $row.Split('|') | ForEach-Object { $_.Trim() }
    $status = $cells[-2]
    $points = 0.0
    [double]::TryParse(($cells[4] -replace ',', '.'), [ref]$points) | Out-Null
    $total++; $pointsTotal += $points
    if ($status.StartsWith('✅')) { $done++; $pointsDone += $points }
    elseif ($status.StartsWith('⏸')) { $paused++ }
    else { $open++ }
}

Write-Host ""
Write-Host "Chef PDF v1: tiến độ theo task" -ForegroundColor Cyan
Write-Host ("  Xong:      {0} / {1}" -f $done, $total)
Write-Host ("  Đang làm / chưa làm: {0}" -f $open)
Write-Host ("  Hoãn:      {0}" -f $paused)
Write-Host ("  Theo điểm: {0:N1} / {1:N1} = {2:N1}%" -f $pointsDone, $pointsTotal, (100 * $pointsDone / [math]::Max(1, $pointsTotal)))

if ($Log -ne "") {
    if (-not (Test-Path $Log)) {
        Write-Host ""
        Write-Host "Chưa có log: $Log" -ForegroundColor Yellow
    } elseif ($Follow) {
        Write-Host ""
        Write-Host "Theo dõi log (Ctrl+C để thoát):" -ForegroundColor Cyan
        Get-Content $Log -Wait -Tail 15
    } else {
        Write-Host ""
        Write-Host "Log gần nhất:" -ForegroundColor Cyan
        Get-Content $Log -Tail 15
    }
}
