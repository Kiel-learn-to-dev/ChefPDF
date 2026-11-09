<#
.SYNOPSIS
  E2E cho tìm trong tài liệu (TASKS_RUST R2.23–R2.24): tìm không dấu, quét cả 1000 trang, Enter và Shift+Enter, vòng lại, Esc.

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
    Expect "start: no search" (Input).text ""

    # 1. Gõ không dấu; quét 1000 trang xong thì có khớp, khớp có vị trí.
    $t0 = Get-Date
    Send "char nghi dinh" | Out-Null
    $deadline = (Get-Date).AddSeconds(120)
    do {
        Start-Sleep -Milliseconds 250
        $find = (Send 'state' | ConvertFrom-Json).find
    } while ($find.scanning -and (Get-Date) -lt $deadline)
    $secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
    Write-Output "scan finished in $secs s, total=$($find.total)"
    Expect "query kept as typed" $find.query "nghi dinh"
    Expect "scan finished" $find.scanning $false
    Expect "accent-free query finds matches" ($find.total -gt 0) $true
    $total = [int]$find.total
    Expect "no match selected before Enter" ($find.current -eq $null) $true

    # 2. Enter đi tới khớp đầu, rồi khớp kế; Shift+Enter quay lại.
    Send "key 13" | Out-Null
    Start-Sleep -Milliseconds 300
    Expect "Enter selects first match" (Send 'state' | ConvertFrom-Json).find.current 0
    Send "key 13" | Out-Null
    Start-Sleep -Milliseconds 300
    Expect "Enter again selects second match" (Send 'state' | ConvertFrom-Json).find.current 1
    Send "action submitback" | Out-Null
    Start-Sleep -Milliseconds 300
    Expect "Shift+Enter goes back" (Send 'state' | ConvertFrom-Json).find.current 0
    Send "action submitback" | Out-Null
    Start-Sleep -Milliseconds 300
    Expect "Shift+Enter from first wraps to last" (Send 'state' | ConvertFrom-Json).find.current ($total - 1)

    # 3. Tìm có dấu cho cùng số khớp.
    Send "action selectall" | Out-Null
    Send "action backspace" | Out-Null
    Start-Sleep -Milliseconds 300
    Expect "cleared query stops search" (Send 'state' | ConvertFrom-Json).find.total 0
    Send "char NGHỊ ĐỊNH" | Out-Null
    $deadline = (Get-Date).AddSeconds(120)
    do {
        Start-Sleep -Milliseconds 250
        $find = (Send 'state' | ConvertFrom-Json).find
    } while ($find.scanning -and (Get-Date) -lt $deadline)
    Expect "accented query gives same total" $find.total $total

    # 4. Ảnh chụp với khớp đang chọn (để xem bằng mắt).
    Send "key 13" | Out-Null
    Start-Sleep -Milliseconds 400
    $shot = Join-Path $env:TEMP "find-final.bmp"
    Write-Output ("shot: " + (Send ("screenshot " + $shot)))

    # 5. Esc xóa cụm tìm và kết quả.
    Send "key 27" | Out-Null
    Start-Sleep -Milliseconds 400
    $s = Send 'state' | ConvertFrom-Json
    Expect "escape clears the field" $s.input.text ""
    Expect "escape clears the results" $s.find.total 0
    Expect "escape clears the query" $s.find.query ""
}
finally {
    Send "quit" | Out-Null
    Start-Sleep -Milliseconds 300
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
