<#
.SYNOPSIS
  E2E cho chỉ báo lớp chữ (TASKS_RUST R2.29): tài liệu có chữ, scan, và hỗn hợp được nhận đúng,
  và tài liệu lớn chỉ đọc một số trang mẫu.

.DESCRIPTION
  Mở từng PDF ngoài màn hình, đọc `view.kind` từ `state`. Cần PDF mẫu trong %TEMP%\chef-perf:
  pages1000.pdf (chữ, 1000 trang), scan1.pdf (scan, 1 trang), mixed4.pdf (3 trang chữ và 1 scan).
#>
param([string]$Exe)

$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\apps\native\target\debug\chef-app.exe" }
$dir = Join-Path $env:TEMP "chef-perf"
$cases = @(
    @{ File = "pages1000.pdf"; Kind = "text" },
    @{ File = "scan1.pdf"; Kind = "scan" },
    @{ File = "mixed4.pdf"; Kind = "mixed" }
)

$script:fails = 0
foreach ($case in $cases) {
    Get-Process chef-app -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }
    $env:CHEF_E2E = "1"
    $log = Join-Path $env:TEMP ("chef-kind-" + [guid]::NewGuid().ToString("N") + ".txt")
    $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + (Join-Path $dir $case.File) + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
    $env:CHEF_E2E = $null
    Start-Sleep -Seconds 4
    $text = Get-Content $log -Raw
    $pipe = [regex]::Match($text, 'chef-native-\d+').Value
    $tok = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    $c = New-Object System.IO.Pipes.NamedPipeClientStream(".", $pipe, [System.IO.Pipes.PipeDirection]::InOut)
    $c.Connect(3000)
    $w = New-Object System.IO.StreamWriter($c, [System.Text.UTF8Encoding]::new($false)); $w.AutoFlush = $true; $w.NewLine = "`n"
    $r = New-Object System.IO.StreamReader($c, [System.Text.UTF8Encoding]::new($false))
    $w.WriteLine("$tok state")
    $state = $r.ReadLine() | ConvertFrom-Json
    $c.Dispose()
    $got = $state.view.kind
    if ($got -ceq $case.Kind) { Write-Output ("PASS " + $case.File + " is " + $got) }
    else { $script:fails++; Write-Output ("FAIL " + $case.File + ": got [" + $got + "] want [" + $case.Kind + "]") }
    try {
        $c2 = New-Object System.IO.Pipes.NamedPipeClientStream(".", $pipe, [System.IO.Pipes.PipeDirection]::InOut); $c2.Connect(3000)
        $w2 = New-Object System.IO.StreamWriter($c2); $w2.AutoFlush = $true; $w2.NewLine = "`n"; $w2.WriteLine("$tok quit"); $c2.Dispose()
    } catch {}
    Start-Sleep -Milliseconds 300
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
