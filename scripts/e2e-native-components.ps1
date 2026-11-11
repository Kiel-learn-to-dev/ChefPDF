<#
.SYNOPSIS
  E2E cho thẻ chuyển, tooltip và thông báo (TASKS_RUST R2.09, R2.11, R2.12):
  thẻ đi bằng mũi tên, Home và End; tooltip hiện sau 450 ms (chuột hoặc tiêu điểm) và 200 ms khi
  chuyển giữa hai nút; thông báo xếp chồng, bấm đóng được và tự ẩn sau 3 giây.

.DESCRIPTION
  Chạy trang thử (CHEF_E2E=1, CHEF_E2E_PROBE=1). Phím đi bằng `key <mã VK>` (9 Tab, 35 End, 36 Home,
  37 trái, 39 phải). Chuột đi qua `mouse move|down|up x y`; tọa độ lấy từ `state.controls` (bounds × scale).
  Thời gian đo bằng đồng hồ phía script, nên có sai số vài chục mili giây. Cần `cargo build -p chef-app`.
#>
param([string]$Exe)

$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\apps\native\target\debug\chef-app.exe" }

Get-Process chef-app -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }

$env:CHEF_E2E = "1"
$env:CHEF_E2E_PROBE = "1"
$log = Join-Path $env:TEMP ("chef-components-" + [guid]::NewGuid().ToString("N") + ".txt")
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
function State() { return (Send 'state' | ConvertFrom-Json) }
function Controls() { return (State).controls.controls }
function Ctrl([string]$id) { return Controls | Where-Object { $_.id -eq $id } | Select-Object -First 1 }
function Focused() {
    $f = Controls | Where-Object { $_.focused } | Select-Object -First 1
    if ($f) { return [string]$f.id } else { return "" }
}
function Key([int]$vk) { Send "key $vk" | Out-Null; Start-Sleep -Milliseconds 150 }
function MoveTo([double]$lx, [double]$ly) {
    $s = [double](State).controls.scale
    Send ("mouse move " + [int]($lx * $s) + " " + [int]($ly * $s)) | Out-Null
    Start-Sleep -Milliseconds 60
}
function ClickCtrl($control) {
    $s = [double](State).controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $s)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $s)
    Send "mouse move $x $y" | Out-Null; Start-Sleep -Milliseconds 80
    Send "mouse down $x $y" | Out-Null; Start-Sleep -Milliseconds 60
    Send "mouse up $x $y" | Out-Null; Start-Sleep -Milliseconds 200
}
# Chờ điều khiển `id` xuất hiện, trả về số mili giây đã chờ, hoặc -1 khi hết thời gian.
function WaitFor([string]$id, [int]$timeoutMs = 2000) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
        if ($null -ne (Ctrl $id)) { return [int]$sw.ElapsedMilliseconds }
        Start-Sleep -Milliseconds 15
    }
    return -1
}
function WaitGone([string]$id, [int]$timeoutMs = 2000) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
        if ($null -eq (Ctrl $id)) { return $true }
        Start-Sleep -Milliseconds 15
    }
    return $false
}

$script:fails = 0
function Expect([string]$name, $actual, $expected) {
    if ($actual -ceq $expected) { Write-Output "PASS $name" }
    else { $script:fails++; Write-Output "FAIL $name : got [$actual] want [$expected]" }
}
function ExpectTrue([string]$name, [bool]$cond, [string]$detail) {
    if ($cond) { Write-Output "PASS $name" }
    else { $script:fails++; Write-Output "FAIL $name : $detail" }
}
function ExpectRange([string]$name, [int]$actual, [int]$low, [int]$high) {
    if ($actual -ge $low -and $actual -le $high) { Write-Output "PASS $name ($actual ms)" }
    else { $script:fails++; Write-Output "FAIL $name : got $actual ms, want $low..$high ms" }
}

