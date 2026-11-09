<#
.SYNOPSIS
  E2E cho đọc ban đêm (TASKS_RUST R2.28): bật thì trang đảo màu (nền tối), tắt thì trang trở lại
  nền sáng; trạng thái đọc từ lệnh `state`.

.DESCRIPTION
  Chạy trên pages1000.pdf (trang chữ đen trên nền trắng). Đo tỉ lệ điểm tối trong vùng trang bằng
  ảnh chụp cửa sổ debug. Cần `cargo build -p chef-app`.
#>
param([string]$Exe, [string]$Pdf)

$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\apps\native\target\debug\chef-app.exe" }
if (-not $Pdf) { $Pdf = Join-Path $env:TEMP "chef-perf\pages1000.pdf" }

Get-Process chef-app -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }

$env:CHEF_E2E = "1"
$log = Join-Path $env:TEMP ("chef-night-" + [guid]::NewGuid().ToString("N") + ".txt")
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

# Tỉ lệ điểm tối (<100) trên vùng trang: nền trang sáng thì gần 0, nền tối thì gần 100.
function DarkShare([string]$bmp) {
    $py = Join-Path $PSScriptRoot "..\core\.venv\Scripts\python.exe"
    $code = "import sys; from PIL import Image; im=Image.open(sys.argv[1]).convert('RGB'); w,h=im.size; px=im.load(); d=n=0
for y in range(120,h-10,4):
  for x in range(10,w-10,4):
    n+=1; d+= max(px[x,y])<100
print(round(100*d/n,1))"
    return [double](& $py -c $code $bmp 2>$null)
}

$script:fails = 0
function Expect([string]$name, $actual, $expected) {
    if ($actual -ceq $expected) { Write-Output "PASS $name" }
    else { $script:fails++; Write-Output "FAIL $name : got [$actual] want [$expected]" }
}

try {
    Start-Sleep -Milliseconds 800
    Expect "starts in day mode" ((Send 'state' | ConvertFrom-Json).view.night) $false
    $dayPath = (Send ("screenshot " + (Join-Path $env:TEMP "night-day.bmp")) | ConvertFrom-Json).path
    $day = DarkShare $dayPath
    Send "action togglenight" | Out-Null
    Start-Sleep -Milliseconds 800
    Expect "togglenight turns night on" ((Send 'state' | ConvertFrom-Json).view.night) $true
    $nightPath = (Send ("screenshot " + (Join-Path $env:TEMP "night-on.bmp")) | ConvertFrom-Json).path
    $night = DarkShare $nightPath
    Write-Output ("dark share day=$day night=$night")
    Expect "page turns dark at night" ($night -gt 80) $true
    Expect "page is light by day" ($day -lt 20) $true

    Send "action togglenight" | Out-Null
    Start-Sleep -Milliseconds 800
    Expect "togglenight turns night off" ((Send 'state' | ConvertFrom-Json).view.night) $false
}
finally {
    Send "quit" | Out-Null
    Start-Sleep -Milliseconds 300
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
