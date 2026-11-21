<#
.SYNOPSIS
  E2E cho khung hộp thoại xử lý dùng chung TaskDialog (TASKS_RUST R5.01, BLUEPRINT_RUST §6.6).

.DESCRIPTION
  Chạy trang thử cô lập (CHEF_E2E=1, CHEF_E2E_PROBE=1, CHEF_E2E_PROBE_TASK_DIALOG=1,
  CHEF_E2E_REDUCED_MOTION=1). Kiểm tra:
  - Chia hai cột ở 1484, 1184 và 800 px (cột phụ 300 px bên phải), xếp 1 cột ở 720 px;
  - Cảnh báo, mục "Nâng cao" đóng/mở được, chọn "Nhiều file…" + thêm/bỏ file;
  - Khi đang chạy: nút chạy khóa (disabled + value="loading"), hiện thanh tiến độ và nút Dừng;
  - Đóng khi đang chạy (Esc, nút X, bấm nền) hiện xác nhận dừng; Giữ chạy giữ nguyên trạng thái;
    Dừng và đóng hủy chạy và đóng; hoàn tất bình thường hiện kết quả và đóng không hỏi lại.
#>
param(
    [string]$Exe
)

$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\apps\native\target\debug\chef-app.exe" }

Get-Process chef-app -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }

$env:CHEF_E2E = "1"
$env:CHEF_E2E_PROBE = "1"
$env:CHEF_E2E_PROBE_TASK_DIALOG = "1"
$env:CHEF_E2E_PROBE_WIDTH = "1484"
$env:CHEF_E2E_REDUCED_MOTION = "1"
$log = Join-Path $env:TEMP ("chef-task-dialog-" + [guid]::NewGuid().ToString("N") + ".txt")
$proc = Start-Process -FilePath $Exe -PassThru -RedirectStandardError $log -WindowStyle Hidden
$env:CHEF_E2E = $null
$env:CHEF_E2E_PROBE = $null
$env:CHEF_E2E_PROBE_TASK_DIALOG = $null
$env:CHEF_E2E_PROBE_WIDTH = $null
$env:CHEF_E2E_REDUCED_MOTION = $null

