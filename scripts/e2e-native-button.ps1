<#
.SYNOPSIS
  E2E cho nút chef-ui (TASKS_RUST R2.03, BLUEPRINT_RUST §6.6, D81): nút có tên truy cập, Tab đi
  qua nút và bỏ qua nút vô hiệu, hover tìm nút theo id qua lệnh `state`.

.DESCRIPTION
  Chạy trang thử (CHEF_E2E=1, CHEF_E2E_PROBE=1). Mọi tọa độ lấy từ `state.controls` (bounds logic ×
  scale), không gõ cứng. Cần `cargo build -p chef-app`.
#>
param([string]$Exe)

$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\apps\native\target\debug\chef-app.exe" }

Get-Process chef-app -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }

$env:CHEF_E2E = "1"
$env:CHEF_E2E_PROBE = "1"
$log = Join-Path $env:TEMP ("chef-button-" + [guid]::NewGuid().ToString("N") + ".txt")
$proc = Start-Process -FilePath $Exe -PassThru -RedirectStandardError $log -WindowStyle Hidden
$env:CHEF_E2E = $null
$env:CHEF_E2E_PROBE = $null
Start-Sleep -Seconds 4

$text = Get-Content $log -Raw
$pipe = [regex]::Match($text, 'chef-native-\d+').Value
$tok = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value

function Send([string]$cmd) {
    $c = New-Object System.IO.Pipes.NamedPipeClientStream(".", $pipe, [System.IO.Pipes.PipeDirection]::InOut)
    $c.Connect(3000)
    $w = New-Object System.IO.StreamWriter($c, [System.Text.UTF8Encoding]::new($false))
    $w.AutoFlush = $true; $w.NewLine = "`n"
    $r = New-Object System.IO.StreamReader($c, [System.Text.UTF8Encoding]::new($false))
    $w.WriteLine("$tok $cmd")
    $reply = $r.ReadLine()
    $c.Dispose()
    return $reply
}

function Buttons() { return (Send 'state' | ConvertFrom-Json).controls.controls | Where-Object { $_.role -eq 'button' } }
function Find($list, [string]$id) { return $list | Where-Object { $_.id -eq $id } }

$script:fails = 0
function Expect([string]$name, $actual, $expected) {
    if ($actual -ceq $expected) { Write-Output "PASS $name" }
    else { $script:fails++; Write-Output "FAIL $name : got [$actual] want [$expected]" }
}

$ids = @("probe-primary", "probe-secondary", "probe-ghost", "probe-danger", "probe-disabled", "probe-icon", "dialog-open")

try {
    Start-Sleep -Milliseconds 800
    $state = Send 'state' | ConvertFrom-Json
    $scale = $state.controls.scale
    $b = $state.controls.controls | Where-Object { $_.role -eq 'button' }
    Expect "seven buttons registered" $b.Count 7
    Expect "ids are stable" (($b | ForEach-Object { $_.id }) -join ",") ($ids -join ",")
    foreach ($item in $b) {
        if ([string]::IsNullOrEmpty($item.name)) { $script:fails++; Write-Output "FAIL name empty for $($item.id)" }
    }
    Expect "icon-only button has accessible name" (Find $b "probe-icon").name "Sao chép"
    Expect "disabled button is marked disabled" (Find $b "probe-disabled").disabled $true
    Expect "enabled button is not disabled" (Find $b "probe-primary").disabled $false
    Expect "primary holds focus at start" (Find $b "probe-primary").focused $true

    # Tab: qua các nút, bỏ qua nút vô hiệu, rồi sang checkbox và switch của khu biểu mẫu, rồi nút mở hộp thoại (R2.10), rồi vòng về đầu.
    $order = @("probe-secondary", "probe-ghost", "probe-danger", "probe-icon", "probe-check", "probe-mixed", "probe-switch", "dialog-open", "probe-primary")
    foreach ($expected in $order) {
        Send "key 9" | Out-Null
        Start-Sleep -Milliseconds 200
        $focused = (Send 'state' | ConvertFrom-Json).controls.controls | Where-Object { $_.focused } | ForEach-Object { $_.id }
        Expect "Tab focuses $expected" ($focused -join ",") $expected
    }

    # Hover: đưa chuột vào giữa nút Ghost, tính từ bounds và scale của chính nó.
    $ghost = Find (Buttons) "probe-ghost"
    $cx = [int](($ghost.bounds[0] + $ghost.bounds[2] / 2) * $scale)
    $cy = [int](($ghost.bounds[1] + $ghost.bounds[3] / 2) * $scale)
    Send "mouse move $cx $cy" | Out-Null
    Start-Sleep -Milliseconds 400
    $now = Buttons
    Expect "hover enters ghost" (Find $now "probe-ghost").hovered $true
    Expect "hover leaves others" ((Find $now "probe-secondary").hovered) $false
    $sec = Find (Buttons) "probe-secondary"
    $sx = [int](($sec.bounds[0] + $sec.bounds[2] / 2) * $scale)
    $sy = [int](($sec.bounds[1] + $sec.bounds[3] / 2) * $scale)
    # Đi từng bước để con trỏ rời nút Ghost qua các điểm trung gian, như chuột thật.
    $gx = [int](($ghost.bounds[0] + $ghost.bounds[2] / 2) * $scale)
    for ($i = 1; $i -le 8; $i++) {
        $x = $gx + [int](($sx - $gx) * $i / 8)
        Send "mouse move $x $sy" | Out-Null
        Start-Sleep -Milliseconds 60
    }
    Send "mouse move $sx $sy" | Out-Null
    Start-Sleep -Milliseconds 400
    $now = Buttons
    Expect "hover leaves ghost when pointer moves to another button" (Find $now "probe-ghost").hovered $false
    Expect "hover enters secondary" (Find $now "probe-secondary").hovered $true
}
finally {
    Send "quit" | Out-Null
    Start-Sleep -Milliseconds 300
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
