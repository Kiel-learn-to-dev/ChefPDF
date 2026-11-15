<# R2.21 criterion 3: time to first page and 20x next-page on a ~305 MB image PDF (native only). #>
param([string]$Exe, [string]$Pdf = (Join-Path $env:TEMP 'chef-perf\big300.pdf'), [double]$MaxFirstPageSeconds = 5.1)
$ErrorActionPreference='Stop'
$repo=Resolve-Path (Join-Path $PSScriptRoot '..')
if(-not $Exe){$Exe=Join-Path $repo 'apps\native\target\debug\chef-app.exe'}
if(-not(Test-Path $Exe)){throw "chef-app.exe not found: $Exe"}
if(-not(Test-Path $Pdf)){throw "fixture not found: $Pdf (see scripts/gen-perf-large-fixture.py)"}
$work=Join-Path $env:TEMP ('chef-native-perflarge-'+[guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Force $work|Out-Null
$oldE2E=$env:CHEF_E2E; $oldData=$env:CHEF_USER_DATA_DIR; $env:CHEF_E2E='1'; $env:CHEF_USER_DATA_DIR=Join-Path $work 'userdata'; $log=Join-Path $work 'app.log'; $proc=$null; $fails=0
try {
  $sw=[Diagnostics.Stopwatch]::StartNew()
  try{$proc=Start-Process -FilePath $Exe -ArgumentList ('"'+$Pdf+'"') -PassThru -RedirectStandardError $log -WindowStyle Hidden} finally{$env:CHEF_E2E=$oldE2E;$env:CHEF_USER_DATA_DIR=$oldData}
  $until=(Get-Date).AddSeconds(60); while((Get-Date)-lt $until -and ((-not(Test-Path $log))-or(([string](Get-Content $log -Raw)) -notmatch 'CHEF_DEBUG_TOKEN='))){Start-Sleep -Milliseconds 50}
  $txt=Get-Content $log -Raw; $pipe=[regex]::Match($txt,'chef-native-\d+').Value; $token=[regex]::Match($txt,'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value; if(-not$pipe-or-not$token){throw 'debug pipe/token missing'}
  function Send([string]$cmd){$c=[IO.Pipes.NamedPipeClientStream]::new('.',$pipe,[IO.Pipes.PipeDirection]::InOut);$c.Connect(5000);try{$w=[IO.StreamWriter]::new($c,[Text.UTF8Encoding]::new($false));$w.AutoFlush=$true;$r=[IO.StreamReader]::new($c,[Text.UTF8Encoding]::new($false));$w.WriteLine("$token $cmd");$r.ReadLine()}finally{$c.Dispose()}}
  function State(){Send 'state'|ConvertFrom-Json}
  function Has-Image([int]$page){$s=State; $null -ne $s.cachedPageImages.PSObject.Properties[[string]$page]}
  $end=(Get-Date).AddSeconds(120); while(-not(Has-Image 0)){ if($proc.HasExited){throw "chef-app exited. Log: $log"}; if((Get-Date)-gt $end){throw 'first page never rendered'}; Start-Sleep -Milliseconds 20 }
  $first=$sw.Elapsed.TotalSeconds
  $pages=[int](State).view.visiblePages.Count
  $sw.Restart()
  1..20 | ForEach-Object { Send 'action nextpage' | Out-Null; Start-Sleep -Milliseconds 5 }
  $target=[Math]::Min(20,30)
  $end=(Get-Date).AddSeconds(60); while(([int](State).view.firstPage) -lt 20 -or -not(Has-Image 20)){ if((Get-Date)-gt $end){throw 'did not reach page 20 with a rendered image'}; Start-Sleep -Milliseconds 10 }
  $nav=$sw.Elapsed.TotalSeconds
  Write-Output ("first page: {0:N2} s (limit {1}); 20x next page until page 20 rendered: {2:N0} ms; file {3:N0} MB" -f $first,$MaxFirstPageSeconds,($nav*1000),((Get-Item $Pdf).Length/1MB))
  if($first -le $MaxFirstPageSeconds){Write-Output 'PASS first page not slower than the Electron baseline'} else {$fails++; Write-Output 'FAIL first page slower than the Electron baseline'}
  Write-Output "FAILS: $fails"
} finally {$env:CHEF_E2E=$oldE2E;$env:CHEF_USER_DATA_DIR=$oldData;if($proc-and-not$proc.HasExited){Stop-Process -Id $proc.Id -Force};Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue}
if($fails -gt 0){exit 1}
