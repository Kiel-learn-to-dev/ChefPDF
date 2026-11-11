<#
.SYNOPSIS
  E2E cho hộp thoại Cài đặt (TASKS_RUST R2.14, BLUEPRINT_RUST §7.1): Ctrl+, mở hộp thoại, đổi giao
  diện, ngôn ngữ và thư mục lưu mặc định (ghi ngay vào settings.json), Esc đóng; khởi động lại vẫn giữ
  cài đặt; file hỏng không bị ghi đè.

.DESCRIPTION
  Mỗi lượt chạy có thư mục userData riêng qua CHEF_USER_DATA_DIR, nên không đụng cài đặt thật.
  Chuột đi qua `mouse down|up x y` (tọa độ vật lý), tọa độ lấy từ `state.controls` (bounds × scale).
  Cần `cargo build -p chef-app`.
#>
param([string]$Exe)

$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\apps\native\target\debug\chef-app.exe" }

Get-Process chef-app -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }

$dataDir = Join-Path $env:TEMP ("chef-settings-e2e-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $dataDir | Out-Null
$settingsFile = Join-Path $dataDir "settings.json"

$script:fails = 0
$script:pipe = ""
$script:tok = ""
$script:proc = $null

function Start-App {
    $env:CHEF_E2E = "1"
    $env:CHEF_USER_DATA_DIR = $dataDir
    $log = Join-Path $env:TEMP ("chef-settings-" + [guid]::NewGuid().ToString("N") + ".txt")
    $script:proc = Start-Process -FilePath $Exe -PassThru -RedirectStandardError $log -WindowStyle Hidden
    $env:CHEF_E2E = $null
    $env:CHEF_USER_DATA_DIR = $null
    Start-Sleep -Seconds 3
    $text = Get-Content $log -Raw
    $script:pipe = [regex]::Match($text, 'chef-native-\d+').Value
    $script:tok = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    Start-Sleep -Milliseconds 500
}

function Stop-App {
    try { Send "quit" | Out-Null } catch {}
    Start-Sleep -Milliseconds 400
    if ($script:proc -and -not $script:proc.HasExited) { Stop-Process -Id $script:proc.Id -Force }
}

function Send([string]$cmd) {
    $c = New-Object System.IO.Pipes.NamedPipeClientStream(".", $script:pipe, [System.IO.Pipes.PipeDirection]::InOut)
    $c.Connect(3000)
    $w = New-Object System.IO.StreamWriter($c, [System.Text.UTF8Encoding]::new($false))
    $w.AutoFlush = $true; $w.NewLine = "`n"
    $r = New-Object System.IO.StreamReader($c, [System.Text.UTF8Encoding]::new($false))
    $w.WriteLine("$($script:tok) $cmd")
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
function ClickCtrl($control) {
    $s = [double](State).controls.scale
    $x = [int](($control.bounds[0] + $control.bounds[2] / 2) * $s)
    $y = [int](($control.bounds[1] + $control.bounds[3] / 2) * $s)
    Send "mouse move $x $y" | Out-Null; Start-Sleep -Milliseconds 80
    Send "mouse down $x $y" | Out-Null; Start-Sleep -Milliseconds 60
    Send "mouse up $x $y" | Out-Null; Start-Sleep -Milliseconds 250
}
function ReadFile() {
    if (-not (Test-Path $settingsFile)) { return $null }
    return (Get-Content $settingsFile -Raw | ConvertFrom-Json)
}

function Expect([string]$name, $actual, $expected) {
    if ($actual -ceq $expected) { Write-Output "PASS $name" }
    else { $script:fails++; Write-Output "FAIL $name : got [$actual] want [$expected]" }
}
function ExpectTrue([string]$name, [bool]$cond, [string]$detail) {
    if ($cond) { Write-Output "PASS $name" }
    else { $script:fails++; Write-Output "FAIL $name : $detail" }
}

try {
    # ---- Lượt 1: mở, đổi giao diện, ngôn ngữ, thư mục; đóng bằng Esc ----
    Start-App
    Send "action opensettings" | Out-Null
    Start-Sleep -Milliseconds 400
    ExpectTrue "Ctrl+, opens the settings dialog" ($null -ne (Ctrl "settings")) "không thấy hộp thoại"
    Expect "dialog title is the Vietnamese one" (Ctrl "settings").name "Cài đặt"
    Expect "focus starts on the selected theme (system)" (Focused) "settings-theme-0"
    Expect "state reports the default theme" (State).settings.theme "system"

    ClickCtrl (Ctrl "settings-theme-2")
    Start-Sleep -Milliseconds 200
    Expect "choosing Dark changes the theme at once" (State).settings.theme "dark"
    $f = ReadFile
    ExpectTrue "theme is written to settings.json" ($null -ne $f -and $f.theme -eq "dark") "file chưa có theme dark"

    ClickCtrl (Ctrl "settings-language")
    Start-Sleep -Milliseconds 200
    ExpectTrue "language select opens its list" ($null -ne (Ctrl "settings-language-menu")) "không thấy danh sách ngôn ngữ"
    ClickCtrl (Ctrl "settings-language-opt-1")
    Start-Sleep -Milliseconds 300
    Expect "choosing English changes the language at once" (State).settings.language "en"
    Expect "dialog title follows the language" (Ctrl "settings").name "Settings"
    $f = ReadFile
    ExpectTrue "language is written to settings.json" ($null -ne $f -and $f.language -eq "en") "file chưa có language en"

    ClickCtrl (Ctrl "settings-save-dir")
    Start-Sleep -Milliseconds 150
    Send "char D:\Out" | Out-Null
    Start-Sleep -Milliseconds 150
    Key 13
    Start-Sleep -Milliseconds 200
    Expect "Enter in the folder field stores the folder" (State).settings.defaultSaveDir "D:\Out"
    $f = ReadFile
    ExpectTrue "folder is written to settings.json" ($null -ne $f -and $f.defaultSaveDir -eq "D:\Out") "file không có thư mục"

    Key 27
    Start-Sleep -Milliseconds 300
    ExpectTrue "Esc closes the dialog" ($null -eq (Ctrl "settings")) "hộp thoại vẫn mở"
    ExpectTrue "state says the dialog is closed" (-not (State).settings.open) "state vẫn báo đang mở"

    Stop-App

    # ---- Lượt 2: khởi động lại, cài đặt còn nguyên ----
    Start-App
    $s = (State).settings
    Expect "theme survives a restart" $s.theme "dark"
    Expect "language survives a restart" $s.language "en"
    Expect "folder survives a restart" $s.defaultSaveDir "D:\Out"
    Stop-App

    # ---- Lượt 3: file hỏng không bị ghi đè ----
    $corrupt = "{ hỏng, không phải JSON"
    Set-Content -Path $settingsFile -Value $corrupt -Encoding UTF8 -NoNewline
    Start-App
    Send "action opensettings" | Out-Null
    Start-Sleep -Milliseconds 400
    ExpectTrue "dialog shows the read error" ($null -ne (Ctrl "settings")) "không mở được hộp thoại"
    ClickCtrl (Ctrl "settings-theme-1")
    Start-Sleep -Milliseconds 200
    Expect "change still applies in this session" (State).settings.theme "light"
    $after = Get-Content $settingsFile -Raw
    Expect "corrupt settings.json is not overwritten" $after $corrupt
    Stop-App
}
finally {
    Stop-App
    Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
}
Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
