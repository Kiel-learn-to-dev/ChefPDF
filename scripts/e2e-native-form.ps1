<#
.SYNOPSIS
  E2E cho điều khiển biểu mẫu (TASKS_RUST R2.04, BLUEPRINT_RUST §6.6, D81): ô nhập có nhãn,
  checkbox (Space và Enter bật/tắt, không xác định bấm sang bật), switch (Space và Enter).

.DESCRIPTION
  Chạy trang thử (CHEF_E2E=1, CHEF_E2E_PROBE=1). Điều khiển được tìm theo id trong `state.controls`.
  Tiêu điểm đi bằng Tab cho tới khi đúng điều khiển cần kiểm. Cần `cargo build -p chef-app`.
#>
param([string]$Exe)

$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\apps\native\target\debug\chef-app.exe" }

Get-Process chef-app -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }

$env:CHEF_E2E = "1"
$env:CHEF_E2E_PROBE = "1"
$log = Join-Path $env:TEMP ("chef-form-" + [guid]::NewGuid().ToString("N") + ".txt")
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

function Controls() { return (Send 'state' | ConvertFrom-Json).controls.controls }
function Ctl([string]$id) { return Controls | Where-Object { $_.id -eq $id } }
# Bấm chuột vào giữa điều khiển, tọa độ lấy từ bounds logic × scale của chính state (D81).
function ClickCtl([string]$id) {
    $c = Ctl $id
    $s = [double](Send 'state' | ConvertFrom-Json).controls.scale
    $x = [int](($c.bounds[0] + $c.bounds[2] / 2) * $s)
    $y = [int](($c.bounds[1] + $c.bounds[3] / 2) * $s)
    Send "mouse move $x $y" | Out-Null; Start-Sleep -Milliseconds 80
    Send "mouse down $x $y" | Out-Null; Start-Sleep -Milliseconds 60
    Send "mouse up $x $y" | Out-Null; Start-Sleep -Milliseconds 250
}
function FocusedId() { return (Controls | Where-Object { $_.focused } | ForEach-Object { $_.id }) -join "," }

# Tab cho tới khi đúng điều khiển có tiêu điểm (tối đa 12 lần).
function TabTo([string]$id) {
    for ($i = 0; $i -lt 12; $i++) {
        if ((FocusedId) -eq $id) { return }
        Send "key 9" | Out-Null
        Start-Sleep -Milliseconds 150
    }
}

$script:fails = 0
function Expect([string]$name, $actual, $expected) {
    if ($actual -ceq $expected) { Write-Output "PASS $name" }
    else { $script:fails++; Write-Output "FAIL $name : got [$actual] want [$expected]" }
}

try {
    Start-Sleep -Milliseconds 800

    $name = Ctl "probe-name"
    Expect "text field has its label as accessible name" $name.name "Họ tên"
    Expect "text field role is textbox" $name.role "textbox"
    Expect "text field starts empty" $name.value ""
    Expect "checkbox role" (Ctl "probe-check").role "checkbox"
    Expect "checkbox starts unchecked" (Ctl "probe-check").checked "false"
    Expect "indeterminate checkbox starts mixed" (Ctl "probe-mixed").checked "mixed"
    Expect "switch role" (Ctl "probe-switch").role "switch"
    Expect "switch starts off" (Ctl "probe-switch").checked "false"

    # Checkbox: Space bật, Space tắt; Enter cũng đổi (nút gốc Radix, GPUI cũng kích hoạt cả hai).
    TabTo "probe-check"
    Expect "focus reaches checkbox" (FocusedId) "probe-check"
    Send "key 32" | Out-Null
    Start-Sleep -Milliseconds 250
    Expect "Space checks the checkbox" (Ctl "probe-check").checked "true"
    Send "key 32" | Out-Null
    Start-Sleep -Milliseconds 250
    Expect "Space unchecks the checkbox" (Ctl "probe-check").checked "false"
    Send "key 13" | Out-Null
    Start-Sleep -Milliseconds 250
    Expect "Enter toggles the checkbox as a native button does" (Ctl "probe-check").checked "true"
    Send "key 13" | Out-Null
    Start-Sleep -Milliseconds 250
    Expect "Enter toggles back" (Ctl "probe-check").checked "false"

    # Checkbox không xác định: bấm sang bật, không quay về tắt.
    TabTo "probe-mixed"
    Expect "focus reaches indeterminate checkbox" (FocusedId) "probe-mixed"
    Send "key 32" | Out-Null
    Start-Sleep -Milliseconds 250
    Expect "indeterminate becomes checked on Space" (Ctl "probe-mixed").checked "true"

    # Switch: Space và Enter bật và tắt.
    TabTo "probe-switch"
    Expect "focus reaches switch" (FocusedId) "probe-switch"
    Send "key 32" | Out-Null
    Start-Sleep -Milliseconds 250
    Expect "Space turns the switch on" (Ctl "probe-switch").checked "true"
    Send "key 13" | Out-Null
    Start-Sleep -Milliseconds 250
    Expect "Enter turns the switch off" (Ctl "probe-switch").checked "false"
    Send "key 32" | Out-Null
    Start-Sleep -Milliseconds 250
    Expect "Space turns the switch on again" (Ctl "probe-switch").checked "true"

    # Chuột: bấm vào hàng checkbox và switch cũng đổi trạng thái (không chỉ bàn phím).
    ClickCtl "probe-check"
    Expect "mouse click checks the checkbox" (Ctl "probe-check").checked "true"
    ClickCtl "probe-switch"
    Expect "mouse click turns the switch off" (Ctl "probe-switch").checked "false"
}
finally {
    Send "quit" | Out-Null
    Start-Sleep -Milliseconds 300
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
