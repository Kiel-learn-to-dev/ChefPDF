<#
.SYNOPSIS
  E2E cho đọc ban đêm (TASKS_RUST R2.28): bật thì trang đảo màu (nền tối), tắt thì trang trở lại
  nền sáng; trạng thái đọc từ lệnh `state`.

.DESCRIPTION
  Mặc định tự tạo PDF trắng một trang; có thể truyền PDF riêng. Đo tỉ lệ điểm tối qua ảnh chụp và
  so byte cache giữa ngày/đêm khi cùng tập trang đã render. Chỉ chuẩn bị/kết hợp với chef-app.exe có sẵn.
#>
param([string]$Exe, [string]$Pdf)

$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\apps\native\target\debug\chef-app.exe" }
if (-not (Test-Path -LiteralPath $Exe)) { throw "chef-app.exe not found: $Exe" }
$work = Join-Path $env:TEMP ("chef-native-night-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $work | Out-Null
if (-not $Pdf) {
    $Pdf = Join-Path $work 'night-fixture.pdf'
    Push-Location (Join-Path $PSScriptRoot '..\core')
    try {
        & uv run --no-project python -c 'import pikepdf,sys; p=pikepdf.Pdf.new(); p.add_blank_page(page_size=(612,792)); p.save(sys.argv[1])' $Pdf
        if ($LASTEXITCODE -ne 0) { throw 'night-mode PDF fixture generation failed' }
    } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath $Pdf)) { throw "PDF fixture not found: $Pdf" }

$oldE2E = $env:CHEF_E2E
$oldUserData = $env:CHEF_USER_DATA_DIR
$env:CHEF_E2E = "1"
$env:CHEF_USER_DATA_DIR = Join-Path $work 'userdata'
$log = Join-Path $work 'app.stderr.txt'
$proc = $null
try {
    $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $Pdf + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
}
finally {
    $env:CHEF_E2E = $oldE2E
    $env:CHEF_USER_DATA_DIR = $oldUserData
}
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline -and ((-not (Test-Path -LiteralPath $log)) -or ((Get-Content -LiteralPath $log -Raw) -notmatch 'CHEF_DEBUG_TOKEN='))) {
    if ($proc -and $proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)) before the debug pipe was ready. Log: $log" }
    Start-Sleep -Milliseconds 200
}
if (-not (Test-Path -LiteralPath $log)) {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    throw "app stderr log not created: $log"
}
$text = Get-Content -LiteralPath $log -Raw
$pipe = [regex]::Match($text, 'chef-native-\d+').Value
$tok = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
if (-not $pipe -or -not $tok) {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    throw "debug pipe/token did not become ready. Log: $log"
}

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
function WaitFor([scriptblock]$predicate, [string]$what) {
    $end = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $end) {
        if ($proc -and $proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)) while waiting for $what. Log: $log" }
        if (& $predicate) { return }
        Start-Sleep -Milliseconds 200
    }
    throw "Timed out waiting for $what"
}

# Tỉ lệ điểm tối (<100) trên vùng trang: nền trang sáng thì gần 0, nền tối thì gần 100.
function DarkShare([string]$bmp) {
    $code = "import sys; from PIL import Image; im=Image.open(sys.argv[1]).convert('RGB'); w,h=im.size; px=im.load(); d=n=0
for y in range(120,h-10,4):
  for x in range(10,w-10,4):
    n+=1; d+= max(px[x,y])<100
print(round(100*d/n,1))"
    Push-Location (Join-Path $PSScriptRoot '..\core')
    try {
        $share = & uv run --no-project python -c $code $bmp 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Pillow could not measure the screenshot' }
        return [double]$share
    } finally { Pop-Location }
}

$script:fails = 0
function Expect([string]$name, $actual, $expected) {
    if ($actual -ceq $expected) { Write-Output "PASS $name" }
    else { $script:fails++; Write-Output "FAIL $name : got [$actual] want [$expected]" }
}

try {
    WaitFor { $s = State; $null -ne $s.view -and -not $s.view.night -and $s.pending -eq 0 -and $s.cachedBytes -gt 0 } 'day-mode page cache to settle'
    $dayState = State
    Expect "starts in day mode" $dayState.view.night $false
    $dayPath = (Send ("screenshot " + (Join-Path $work "night-day.bmp")) | ConvertFrom-Json).path
    $day = DarkShare $dayPath
    Send "action togglenight" | Out-Null
    WaitFor { $s = State; $s.view.night -and $s.pending -eq 0 -and $s.cachedBytes -gt 0 } 'night-mode page cache to settle'
    $nightState = State
    Expect "togglenight turns night on" $nightState.view.night $true
    $nightPath = (Send ("screenshot " + (Join-Path $work "night-on.bmp")) | ConvertFrom-Json).path
    $night = DarkShare $nightPath
    Write-Output ("dark share day=$day night=$night")
    Expect "page turns dark at night" ($night -gt 80) $true
    Expect "page is light by day" ($day -lt 20) $true
    $dayPages = @($dayState.cachedPageImages.PSObject.Properties.Name | Sort-Object)
    $nightPages = @($nightState.cachedPageImages.PSObject.Properties.Name | Sort-Object)
    Expect "day/night compare has the same cached pages" (($dayPages.Count -gt 0) -and (($dayPages -join ',') -ceq ($nightPages -join ','))) $true
    $growth = if ([long]$dayState.cachedBytes -gt 0) { ([double]$nightState.cachedBytes / [double]$dayState.cachedBytes) - 1.0 } else { [double]::PositiveInfinity }
    Write-Output ("page cache bytes day=$($dayState.cachedBytes) night=$($nightState.cachedBytes) growth=$([math]::Round($growth * 100, 2))%")
    Expect "night mode cache growth stays within 10 percent" ($growth -le 0.10) $true

    Send "action togglenight" | Out-Null
    WaitFor { $s = State; -not $s.view.night -and $s.pending -eq 0 } 'day mode restored'
    Expect "togglenight turns night off" (State).view.night $false
}
finally {
    $env:CHEF_E2E = $oldE2E
    $env:CHEF_USER_DATA_DIR = $oldUserData
    try { Send "quit" | Out-Null } catch {}
    if ($proc -and -not $proc.HasExited -and -not $proc.WaitForExit(5000)) { Stop-Process -Id $proc.Id -Force }
}
Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
