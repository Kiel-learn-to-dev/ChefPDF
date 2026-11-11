<#
.SYNOPSIS
  E2E cho hộp thoại Thuộc tính tài liệu (TASKS_RUST R2.27, FEATURES B7): Ctrl+D (action) mở hộp thoại,
  và các số liệu khớp với pypdfium2 đọc cùng một file (phiên bản, số trang, khổ trang, metadata).

.DESCRIPTION
  Fixture: scripts/gen-native-props-fixture.py (uv run --no-project python). Script này đọc giá trị gốc
  bằng pypdfium2 rồi so với `state.properties` của viewer. Khác biệt có chủ đích: ngày PDF giữ giờ ghi
  trong file (không đổi múi giờ), nên ngày hiển thị là dd/mm/yyyy hh:mm theo chữ số trong file.
  Cần `cargo build -p chef-app`, uv và pypdfium2/pikepdf (lõi).
#>
param([string]$Exe, [string]$Pdf)

$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\apps\native\target\debug\chef-app.exe" }
if (-not $Pdf) { $Pdf = Join-Path $env:TEMP "chef-perf\meta.pdf" }
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")

if (-not (Test-Path $Pdf)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Pdf) | Out-Null
    Push-Location (Join-Path $repo "core")
    & uv run --no-project python (Join-Path $PSScriptRoot "gen-native-props-fixture.py") $Pdf | Out-Null
    Pop-Location
}

# Giá trị gốc từ pypdfium2 (cùng file).
Push-Location (Join-Path $repo "core")
$refJson = & uv run --no-project python -c @"
import json, sys, pypdfium2 as p
d = p.PdfDocument(sys.argv[1])
keys = ['Title','Author','Subject','Keywords','Creator','Producer','CreationDate','ModDate']
out = {'version': str(d.get_version()/10), 'pageCount': len(d), 'w': d[0].get_size()[0], 'h': d[0].get_size()[1],
       'meta': {k: (d.get_metadata_value(k) or '') for k in keys}}
print(json.dumps(out, ensure_ascii=False))
"@ $Pdf
$ref = $refJson | ConvertFrom-Json

Get-Process chef-app -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }

$env:CHEF_E2E = "1"
$log = Join-Path $env:TEMP ("chef-props-" + [guid]::NewGuid().ToString("N") + ".txt")
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
function State() { return (Send 'state' | ConvertFrom-Json) }

$script:fails = 0
function Expect([string]$name, $actual, $expected) {
    if ($actual -ceq $expected) { Write-Output "PASS $name" }
    else { $script:fails++; Write-Output "FAIL $name : got [$actual] want [$expected]" }
}
function ExpectTrue([string]$name, [bool]$cond, [string]$detail) {
    if ($cond) { Write-Output "PASS $name" }
    else { $script:fails++; Write-Output "FAIL $name : $detail" }
}

try {
    Start-Sleep -Milliseconds 800
    ExpectTrue "properties dialog is closed before Ctrl+D" ($null -eq (State).properties) "đã mở từ đầu"

    Send "action openproperties" | Out-Null
    Start-Sleep -Milliseconds 400
    $p = (State).properties
    ExpectTrue "Ctrl+D opens the properties dialog" ($null -ne $p) "state.properties rỗng"
    if ($p) {
        Expect "file name" $p.fileName (Split-Path $Pdf -Leaf)
        Expect "file size matches the file" ([long]$p.fileSize) ((Get-Item $Pdf).Length)
        Expect "PDF version matches pypdfium2" $p.version "1.7"
        Expect "page count matches pypdfium2" ([int]$p.pageCount) ([int]$ref.pageCount)
        Expect "current page is 1" ([int]$p.page) 1
        Expect "first page size is A4 in mm" $p.pageSize "210 × 297 mm (A4)"
        Expect "Title matches" $p.metadata.Title $ref.meta.Title
        Expect "Author matches" $p.metadata.Author $ref.meta.Author
        Expect "Subject matches" $p.metadata.Subject $ref.meta.Subject
        Expect "Keywords matches" $p.metadata.Keywords $ref.meta.Keywords
        Expect "Creator matches" $p.metadata.Creator $ref.meta.Creator
        Expect "Producer matches" $p.metadata.Producer $ref.meta.Producer
        Expect "Creation date raw value matches pypdfium2" $p.metadata.CreationDate $ref.meta.CreationDate
        Expect "creation date shown day/month/year" $p.shown.CreationDate "02/01/2026 03:04"
        Expect "modification date raw value matches pypdfium2" $p.metadata.ModDate $ref.meta.ModDate
        Expect "modification date shown day/month/year" $p.shown.ModDate "15/03/2026 10:11"
    }
    $dlg = Send 'state' | ConvertFrom-Json
    ExpectTrue "dialog is registered for accessibility" ($null -ne ($dlg.controls.controls | Where-Object { $_.id -eq "properties" })) "không có dlg properties"

    # Ảnh để xem bằng mắt (MAN-5).
    $shot = Join-Path $env:TEMP "properties-open.bmp"
    Write-Output ("shot: " + (Send ("screenshot " + $shot)))

    # Esc đóng hộp thoại.
    Send "key 27" | Out-Null
    Start-Sleep -Milliseconds 300
    ExpectTrue "Esc closes the properties dialog" ($null -eq (State).properties) "hộp thoại vẫn mở sau Esc"
}
finally {
    try { Send "quit" | Out-Null } catch {}
    Start-Sleep -Milliseconds 300
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
