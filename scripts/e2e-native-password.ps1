<#
.SYNOPSIS
  E2E cho file có mật khẩu (TASKS_RUST R2.26, FEATURES B6): mở file khóa thì hỏi mật khẩu; nhập sai
  thì báo lại và giữ hộp thoại; nhập đúng thì mở tài liệu. Mật khẩu không xuất hiện trong nhật ký.
  Esc đóng hộp mà không mở gì.

.DESCRIPTION
  Fixture: %TEMP%\chef-perf\locked.pdf, mật khẩu người dùng "thu123". Tạo bằng
  scripts/gen-native-password-fixture.py (uv run --no-project python). Chuỗi gõ đi qua `char`, phím đi
  qua `key`. Cần `cargo build -p chef-app`.
#>
param([string]$Exe, [string]$Pdf)

$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\apps\native\target\debug\chef-app.exe" }
if (-not $Pdf) { $Pdf = Join-Path $env:TEMP "chef-perf\locked.pdf" }
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$secret = "thu123"

if (-not (Test-Path $Pdf)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Pdf) | Out-Null
    Push-Location (Join-Path $repo "core")
    & uv run --no-project python (Join-Path $PSScriptRoot "gen-native-password-fixture.py") $Pdf | Out-Null
    Pop-Location
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

function Run-App([string]$Path, [scriptblock]$Steps) {
    Get-Process chef-app -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }
    $env:CHEF_E2E = "1"
    $log = Join-Path $env:TEMP ("chef-password-" + [guid]::NewGuid().ToString("N") + ".txt")
    $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $Path + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
    $env:CHEF_E2E = $null
    Start-Sleep -Seconds 5
    $text = Get-Content $log -Raw
    $pipe = [regex]::Match($text, 'chef-native-\d+').Value
    $tok = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    $ctx = @{ pipe = $pipe; tok = $tok; log = $log; proc = $proc }
    try {
        & $Steps $ctx
    }
    finally {
        try { Send $ctx "quit" | Out-Null } catch {}
        Start-Sleep -Milliseconds 300
        if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    }
}

function Send($ctx, [string]$cmd) {
    $c = New-Object System.IO.Pipes.NamedPipeClientStream(".", $ctx.pipe, [System.IO.Pipes.PipeDirection]::InOut)
    $c.Connect(3000)
    $w = New-Object System.IO.StreamWriter($c, [System.Text.UTF8Encoding]::new($false))
    $w.AutoFlush = $true; $w.NewLine = "`n"
    $r = New-Object System.IO.StreamReader($c, [System.Text.UTF8Encoding]::new($false))
    $w.WriteLine("$($ctx.tok) $cmd")
    $reply = $r.ReadLine()
    $c.Dispose()
    return $reply
}
function State($ctx) { return (Send $ctx 'state' | ConvertFrom-Json) }

# ---- Lượt 1: nhập sai, rồi nhập đúng ----
Run-App $Pdf {
    param($ctx)
    Start-Sleep -Milliseconds 500
    $s = State $ctx
    ExpectTrue "locked file asks for a password" ($s.password.open -eq $true) "không hỏi mật khẩu"
    Expect "no wrong-password message on first ask" ([bool]$s.password.wrong) $false
    ExpectTrue "no document is open yet" ($null -eq $s.view) "đã mở tài liệu khi chưa có mật khẩu"
    # Cửa sổ E2E không active nên tiêu điểm đặt lúc mở không giữ: bấm vào ô như người dùng sẽ làm.
    $st = State $ctx
    $inp = $st.controls.controls | Where-Object { $_.id -eq "password-input" }
    $sc = [double]$st.controls.scale
    $cx = [int](($inp.bounds[0] + $inp.bounds[2] / 2) * $sc); $cy = [int](($inp.bounds[1] + $inp.bounds[3] / 2) * $sc)
    Send $ctx "mouse move $cx $cy" | Out-Null; Start-Sleep -Milliseconds 80
    Send $ctx "mouse down $cx $cy" | Out-Null; Start-Sleep -Milliseconds 60
    Send $ctx "mouse up $cx $cy" | Out-Null; Start-Sleep -Milliseconds 200
    Expect "clicking the field gives it focus" ((State $ctx).controls.controls | Where-Object { $_.focused } | Select-Object -First 1).id "password-input"

    Send $ctx "char sai123" | Out-Null
    Start-Sleep -Milliseconds 150
    Send $ctx "key 13" | Out-Null
    Start-Sleep -Milliseconds 500
    $s = State $ctx
    ExpectTrue "wrong password keeps the dialog" ($s.password.open -eq $true) "hộp thoại đóng sau mật khẩu sai"
    ExpectTrue "wrong password is reported" ($s.password.wrong -eq $true) "không báo mật khẩu sai"
    ExpectTrue "still no document after a wrong password" ($null -eq $s.view) "mở tài liệu với mật khẩu sai"

    Send $ctx "char $secret" | Out-Null
    Start-Sleep -Milliseconds 150
    Send $ctx "key 13" | Out-Null
    Start-Sleep -Milliseconds 800
    $s = State $ctx
    ExpectTrue "right password opens the document" ($null -ne $s.view) "không mở được tài liệu"
    ExpectTrue "dialog closes after opening" ($s.password.open -eq $false) "hộp thoại vẫn mở"
}
$logText = Get-ChildItem (Join-Path $env:TEMP "chef-password-*.txt") | Sort-Object LastWriteTime | Select-Object -Last 1 | Get-Content -Raw
ExpectTrue "the password never reaches the log" (-not $logText.Contains($secret)) "mật khẩu xuất hiện trong nhật ký"
# Nhật ký thật của các lượt chạy (userData thử nghiệm): không được chứa mật khẩu.
$logFiles = Get-ChildItem -Path $env:TEMP -Directory -Filter "chef-e2e-userdata-*" -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ChildItem -Path (Join-Path $_.FullName "logs") -Filter "chef-native.log*" -ErrorAction SilentlyContinue }
ExpectTrue "app log files exist for the password runs" ($logFiles.Count -gt 0) "không có file nhật ký"
$leaked = $logFiles | Where-Object { (Get-Content $_.FullName -Raw).Contains($secret) }
ExpectTrue "no app log file contains the password" ($leaked.Count -eq 0) "nhật ký có mật khẩu"

# ---- Lượt 2: Esc đóng hộp mà không mở gì ----
Run-App $Pdf {
    param($ctx)
    Start-Sleep -Milliseconds 500
    $st = State $ctx
    $inp = $st.controls.controls | Where-Object { $_.id -eq "password-input" }
    $sc = [double]$st.controls.scale
    $cx = [int](($inp.bounds[0] + $inp.bounds[2] / 2) * $sc); $cy = [int](($inp.bounds[1] + $inp.bounds[3] / 2) * $sc)
    Send $ctx "mouse move $cx $cy" | Out-Null; Start-Sleep -Milliseconds 80
    Send $ctx "mouse down $cx $cy" | Out-Null; Start-Sleep -Milliseconds 60
    Send $ctx "mouse up $cx $cy" | Out-Null; Start-Sleep -Milliseconds 200
    Send $ctx "key 27" | Out-Null
    Start-Sleep -Milliseconds 400
    $s = State $ctx
    ExpectTrue "Esc closes the password dialog" ($s.password.open -eq $false) "hộp thoại vẫn mở"
    ExpectTrue "Esc opens no document" ($null -eq $s.view) "có tài liệu sau Esc"
    ExpectTrue "Esc reports no error" ($null -eq $s.message) ("thông báo: " + $s.message)
}

Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
