<#
.SYNOPSIS
  E2E cho khung hộp thoại (TASKS_RUST R2.10, BLUEPRINT_RUST §6.7): Enter mở, Tab và Shift+Tab đi vòng
  trong hộp thoại, Esc đóng và trả tiêu điểm, bấm ra ngoài đóng, bấm trong khung không đóng, Esc khi
  tiêu điểm ở ô nhập vẫn đóng, các nút Hủy, Lưu và Đóng đều đóng. Cờ giảm chuyển động theo biến ghi đè.

.DESCRIPTION
  Chạy trang thử (CHEF_E2E=1, CHEF_E2E_PROBE=1). Phím đi bằng `key <mã VK>` (9 Tab, 13 Enter, 27 Esc).
  Shift+Tab đi bằng `action focusprev` vì `key` không gửi được modifier. Mọi tọa độ chuột lấy từ
  `state.controls` (bounds logic × scale). Cần `cargo build -p chef-app`.
  -Motion 1 đặt CHEF_E2E_REDUCED_MOTION=1 và kiểm `reducedMotion` của state là true; mặc định 0.
#>
param(
    [string]$Exe,
    [ValidateSet("0", "1")][string]$Motion = "0"
)

$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\apps\native\target\debug\chef-app.exe" }

Get-Process chef-app -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }

