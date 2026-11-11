<#
.SYNOPSIS
  E2E cho nhóm chọn một, nhóm nút bật và thanh trượt (TASKS_RUST R2.05, BLUEPRINT_RUST §6.6):
  mỗi nhóm chỉ có một điểm dừng Tab; mũi tên trong nhóm chọn một vừa chuyển tiêu điểm vừa chọn
  (có vòng lại); mũi tên trong nhóm nút bật chỉ chuyển tiêu điểm; thanh trượt đổi theo bước, PageUp,
  PageDown, Home và End.

.DESCRIPTION
  Chạy trang thử (CHEF_E2E=1, CHEF_E2E_PROBE=1). Phím đi bằng `key <mã VK>`: 9 Tab, 13 Enter,
  33 PageUp, 34 PageDown, 35 End, 36 Home, 37 trái, 38 lên, 39 phải, 40 xuống. Cần `cargo build -p chef-app`.
#>
param([string]$Exe)

$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\apps\native\target\debug\chef-app.exe" }

Get-Process chef-app -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }

$env:CHEF_E2E = "1"
$env:CHEF_E2E_PROBE = "1"
$log = Join-Path $env:TEMP ("chef-choice-" + [guid]::NewGuid().ToString("N") + ".txt")
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
function Controls() { return ((Send 'state' | ConvertFrom-Json).controls.controls) }
function Ctrl([string]$id) { return Controls | Where-Object { $_.id -eq $id } | Select-Object -First 1 }
function Focused() {
    $f = Controls | Where-Object { $_.focused } | Select-Object -First 1
    if ($f) { return [string]$f.id } else { return "" }
}
function Key([int]$vk) { Send "key $vk" | Out-Null; Start-Sleep -Milliseconds 150 }
function Action([string]$name) { Send "action $name" | Out-Null; Start-Sleep -Milliseconds 150 }

$script:fails = 0
function Expect([string]$name, $actual, $expected) {
    if ($actual -ceq $expected) { Write-Output "PASS $name" }
    else { $script:fails++; Write-Output "FAIL $name : got [$actual] want [$expected]" }
}

try {
    Start-Sleep -Milliseconds 800

    # 0. Đưa tiêu điểm vào nhóm chọn một bằng Tab.
    for ($i = 0; $i -lt 80 -and (Focused) -ne "probe-radio-0"; $i++) { Key 9 }
    Expect "Tab reaches the selected radio item" (Focused) "probe-radio-0"
    Expect "radio item 0 starts checked" (Ctrl "probe-radio-0").checked "true"
    Expect "radio group is labelled" (Ctrl "probe-radio").role "radiogroup"

    # 1. Một điểm dừng Tab: Tab tiếp theo không vào mục 1 hoặc 2 của nhóm.
    Key 9
    $afterOne = Focused
    Expect "Tab leaves the radio group after one stop" ($afterOne -like "probe-radio-*") $false

    # 2. Mũi tên trong nhóm chọn một chuyển tiêu điểm và chọn luôn, có vòng lại.
    Action "focusprev"
    Expect "back on radio item 0" (Focused) "probe-radio-0"
    Key 40
    Expect "Down moves focus to item 1" (Focused) "probe-radio-1"
    Expect "Down checks item 1" (Ctrl "probe-radio-1").checked "true"
    Expect "Down unchecks item 0" (Ctrl "probe-radio-0").checked "false"
    Key 39
    Expect "Right moves to item 2 and checks it" ((Focused) + " " + (Ctrl "probe-radio-2").checked) "probe-radio-2 true"
    Key 40
    Expect "Down wraps to item 0" ((Focused) + " " + (Ctrl "probe-radio-0").checked) "probe-radio-0 true"
    Key 38
    Expect "Up wraps to item 2" ((Focused) + " " + (Ctrl "probe-radio-2").checked) "probe-radio-2 true"
    Key 37
    Expect "Left moves to item 1" ((Focused) + " " + (Ctrl "probe-radio-1").checked) "probe-radio-1 true"

    # 3. Tab từ nhóm chọn một sang nhóm nút bật; điểm dừng là mục đang bật (mục 0 lúc này).
    Key 9
    Expect "Tab goes to the selected toggle item" (Focused) "probe-toggle-0"
    Expect "toggle group items are buttons with pressed state" (Ctrl "probe-toggle-0").checked "true"

    # 4. Mũi tên trong nhóm nút bật chỉ chuyển tiêu điểm, không đổi lựa chọn.
    Key 39
    Expect "Right moves focus to toggle item 1" (Focused) "probe-toggle-1"
    Expect "arrow does not change toggle selection" ((Ctrl "probe-toggle-0").checked) "true"
    Expect "toggle item 1 is still off" ((Ctrl "probe-toggle-1").checked) "false"

    # 5. Enter bật mục đang có tiêu điểm.
    Key 13
    Expect "Enter turns toggle item 1 on" ((Ctrl "probe-toggle-1").checked) "true"
    Expect "Enter turns toggle item 0 off" ((Ctrl "probe-toggle-0").checked) "false"

    # 6. Thanh trượt: Tab vào, giá trị ban đầu 50.
    Key 9
    Expect "Tab reaches the slider" (Focused) "probe-slider"
    Expect "slider starts at 50" (Ctrl "probe-slider").value "50"
    Expect "slider role" (Ctrl "probe-slider").role "slider"

    Key 39
    Expect "Right adds one step (5)" (Ctrl "probe-slider").value "55"
    Key 39
    Expect "second Right reaches 60" (Ctrl "probe-slider").value "60"
    Key 34
    Expect "PageDown subtracts ten steps" (Ctrl "probe-slider").value "10"
    Key 33
    Expect "PageUp adds ten steps" (Ctrl "probe-slider").value "60"
    Key 36
    Expect "Home goes to the minimum" (Ctrl "probe-slider").value "0"
    Key 37
    Expect "Left at the minimum stays at 0" (Ctrl "probe-slider").value "0"
    Key 35
    Expect "End goes to the maximum" (Ctrl "probe-slider").value "100"
    Key 40
    Expect "Down subtracts one step" (Ctrl "probe-slider").value "95"

    $shot = Join-Path $env:TEMP "choice-final.bmp"
    Write-Output ("shot: " + (Send ("screenshot " + $shot)))
}
finally {
    Send "quit" | Out-Null
    Start-Sleep -Milliseconds 300
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