try {
    Start-Sleep -Milliseconds 800

    # ---- R2.09: thẻ chuyển ----
    for ($i = 0; $i -lt 80 -and (Focused) -ne "probe-tab-0"; $i++) { Key 9 }
    Expect "Tab reaches the selected tab" (Focused) "probe-tab-0"
    Expect "tab role is tab" (Ctrl "probe-tab-0").role "tab"
    Expect "selected tab reports selected" (Ctrl "probe-tab-0").checked "true"
    Key 39
    Expect "Right moves to and selects tab 1" ((Focused) + " " + (Ctrl "probe-tab-1").checked) "probe-tab-1 true"
    Expect "tab 0 is no longer selected" (Ctrl "probe-tab-0").checked "false"
    Key 39
    Key 39
    Expect "Right wraps to tab 0" (Focused) "probe-tab-0"
    Key 37
    Expect "Left wraps to tab 2" (Focused) "probe-tab-2"
    Key 36
    Expect "Home goes to tab 0" (Focused) "probe-tab-0"
    Key 35
    Expect "End goes to tab 2" ((Focused) + " " + (Ctrl "probe-tab-2").checked) "probe-tab-2 true"

    # ---- R2.11: tooltip ----
    # Thẻ ở trên, nút tooltip ở dưới: đưa chuột ra xa trước.
    MoveTo 20 20
    Start-Sleep -Milliseconds 300
    $tipA = Ctrl "probe-tip-a-btn"
    ExpectTrue "tooltip button has bounds" ($null -ne $tipA -and $null -ne $tipA.bounds) "không có bounds"
    $s = [double](State).controls.scale
    $ax = [int](($tipA.bounds[0] + $tipA.bounds[2] / 2) * $s); $ay = [int](($tipA.bounds[1] + $tipA.bounds[3] / 2) * $s)
    Send "mouse move $ax $ay" | Out-Null
    $t1 = WaitFor "probe-tip-a-tip" 2000
    ExpectRange "hover shows the tooltip after about 450 ms" $t1 330 700
    Expect "tooltip has its text" (Ctrl "probe-tip-a-tip").name "Mở tệp (Ctrl+O)"
    Expect "tooltip role" (Ctrl "probe-tip-a-tip").role "tooltip"

    # Chuyển sang nút B ngay sau khi A đóng: chỉ chờ 200 ms.
    $tipB = Ctrl "probe-tip-b-btn"
    $bx = [int](($tipB.bounds[0] + $tipB.bounds[2] / 2) * $s); $by = [int](($tipB.bounds[1] + $tipB.bounds[3] / 2) * $s)
    Send "mouse move $bx $by" | Out-Null
    $t2 = WaitFor "probe-tip-b-tip" 2000
    ExpectRange "moving to another button shows its tooltip after about 200 ms" $t2 120 380
    ExpectTrue "tooltip A is gone when the pointer leaves" ($null -eq (Ctrl "probe-tip-a-tip")) "tooltip A vẫn hiện"

    # Rời chuột: tooltip B đóng.
    MoveTo 20 20
    ExpectTrue "tooltip B closes when the pointer leaves" (WaitGone "probe-tip-b-tip" 1000) "tooltip B vẫn hiện"

    # Tiêu điểm bàn phím cũng hiện tooltip sau 450 ms. Chờ quá 200 ms sau khi tooltip B đóng, nếu không
    # quy tắc bỏ trễ sẽ áp dụng.
    Start-Sleep -Milliseconds 600
    # Đo từ lúc phím Tab được gửi (tiêu điểm đổi ngay sau đó), không tính thời gian nghỉ của script.
    $focusSw = $null
    for ($i = 0; $i -lt 80 -and (Focused) -ne "probe-tip-a-btn"; $i++) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        Send "key 9" | Out-Null
        Start-Sleep -Milliseconds 60
        if ((Focused) -eq "probe-tip-a-btn") { $focusSw = $sw; break }
        Start-Sleep -Milliseconds 90
    }
    Expect "Tab reaches the tooltip button" (Focused) "probe-tip-a-btn"
    $atDetect = if ($focusSw) { [int]$focusSw.ElapsedMilliseconds } else { 0 }
    $t3 = WaitFor "probe-tip-a-tip" 2000
    ExpectRange "keyboard focus shows the tooltip after about 450 ms" ($atDetect + $t3) 380 800

    # ---- R2.12: thông báo ----
    ClickCtrl (Ctrl "probe-toast")
    ClickCtrl (Ctrl "probe-toast")
    ExpectTrue "two toasts stack" ($null -ne (Ctrl "probe-toast-0") -and $null -ne (Ctrl "probe-toast-1")) "thiếu thông báo"
    Expect "toast has status role" (Ctrl "probe-toast-0").role "status"
    Expect "toast text is readable" (Ctrl "probe-toast-1").name "Thông báo 2"
    ClickCtrl (Ctrl "probe-toast-0-close")
    ExpectTrue "close button removes that toast" (WaitGone "probe-toast-0" 1000) "thông báo 1 vẫn còn sau khi bấm đóng"
    ExpectTrue "the other toast stays" ($null -ne (Ctrl "probe-toast-1")) "thông báo 2 bị mất"
    ExpectTrue "toast auto-hides after 3 seconds" (WaitGone "probe-toast-1" 4000) "thông báo 2 không tự ẩn"
}
finally {
    Send "quit" | Out-Null
    Start-Sleep -Milliseconds 300
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