$env:CHEF_E2E = "1"
$env:CHEF_E2E_PROBE = "1"
$env:CHEF_E2E_REDUCED_MOTION = $Motion
$log = Join-Path $env:TEMP ("chef-dialog-" + [guid]::NewGuid().ToString("N") + ".txt")
$proc = Start-Process -FilePath $Exe -PassThru -RedirectStandardError $log -WindowStyle Hidden
$env:CHEF_E2E = $null
$env:CHEF_E2E_PROBE = $null
$env:CHEF_E2E_REDUCED_MOTION = $null
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
function IsOpen() { return $null -ne (Ctrl "dlg") }
function Key([int]$vk) { Send "key $vk" | Out-Null; Start-Sleep -Milliseconds 150 }
function Click($control) {
    if ($null -eq $control -or $null -eq $control.bounds) { throw "điều khiển không có bounds để bấm" }
    $s = [double](State).controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $s)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $s)
    Send "mouse move $x $y" | Out-Null; Start-Sleep -Milliseconds 80
    Send "mouse down $x $y" | Out-Null; Start-Sleep -Milliseconds 60
    Send "mouse up $x $y" | Out-Null; Start-Sleep -Milliseconds 250
}
function ClickAt([double]$lx, [double]$ly) {
    $s = [double](State).controls.scale
    $x = [int]($lx * $s); $y = [int]($ly * $s)
    Send "mouse move $x $y" | Out-Null; Start-Sleep -Milliseconds 80
    Send "mouse down $x $y" | Out-Null; Start-Sleep -Milliseconds 60
    Send "mouse up $x $y" | Out-Null; Start-Sleep -Milliseconds 250
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

try {
    Start-Sleep -Milliseconds 800

    # 0. Đưa tiêu điểm tới nút mở bằng Tab (không gọi thẳng action).
    for ($i = 0; $i -lt 40 -and (Focused) -ne "dialog-open"; $i++) { Key 9 }
    Expect "Tab reaches the opener button" (Focused) "dialog-open"
    ExpectTrue "dialog is closed before opening" (-not (IsOpen)) "dlg đang mở từ đầu"

    # 1. Enter mở hộp thoại; tiêu điểm vào trong hộp thoại.
    Key 13; Start-Sleep -Milliseconds 400
    ExpectTrue "Enter opens the dialog" (IsOpen) "không thấy dlg trong controls"
    ExpectTrue "focus moves into the dialog on open" ((Focused) -like "dlg-*") ("focus đang ở [" + (Focused) + "]")

    # 2. Tab đi vòng: 10 lần phải đi qua cả năm điều khiển, không rời hộp thoại.
    $visited = @()
    for ($i = 0; $i -lt 10; $i++) { Key 9; $visited += (Focused) }
    $outside = @($visited | Where-Object { $_ -notlike "dlg-*" })
    ExpectTrue "Tab never leaves the dialog" ($outside.Count -eq 0) ("rời ra ngoài: " + ($outside -join ","))
    $distinct = @($visited | Sort-Object -Unique)
    ExpectTrue "Tab visits all five controls and wraps" ($distinct.Count -eq 5) ("đi qua: " + ($distinct -join ","))

    # 3. Shift+Tab đi ngược và vòng lại (action, vì key không gửi modifier). Sau 10 Tab tiêu điểm ở
    #    dlg-close (mục đầu), nên Shift+Tab phải sang dlg-ok (mục cuối), rồi dlg-cancel.
    Expect "ten Tabs end on the first control" $visited[-1] "dlg-close"
    Send "action focusprev" | Out-Null; Start-Sleep -Milliseconds 150
    Expect "Shift+Tab from the first control wraps to the last" (Focused) "dlg-ok"
    Send "action focusprev" | Out-Null; Start-Sleep -Milliseconds 150
    Expect "second Shift+Tab goes back one control" (Focused) "dlg-cancel"
    Send "action focusnext" | Out-Null; Start-Sleep -Milliseconds 150
    Expect "Tab goes forward again" (Focused) "dlg-ok"

    # 4. Esc đóng và trả tiêu điểm về nút đã mở.
    Key 27; Start-Sleep -Milliseconds 300
    ExpectTrue "Esc closes the dialog" (-not (IsOpen)) "dlg vẫn còn trong controls"
    Expect "focus returns to the opener after Esc" (Focused) "dialog-open"

    # 5. Bấm ra ngoài đóng (lớp phủ nằm ở góc trên trái, ngoài khung).
    Key 13; Start-Sleep -Milliseconds 400
    ClickAt 20 20
    ExpectTrue "click outside the panel closes the dialog" (-not (IsOpen)) "dlg vẫn mở sau khi bấm ra ngoài"
    Expect "focus returns to the opener after outside click" (Focused) "dialog-open"

    # 6. Bấm vào ô nhập trong khung: hộp thoại vẫn mở và ô nhập nhận tiêu điểm.
    Key 13; Start-Sleep -Milliseconds 400
    $name = Ctrl "dlg-name"
    ExpectTrue "text field has bounds to click" ($null -ne $name -and $null -ne $name.bounds) "dlg-name không có bounds"
    Click $name
    ExpectTrue "click inside the panel keeps it open" (IsOpen) "dlg đã đóng khi bấm vào ô nhập"
    Expect "focus moves to the text field on click" (Focused) "dlg-name"

    # Bấm checkbox trong khung đổi trạng thái và khung vẫn mở (kiểm chuột trên điều khiển biểu mẫu).
    Expect "checkbox in the dialog starts checked" (Ctrl "dlg-keep-ext").checked "true"
    Click (Ctrl "dlg-keep-ext")
    Expect "mouse click unchecks the dialog checkbox" (Ctrl "dlg-keep-ext").checked "false"
    ExpectTrue "dialog stays open after the checkbox click" (IsOpen) "dlg đã đóng sau khi bấm checkbox"

    # 7. Esc khi đang gõ trong ô nhập vẫn đóng (ô nhập gửi Cancel, khung nhận).
    Key 27; Start-Sleep -Milliseconds 300
    ExpectTrue "Esc inside the text field closes the dialog" (-not (IsOpen)) "dlg vẫn mở sau Esc trong ô nhập"
    Expect "focus returns to the opener after Esc in the field" (Focused) "dialog-open"

    # 8. Nút Hủy và Lưu đóng hộp thoại.
    Key 13; Start-Sleep -Milliseconds 400
    Click (Ctrl "dlg-cancel")
    ExpectTrue "Hủy closes the dialog" (-not (IsOpen)) "dlg vẫn mở sau Hủy"
    Expect "focus returns to the opener after Hủy" (Focused) "dialog-open"
    Key 13; Start-Sleep -Milliseconds 400
    Click (Ctrl "dlg-ok")
    ExpectTrue "Lưu closes the dialog" (-not (IsOpen)) "dlg vẫn mở sau Lưu"

    # 9. Nút đóng (X) ở đầu khung.
    Key 13; Start-Sleep -Milliseconds 400
    Click (Ctrl "dlg-close")
    ExpectTrue "close button closes the dialog" (-not (IsOpen)) "dlg vẫn mở sau nút đóng"

    # 10. Cờ giảm chuyển động của state theo biến ghi đè.
    $expectReduced = ($Motion -eq "1")
    Expect "reducedMotion follows CHEF_E2E_REDUCED_MOTION=$Motion" ([bool](State).reducedMotion) $expectReduced

    # 11. Ảnh hộp thoại đang mở để xem bằng mắt (MAN-5).
    Key 13; Start-Sleep -Milliseconds 400
    $shot = Join-Path $env:TEMP "dialog-open-$Motion.bmp"
    Write-Output ("shot: " + (Send ("screenshot " + $shot)))
}
finally {
    Send "quit" | Out-Null
    Start-Sleep -Milliseconds 300
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
