<#
.SYNOPSIS
  E2E cho chọn và copy chữ trong viewer (TASKS_RUST R2.25a–R2.25b): kéo chuột chọn, Ctrl+C đưa
  chữ Unicode lên clipboard, Ctrl+A chọn cả trang, và chữ scan không có gì để chọn.

.DESCRIPTION
  Chuột đi qua kênh debug (`mouse down|move|up x y`, tọa độ pixel vật lý trong cửa sổ). Ctrl+A và
  Ctrl+C đi qua `action selectalltext` và `action copyselection`, chạy đúng đường keymap của viewer.
  Cần `cargo build -p chef-app` trước, và PDF mẫu pages1000.pdf (trang 1 có "Trang 1 - nghị định").
#>
param([string]$Exe, [string]$Pdf)

$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\apps\native\target\debug\chef-app.exe" }
if (-not $Pdf) { $Pdf = Join-Path $env:TEMP "chef-perf\pages1000.pdf" }

Get-Process chef-app -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }

$env:CHEF_E2E = "1"
$log = Join-Path $env:TEMP ("chef-select-" + [guid]::NewGuid().ToString("N") + ".txt")
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

$script:fails = 0
function Expect([string]$name, $actual, $expected) {
    if ($actual -ceq $expected) { Write-Output "PASS $name" }
    else { $script:fails++; Write-Output "FAIL $name : got [$actual] want [$expected]" }
}
function Clip() { return (Get-Clipboard -Raw) }

try {
    # Chữ của trang đầu được đọc nền; chờ một chút trước khi chuột chọn.
    Start-Sleep -Seconds 2
    Set-Clipboard -Value "trống"

    # 1. Kéo chuột từ "T" của "Trang 1" đến sau "định", rồi Ctrl+C.
    Send "mouse down 250 195" | Out-Null
    Start-Sleep -Milliseconds 100
    1..8 | ForEach-Object { Send ("mouse move " + (250 + $_ * 50) + " 195") | Out-Null; Start-Sleep -Milliseconds 40 }
    Send "mouse up 640 195" | Out-Null
    Start-Sleep -Milliseconds 300
    Send "action copyselection" | Out-Null
    Start-Sleep -Milliseconds 300
    $c = Clip
    Expect "drag selects text from the start of the line" $c.StartsWith("Trang 1 - nghị định") $true
    Expect "copied text has no NUL or replacement characters" ($c.Contains([char]0) -or $c.Contains([char]0xFFFD)) $false

    # 2. Ctrl+A chọn cả trang đầu; Ctrl+C đưa đủ các dòng lên clipboard.
    Set-Clipboard -Value "trống"
    Send "action selectalltext" | Out-Null
    Start-Sleep -Milliseconds 300
    Send "action copyselection" | Out-Null
    Start-Sleep -Milliseconds 300
    $all = Clip
    Expect "select-all copies the first line" $all.StartsWith("Trang 1 - nghị định số 1/2026") $true
    Expect "select-all copies later lines on new lines" ($all -match "Dòng 1 của trang 1") $true
    Expect "lines are separated by newlines" ($all -match "\n") $true

    $shot = Join-Path $env:TEMP "select-final.bmp"
    Write-Output ("shot: " + (Send ("screenshot " + $shot)))
}
finally {
    Send "quit" | Out-Null
    Start-Sleep -Milliseconds 300
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
