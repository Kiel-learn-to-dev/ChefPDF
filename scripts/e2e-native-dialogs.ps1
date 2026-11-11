<#
.SYNOPSIS
  E2E cho hộp chọn file (TASKS_RUST R2.30, FEATURES A5): hộp "Mở PDF" thật sự hiện khi mở bằng action,
  và khi bị hủy thì không báo lỗi, viewer vẫn đọc được tài liệu.

.DESCRIPTION
  Chạy viewer với CHEF_E2E=1 và CHEF_E2E_CLOSE_DIALOGS=1: app tự đóng hộp thoại sau 800 ms, nên hộp thoại
  chỉ là cửa sổ hiện tạm thời. Script tìm cửa sổ #32770 có tiêu đề "Mở PDF" để chắc nó đã hiện. Kiểm
  chọn tệp thật và thư mục mặc định cần thao tác tay (chưa tự động hóa). Cần `cargo build -p chef-app`
  và PDF mẫu pages1000.pdf (đặt ở %TEMP%\chef-perf).
#>
param([string]$Exe, [string]$Pdf)

$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\apps\native\target\debug\chef-app.exe" }
if (-not $Pdf) { $Pdf = Join-Path $env:TEMP "chef-perf\pages1000.pdf" }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DialogWin {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindow(string cls, string title);
}
"@

Get-Process chef-app -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }

$env:CHEF_E2E = "1"
$env:CHEF_E2E_CLOSE_DIALOGS = "1"
$log = Join-Path $env:TEMP ("chef-dialogs-" + [guid]::NewGuid().ToString("N") + ".txt")
$proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $Pdf + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
$env:CHEF_E2E = $null
$env:CHEF_E2E_CLOSE_DIALOGS = $null
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
function State() { return (Send 'state' | ConvertFrom-Json) }

$script:fails = 0
function ExpectTrue([string]$name, [bool]$cond, [string]$detail) {
    if ($cond) { Write-Output "PASS $name" }
    else { $script:fails++; Write-Output "FAIL $name : $detail" }
}

try {
    Start-Sleep -Milliseconds 800
    ExpectTrue "viewer opened the document" ($null -ne (State).view) "state.view rỗng"

    Send "action openfile" | Out-Null

    # Hộp thoại "Mở PDF" phải hiện trong lúc app chưa đóng nó (app đóng sau 800 ms).
    $seen = $false
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 700) {
        if ([DialogWin]::FindWindow("#32770", "Mở PDF") -ne [IntPtr]::Zero) { $seen = $true; break }
        Start-Sleep -Milliseconds 30
    }
    ExpectTrue "the Mở PDF dialog appears" $seen "không thấy hộp thoại Mở PDF"

    # Sau khi đóng, hộp thoại biến mất và app vẫn trả lời.
    Start-Sleep -Milliseconds 2200
    ExpectTrue "the dialog is closed again" ([DialogWin]::FindWindow("#32770", "Mở PDF") -eq [IntPtr]::Zero) "hộp thoại vẫn còn"
    $s = State
    ExpectTrue "cancel shows no error message" ($null -eq $s.message) ("thông báo: " + $s.message)
    ExpectTrue "the document is still open after cancel" ($null -ne $s.view) "tài liệu bị mất sau khi hủy"
    ExpectTrue "app still answers after cancel" ([bool]$s.visible) "app không trả lời"
}
finally {
    try { Send "quit" | Out-Null } catch {}
    Start-Sleep -Milliseconds 300
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
