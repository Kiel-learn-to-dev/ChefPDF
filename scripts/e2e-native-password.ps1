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
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$work = Join-Path $env:TEMP ("chef-native-password-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $work | Out-Null
if (-not $Pdf) { $Pdf = Join-Path $work "locked.pdf" }
$secret = "thu123"
$script:passwordRunArtifacts = [System.Collections.Generic.List[object]]::new()

if (-not (Test-Path $Pdf)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Pdf) | Out-Null
    Push-Location (Join-Path $repo "core")
    try {
        & uv run --no-project python (Join-Path $PSScriptRoot "gen-native-password-fixture.py") $Pdf | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "password PDF fixture generation failed with exit code $LASTEXITCODE" }
    } finally { Pop-Location }
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
function File-Contains([string]$Path, [string]$Value) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    return [System.Text.Encoding]::Latin1.GetString($bytes).Contains($Value)
}

function Run-App([string]$Path, [scriptblock]$Steps) {
    $oldE2E = $env:CHEF_E2E
    $oldUserData = $env:CHEF_USER_DATA_DIR
    $env:CHEF_E2E = "1"
    $runId = [guid]::NewGuid().ToString("N")
    $userData = Join-Path $work ("userdata-" + $runId)
    New-Item -ItemType Directory -Force $userData | Out-Null
    $env:CHEF_USER_DATA_DIR = $userData
    $log = Join-Path $work ("run-" + $runId + ".stderr.txt")
    $proc = $null
    try {
        $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $Path + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
    }
    finally {
        $env:CHEF_E2E = $oldE2E
        $env:CHEF_USER_DATA_DIR = $oldUserData
    }
    $ctx = $null
    try {
        $deadline = (Get-Date).AddSeconds(45)
        while ((Get-Date) -lt $deadline) {
            if ($proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)) before its debug pipe was ready. Log: $log" }
            if ((Test-Path -LiteralPath $log) -and (Get-Content -LiteralPath $log -Raw) -match 'CHEF_DEBUG_TOKEN=') { break }
            Start-Sleep -Milliseconds 200
        }
        if (-not (Test-Path -LiteralPath $log)) { throw "chef-app did not create its stderr log: $log" }
        $text = Get-Content -LiteralPath $log -Raw
        $pipe = [regex]::Match($text, 'chef-native-\d+').Value
        $tok = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
        if (-not $pipe -or -not $tok) { throw "debug pipe/token did not become ready. Log: $log" }
        $ctx = @{ pipe = $pipe; tok = $tok; log = $log; proc = $proc }
        $ctx.userData = $userData
        $script:passwordRunArtifacts.Add($ctx)
        & $Steps $ctx
    }
    finally {
        $env:CHEF_E2E = $oldE2E
        $env:CHEF_USER_DATA_DIR = $oldUserData
        if ($ctx) { try { Send $ctx "quit" | Out-Null } catch {} }
        if ($proc -and -not $proc.HasExited -and -not $proc.WaitForExit(5000)) { Stop-Process -Id $proc.Id -Force }
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
    ExpectTrue "password text is masked and copy is disabled" ($s.password.masked -eq $true -and $s.password.copyAllowed -eq $false) "ô mật khẩu chưa bật secure mode"
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
    ExpectTrue "wrong password input buffer is cleared" ($s.password.bufferEmpty -eq $true) "buffer mật khẩu sai chưa xóa"

    Send $ctx "char $secret" | Out-Null
    Start-Sleep -Milliseconds 150
    Send $ctx "key 13" | Out-Null
    Start-Sleep -Milliseconds 800
    $s = State $ctx
    ExpectTrue "right password opens the document" ($null -ne $s.view) "không mở được tài liệu"
    ExpectTrue "dialog closes after opening" ($s.password.open -eq $false) "hộp thoại vẫn mở"
    ExpectTrue "source password is retained only for the open tab" ($s.password.sourceHeld -eq $true) "mật khẩu nguồn chưa được giữ"
    Send $ctx "action closetab" | Out-Null
    Start-Sleep -Milliseconds 500
    $s = State $ctx
    ExpectTrue "closing the tab releases the source password" ($s.password.sourceHeld -eq $false) "mật khẩu nguồn còn sau khi đóng thẻ"
    ExpectTrue "closing the tab leaves the password buffer empty" ($s.password.bufferEmpty -eq $true) "buffer mật khẩu còn sau khi đóng thẻ"
}
$stderrLogs = @($script:passwordRunArtifacts | Where-Object { Test-Path -LiteralPath $_.log })
ExpectTrue "each password run has an isolated stderr log" ($stderrLogs.Count -eq 3) "không đủ ba log riêng trong $work"
$stderrLeaks = @($stderrLogs | Where-Object { File-Contains -Path $_.log -Value $secret })
ExpectTrue "the password never reaches stderr logs" ($stderrLeaks.Count -eq 0) "mật khẩu xuất hiện trong stderr log"
$userDataFiles = @(
    foreach ($artifact in $script:passwordRunArtifacts) {
        if (Test-Path -LiteralPath $artifact.userData) {
            Get-ChildItem -LiteralPath $artifact.userData -File -Recurse -ErrorAction SilentlyContinue
        }
    }
)
ExpectTrue "app log directories exist for every password run" (@($script:passwordRunArtifacts | Where-Object { Test-Path -LiteralPath (Join-Path $_.userData 'logs') }).Count -eq 3) "không đủ thư mục log trong $work"
$appLogFiles = @(
    foreach ($artifact in $script:passwordRunArtifacts) {
        $logDirectory = Join-Path $artifact.userData 'logs'
        if (Test-Path -LiteralPath $logDirectory) {
            Get-ChildItem -LiteralPath $logDirectory -File -Recurse -ErrorAction SilentlyContinue
        }
    }
)
ExpectTrue "app log files exist for the password runs" ($appLogFiles.Count -ge 3) "không đủ log file trong $work"
$diskLeaks = @($userDataFiles + $appLogFiles | Where-Object { File-Contains -Path $_.FullName -Value $secret })
ExpectTrue "the password is absent from all app data files" ($diskLeaks.Count -eq 0) "mật khẩu xuất hiện trong dữ liệu app"

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

# ---- Lượt 3: đóng tab khi hộp mật khẩu còn chứa nội dung ----
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
    Send $ctx "char $secret" | Out-Null
    Start-Sleep -Milliseconds 200
    ExpectTrue "password buffer contains entered text before tab close" ((State $ctx).password.bufferEmpty -eq $false) "buffer không nhận ký tự"
    Send $ctx "action closetab" | Out-Null
    Start-Sleep -Milliseconds 500
    $s = State $ctx
    ExpectTrue "closing a tab closes its password prompt" ($s.password.open -eq $false) "hộp mật khẩu vẫn mở sau khi đóng thẻ"
    ExpectTrue "closing a tab zeroizes its live input buffer" ($s.password.bufferEmpty -eq $true) "buffer chưa được xóa khi đóng thẻ"
}

Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