$pipe = $null
$tok = $null
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $log) {
        $text = [string](Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue)
        $mPipe = [regex]::Match($text, 'chef-native-\d+')
        $mTok = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)')
        if ($mPipe.Success -and $mTok.Success) {
            $pipe = $mPipe.Value
            $tok = $mTok.Groups[1].Value
            break
        }
    }
    Start-Sleep -Milliseconds 150
}
if (-not $pipe -or -not $tok) {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    throw "Không đọc được pipe/token debug từ $log"
}

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
function WaitUntil([string]$desc, [int]$timeoutMs, [scriptblock]$pred) {
    $until = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
    while ([DateTime]::UtcNow -lt $until) {
        if (& $pred) { return $true }
        Start-Sleep -Milliseconds 60
    }
    Write-Output "TIMEOUT: $desc"
    return $false
}
function Key([int]$vk) { Send "key $vk" | Out-Null; Start-Sleep -Milliseconds 150 }
function Click($control, [int]$postWaitMs = 200) {
    if ($null -eq $control -or $null -eq $control.bounds) { throw "điều khiển không có bounds để bấm" }
    $s = [double](State).controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $s)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $s)
    Send "mouse move $x $y" | Out-Null; Start-Sleep -Milliseconds 50
    Send "mouse down $x $y" | Out-Null; Start-Sleep -Milliseconds 50
    Send "mouse up $x $y" | Out-Null; Start-Sleep -Milliseconds $postWaitMs
}
function ClickAt([double]$lx, [double]$ly) {
    $s = [double](State).controls.scale
    $x = [int]($lx * $s); $y = [int]($ly * $s)
    Send "mouse move $x $y" | Out-Null; Start-Sleep -Milliseconds 50
    Send "mouse down $x $y" | Out-Null; Start-Sleep -Milliseconds 50
    Send "mouse up $x $y" | Out-Null; Start-Sleep -Milliseconds 200
}
function ResizeAndWait([int]$w, [int]$h, [scriptblock]$pred) {
    $res = Send "resize $w $h"
    if ($res -notmatch '"ok":true') { throw "resize $w $h failed: $res" }
    [void](WaitUntil "resize $w x $h" 3000 $pred)
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

function AssertSplit([string]$label, [double]$expectedDlgW, [double]$maxRight) {
    $dlg = Ctrl "task-dlg"
    $main = Ctrl "task-dlg-main"
    $side = Ctrl "task-dlg-side"
    ExpectTrue "$label has dialog/main/side bounds" (
        $null -ne $dlg -and $null -ne $dlg.bounds -and
        $null -ne $main -and $null -ne $main.bounds -and
        $null -ne $side -and $null -ne $side.bounds
    ) "missing bounds"
    if ($null -eq $dlg -or $null -eq $main -or $null -eq $side) { return }
    $dlgW = [double]$dlg.bounds[2]
    $mainX = [double]$main.bounds[0]
    $mainY = [double]$main.bounds[1]
    $mainW = [double]$main.bounds[2]
    $sideX = [double]$side.bounds[0]
    $sideY = [double]$side.bounds[1]
    $sideW = [double]$side.bounds[2]
    ExpectTrue "$label side is right of main" ($sideX -ge ($mainX + $mainW - 1.0)) "main=[$mainX+$mainW], side=$sideX"
    ExpectTrue "$label side and main top-aligned" ([math]::Abs($sideY - $mainY) -le 4.0) "mainY=$mainY, sideY=$sideY"
    ExpectTrue "$label side width is ~300px" ([math]::Abs($sideW - 300.0) -le 4.0) "sideW=$sideW"
    ExpectTrue "$label dialog width matches ~$expectedDlgW" ([math]::Abs($dlgW - $expectedDlgW) -le 8.0) "dlgW=$dlgW"
    ExpectTrue "$label dialog stays within $maxRight px" (($dlg.bounds[0] + $dlgW) -le ($maxRight + 2.0)) "right=$($dlg.bounds[0] + $dlgW)"
}

try {
    [void](WaitUntil "opener control ready" 5000 { $null -ne (Ctrl "task-dialog-open") -and $null -ne (Ctrl "task-dialog-open").bounds })
    ExpectTrue "TaskDialog closed initially" ($null -eq (Ctrl "task-dlg")) "task-dlg visible initially"

    Click (Ctrl "task-dialog-open")
    [void](WaitUntil "TaskDialog opens" 3000 { $null -ne (Ctrl "task-dlg-side") -and $null -ne (Ctrl "task-dlg-side").bounds })
    ExpectTrue "TaskDialog opens on click" ($null -ne (Ctrl "task-dlg")) "task-dlg not open"

    # 1. Kiểm tra bố cục 3 chiều rộng + thu về 1 cột dưới 760 px.
    AssertSplit "width 1484" 880.0 1484.0

    ResizeAndWait 1184 900 {
        $d = Ctrl "task-dlg"
        $null -ne $d -and $null -ne $d.bounds -and $d.bounds[0] -gt 80 -and $d.bounds[0] -lt 220
    }
    AssertSplit "width 1184" 880.0 1184.0

    ResizeAndWait 800 900 {
        $d = Ctrl "task-dlg"
        $null -ne $d -and $null -ne $d.bounds -and [double]$d.bounds[2] -lt 770
    }
    AssertSplit "width 800" 752.0 800.0

    ResizeAndWait 720 900 {
        $m = Ctrl "task-dlg-main"
        $s = Ctrl "task-dlg-side"
        $null -ne $m -and $null -ne $s -and $null -ne $m.bounds -and $null -ne $s.bounds -and ([double]$s.bounds[1] -ge ([double]$m.bounds[1] + [double]$m.bounds[3] - 1.0))
    }
    $m720 = Ctrl "task-dlg-main"
    $s720 = Ctrl "task-dlg-side"
    ExpectTrue "width 720 stacks side below main" ([double]$s720.bounds[1] -ge ([double]$m720.bounds[1] + [double]$m720.bounds[3] - 1.0)) "main=$($m720.bounds -join ','), side=$($s720.bounds -join ',')"
    ExpectTrue "width 720 aligns left edges" ([math]::Abs([double]$s720.bounds[0] - [double]$m720.bounds[0]) -le 4.0) "mainX=$($m720.bounds[0]), sideX=$($s720.bounds[0])"
    ExpectTrue "width 720 expands side full width" ([double]$s720.bounds[2] -gt 500.0) "sideW=$($s720.bounds[2])"

    ResizeAndWait 1184 900 {
        $m = Ctrl "task-dlg-main"
        $s = Ctrl "task-dlg-side"
        $null -ne $m -and $null -ne $s -and $null -ne $m.bounds -and $null -ne $s.bounds -and ([double]$s.bounds[0] -ge ([double]$m.bounds[0] + [double]$m.bounds[2] - 1.0))
    }
    AssertSplit "restored 1184" 880.0 1184.0

    # 2. Kiểm tra cảnh báo, Nâng cao thu gọn, và Áp dụng cho Nhiều file.
    ExpectTrue "warnings alert rendered" ($null -ne (Ctrl "task-dlg-warnings")) "missing task-dlg-warnings"
    Expect "advanced starts collapsed" (Ctrl "task-dlg-advanced-toggle").checked "false"
    ExpectTrue "advanced child hidden when collapsed" ($null -eq (Ctrl "task-adv-compress")) "task-adv-compress visible when collapsed"
    Click (Ctrl "task-dlg-advanced-toggle")
    Expect "advanced opens on click" (Ctrl "task-dlg-advanced-toggle").checked "true"
    ExpectTrue "advanced child visible when open" ($null -ne (Ctrl "task-adv-compress")) "missing task-adv-compress"
    Click (Ctrl "task-dlg-advanced-toggle")
    Expect "advanced collapses on second click" (Ctrl "task-dlg-advanced-toggle").checked "false"

    Click (Ctrl "task-dlg-apply-multiple")
    [void](WaitUntil "add-files button appears" 2000 { $null -ne (Ctrl "task-dlg-add-files") })
    ExpectTrue "add-files button appears in MultipleFiles mode" ($null -ne (Ctrl "task-dlg-add-files")) "missing task-dlg-add-files"
    Click (Ctrl "task-dlg-add-files")
    [void](WaitUntil "first file row appears" 2000 { $null -ne (Ctrl "task-dlg-file-remove-0") })
    ExpectTrue "file remove button rendered after adding file" ($null -ne (Ctrl "task-dlg-file-remove-0")) "missing task-dlg-file-remove-0"
    Click (Ctrl "task-dlg-file-remove-0")
    [void](WaitUntil "first file row removed" 2000 { $null -eq (Ctrl "task-dlg-file-remove-0") })
    ExpectTrue "file remove button gone after removal" ($null -eq (Ctrl "task-dlg-file-remove-0")) "task-dlg-file-remove-0 still present"
    Click (Ctrl "task-dlg-apply-this")

    # 3. Khi đang chạy: nút chạy mờ/khóa, hiện progressbar và nút Dừng.
    Click (Ctrl "task-dlg-run") 80
    $runCtrl = Ctrl "task-dlg-run"
    $progCtrl = Ctrl "task-dlg-progress"
    ExpectTrue "Run button disabled while running" ([bool]$runCtrl.disabled) "disabled=$($runCtrl.disabled)"
    Expect "Run button reports loading state" $runCtrl.value "loading"
    ExpectTrue "progress bar visible while running" ($null -ne $progCtrl) "missing task-dlg-progress"
    Expect "progress bar starts indeterminate" $progCtrl.value "indeterminate"
    ExpectTrue "Stop button replaces Cancel while running" ($null -ne (Ctrl "task-dlg-stop")) "missing task-dlg-stop"

    $reachedHalf = WaitUntil "progress updates to 50%" 3000 {
        $p = Ctrl "task-dlg-progress"
        $null -ne $p -and $p.value -eq "50%"
    }
    ExpectTrue "progress updates to determinate 50%" $reachedHalf ("value=" + (Ctrl "task-dlg-progress").value)

    # 4. Đóng khi đang chạy: hỏi xác nhận hủy (Esc, nút X, bấm ra ngoài khi đang hỏi).
    Key 27
    [void](WaitUntil "cancel confirm appears on Esc" 2000 { $null -ne (Ctrl "task-dlg-cancel-confirm") })
    ExpectTrue "Esc while running stays open" ($null -ne (Ctrl "task-dlg")) "dialog closed without confirmation"
    ExpectTrue "Esc while running shows cancel-confirm prompt" ($null -ne (Ctrl "task-dlg-cancel-confirm")) "missing cancel-confirm"

    Click (Ctrl "task-dlg-confirm-keep")
    [void](WaitUntil "cancel confirm dismisses on keep" 2000 { $null -eq (Ctrl "task-dlg-cancel-confirm") })
    ExpectTrue "keep-running closes confirmation prompt" ($null -eq (Ctrl "task-dlg-cancel-confirm")) "cancel-confirm still present"
    ExpectTrue "keep-running keeps dialog open and running" ($null -ne (Ctrl "task-dlg-progress")) "job stopped unexpectedly"

    Click (Ctrl "task-dlg-close")
    [void](WaitUntil "cancel confirm appears on X" 2000 { $null -ne (Ctrl "task-dlg-cancel-confirm") })
    ExpectTrue "close button while running shows cancel-confirm prompt" ($null -ne (Ctrl "task-dlg-cancel-confirm")) "missing cancel-confirm on X"

    ClickAt 12 12
    Start-Sleep -Milliseconds 150
    ExpectTrue "outside click during cancel-confirm does not close dialog" ($null -ne (Ctrl "task-dlg") -and $null -ne (Ctrl "task-dlg-cancel-confirm")) "dialog or prompt dismissed"

    Click (Ctrl "task-dlg-confirm-stop")
    [void](WaitUntil "stop-and-close closes dialog" 2000 { $null -eq (Ctrl "task-dlg") })
    ExpectTrue "stop-and-close closes dialog" ($null -eq (Ctrl "task-dlg")) "dialog stayed open"
    Expect "focus returns to opener after stop-and-close" (Focused) "task-dialog-open"

    # 5. Chạy xong bình thường: hiện kết quả, nút Chạy bật lại, Esc đóng ngay không hỏi.
    Click (Ctrl "task-dialog-open")
    [void](WaitUntil "reopened dialog" 2000 { $null -ne (Ctrl "task-dlg-run") })
    Click (Ctrl "task-dlg-run") 80
    [void](WaitUntil "finish button visible" 2000 { $null -ne (Ctrl "task-probe-finish") })
    Click (Ctrl "task-probe-finish")
    [void](WaitUntil "result banner visible" 2000 { $null -ne (Ctrl "task-dlg-result") })
    ExpectTrue "progress bar clears on finish" ($null -eq (Ctrl "task-dlg-progress")) "progress still present"
    ExpectTrue "Run button re-enabled on finish" (-not [bool](Ctrl "task-dlg-run").disabled) "run still disabled"
    Expect "result banner shows success tone" (Ctrl "task-dlg-result").value "success"

    Key 27
    [void](WaitUntil "Esc closes cleanly when idle" 2000 { $null -eq (Ctrl "task-dlg") })
    ExpectTrue "Esc closes idle dialog without confirm prompt" ($null -eq (Ctrl "task-dlg") -and $null -eq (Ctrl "task-dlg-cancel-confirm")) "dialog stayed open"
    Expect "focus returns to opener after idle close" (Focused) "task-dialog-open"
}
finally {
    try { Send "quit" | Out-Null } catch {}
    Start-Sleep -Milliseconds 300
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}

Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
