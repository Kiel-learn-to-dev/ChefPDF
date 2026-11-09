<#
.SYNOPSIS
  E2E cho ô nhập một dòng (TASKS_RUST R1.22): gõ, chọn, copy/cut/paste, Home/End, Backspace, gõ nhanh.

.DESCRIPTION
  Mở chef-app debug ngoài màn hình (CHEF_E2E=1) và điều khiển qua kênh debug. Lệnh `action` đưa
  action vào đúng đường keymap, nên Shift+mũi tên và Ctrl+C/X/V được kiểm thật. Trạng thái ô nhập
  đọc từ lệnh `state`. Cần `cargo build -p chef-app` trước.
#>
param([string]$Exe, [string]$Pdf)

$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\apps\native\target\debug\chef-app.exe" }
if (-not $Pdf) { $Pdf = Join-Path $env:TEMP "chef-perf\pages1000.pdf" }

Get-Process chef-app -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }

$env:CHEF_E2E = "1"
$log = Join-Path $env:TEMP ("chef-input-" + [guid]::NewGuid().ToString("N") + ".txt")
$proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $Pdf + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
$env:CHEF_E2E = $null
Start-Sleep -Seconds 5

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
function Input() { return ((Send 'state') | ConvertFrom-Json).input }
function Bytes([string]$s) { return [Text.Encoding]::UTF8.GetByteCount($s) }

$script:fails = 0
function Expect([string]$name, $actual, $expected) {
    if ($actual -ceq $expected) { Write-Output "PASS $name" }
    else { $script:fails++; Write-Output "FAIL $name : got [$actual] want [$expected]" }
}

try {
    Start-Sleep -Milliseconds 400
    Expect "start empty" (Input).text ""

    # 1. Gõ tiếng Việt có dấu (dựng sẵn) qua WM_CHAR.
    $phrase = "Tiếng Việt có dấu"
    Send ("char " + $phrase) | Out-Null
    Start-Sleep -Milliseconds 300
    $in = Input
    Expect "typed text exact" $in.text $phrase
    Expect "caret at end after typing" $in.selStart (Bytes $phrase)
    Expect "caret collapsed" $in.selEnd (Bytes $phrase)

    # 2. Chọn ngược ba chữ cuối (Shift+mũi tên trái qua action selectleft ×3), rồi copy.
    1..3 | ForEach-Object { Send "action selectleft" | Out-Null }
    Start-Sleep -Milliseconds 200
    $in = Input
    Expect "selectleft keeps text" $in.text $phrase
    Expect "selection start" $in.selStart (Bytes "Tiếng Việt có ")
    Expect "selection end" $in.selEnd (Bytes $phrase)
    Send "action copy" | Out-Null
    Start-Sleep -Milliseconds 200
    Expect "copy puts selection on clipboard" (Get-Clipboard -Raw).TrimEnd("`r", "`n") "dấu"

    # 3. Cut vùng chọn: còn "Tiếng Việt có ", con trỏ ở cuối.
    Send "action cut" | Out-Null
    Start-Sleep -Milliseconds 200
    $in = Input
    Expect "cut removes exactly the selection" $in.text "Tiếng Việt có "
    Expect "caret after cut at end" $in.selStart (Bytes "Tiếng Việt có ")

    # 4. Dán clipboard nhiều dòng (\r\n trên Windows): thành một dòng, không có khoảng trắng kép.
    Set-Clipboard -Value "Thanh toán`r`nhóa đơn"
    Start-Sleep -Milliseconds 200
    Send "action paste" | Out-Null
    Start-Sleep -Milliseconds 200
    Expect "paste multi-line becomes one line" (Input).text "Tiếng Việt có Thanh toán hóa đơn"

    # 5. Home, End, chọn tất cả rồi Backspace.
    Send "action home" | Out-Null
    Start-Sleep -Milliseconds 150
    Expect "home moves caret to 0" (Input).selStart 0
    $full = "Tiếng Việt có Thanh toán hóa đơn"
    Send "action end" | Out-Null
    Start-Sleep -Milliseconds 150
    Expect "end moves caret to end" (Input).selStart (Bytes $full)
    Send "action selectall" | Out-Null
    Start-Sleep -Milliseconds 150
    $in = Input
    Expect "select all covers text" ("$($in.selStart)-$($in.selEnd)") ("0-" + (Bytes $full))
    Send "key 8" | Out-Null
    Start-Sleep -Milliseconds 200
    Expect "backspace over selection empties field" (Input).text ""

    # 6. Gõ nhanh nhiều chữ liền nhau: con trỏ không nhảy, nội dung đúng từng ký tự.
    $fast = "ệ ư ơ ă đ ấ ầ ộ ỹ ữ Nghị định 30/2020 — Chef PDF"
    Send ("char " + $fast) | Out-Null
    Start-Sleep -Milliseconds 400
    $in = Input
    Expect "fast typing text exact" $in.text $fast
    Expect "fast typing caret at end" $in.selStart (Bytes $fast)

    # 7. Mũi tên trái rồi Delete: chỉ đụng đúng một ký tự quanh con trỏ.
    Send "key 37" | Out-Null
    Start-Sleep -Milliseconds 150
    Expect "left arrow moves one char back" (Input).selStart (Bytes ($fast.Substring(0, $fast.Length - 1)))
    Send "key 46" | Out-Null
    Start-Sleep -Milliseconds 150
    Expect "delete at caret removes next char" (Input).text ($fast.Substring(0, $fast.Length - 1))

    $shot = Join-Path $env:TEMP "input-final.bmp"
    Write-Output ("shot: " + (Send ("screenshot " + $shot)))
}
finally {
    Send "quit" | Out-Null
    Start-Sleep -Milliseconds 300
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
