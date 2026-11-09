<#
.SYNOPSIS
  E2E cho khung nhìn viewer (TASKS_RUST R2.19, R2.21): PageDown và PageUp đi đúng một trang,
  zoom bằng Ctrl+= và Ctrl+−, zoom giữ điểm ở giữa vùng nhìn, Ctrl+0 về vừa chiều rộng.

.DESCRIPTION
  Điều khiển qua kênh debug. `action nextpage|prevpage|zoomin|zoomout|zoomreset` đi đúng đường
  keymap của viewer. Trạng thái khung nhìn đọc từ `state` (mục view). Cần `cargo build -p chef-app`.
  Trang mẫu pages1000.pdf là A4 (841,9 pt cao), mỗi trang cách nhau 16 px logic.
#>
param([string]$Exe, [string]$Pdf)

$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\apps\native\target\debug\chef-app.exe" }
if (-not $Pdf) { $Pdf = Join-Path $env:TEMP "chef-perf\pages1000.pdf" }

Get-Process chef-app -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }

$env:CHEF_E2E = "1"
$log = Join-Path $env:TEMP ("chef-view-" + [guid]::NewGuid().ToString("N") + ".txt")
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
function View() { return ((Send 'state') | ConvertFrom-Json).view }

$script:fails = 0
function Expect([string]$name, $actual, $expected) {
    if ($actual -ceq $expected) { Write-Output "PASS $name" }
    else { $script:fails++; Write-Output "FAIL $name : got [$actual] want [$expected]" }
}
function Near([string]$name, [double]$actual, [double]$expected, [double]$tol) {
    if ([math]::Abs($actual - $expected) -le $tol) { Write-Output ("PASS $name (" + [math]::Round($actual, 3) + ")") }
    else { $script:fails++; Write-Output "FAIL $name : got $actual want $expected +- $tol" }
}

try {
    Start-Sleep -Milliseconds 800
    $v0 = View
    Expect "starts at the top, fit to width" ("$($v0.scrollY)|$($v0.firstPage)|$($v0.fitWidth)") "0|0|True"
    $z0 = [double]$v0.zoom
    $pageStep = 841.9 * $z0 + 16

    # 1. PageDown đi đúng một trang, PageUp về lại.
    Send "action nextpage" | Out-Null
    Start-Sleep -Milliseconds 200
    $v1 = View
    Expect "PageDown shows page 2 first" $v1.firstPage 1
    Near "PageDown lands on the next page top" $v1.scrollY $pageStep 0.6
    Send "action prevpage" | Out-Null
    Start-Sleep -Milliseconds 200
    Expect "PageUp returns to page 1" (View).firstPage 0

    # 2. Zoom vào giữa tài liệu: điểm ở giữa vùng nhìn giữ nguyên trên trang.
    1..5 | ForEach-Object { Send "action nextpage" | Out-Null; Start-Sleep -Milliseconds 80 }
    Start-Sleep -Milliseconds 200
    $before = View
    $anchorBefore = ([double]$before.scrollY + [double]$before.viewportH / 2) / [double]$before.zoom
    Send "action zoomin" | Out-Null
    Start-Sleep -Milliseconds 300
    $after = View
    Near "Ctrl+= zooms in by one step" ([double]$after.zoom) ([double]$before.zoom * 1.25) 0.001
    Expect "zooming turns off fit-to-width" $after.fitWidth $false
    $anchorAfter = ([double]$after.scrollY + [double]$after.viewportH / 2) / [double]$after.zoom
    Near "zoom keeps the centre point of the view" $anchorAfter $anchorBefore 0.5

    # 3. Ctrl+− về lại, Ctrl+0 về vừa chiều rộng (zoom ban đầu).
    Send "action zoomout" | Out-Null
    Start-Sleep -Milliseconds 300
    Near "Ctrl+− zooms back out" ([double](View).zoom) $z0 0.001
    Send "action zoomreset" | Out-Null
    Start-Sleep -Milliseconds 300
    $r = View
    Near "Ctrl+0 returns to fit width" ([double]$r.zoom) $z0 0.001
    Expect "fit-to-width is on again" $r.fitWidth $true

    $shot = Join-Path $env:TEMP "view-final.bmp"
    Write-Output ("shot: " + (Send ("screenshot " + $shot)))
}
finally {
    Send "quit" | Out-Null
    Start-Sleep -Milliseconds 300
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
