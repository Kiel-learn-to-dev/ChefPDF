<# R2.21 zoom/rotation action E2E. No OS keyboard or mouse input. #>
param([string]$Exe)
$ErrorActionPreference='Stop'
$repo=Resolve-Path (Join-Path $PSScriptRoot '..')
if(-not $Exe){$Exe=Join-Path $repo 'apps\native\target\debug\chef-app.exe'}
if(-not(Test-Path $Exe)){throw "chef-app.exe not found: $Exe"}
$work=Join-Path $env:TEMP ('chef-native-zoom-'+[guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Force $work|Out-Null
$pdf=Join-Path $work 'five-pages.pdf'
Push-Location (Join-Path $repo 'core')
try { & uv run --no-project python -c 'import pikepdf,sys; p=pikepdf.Pdf.new(); [p.add_blank_page(page_size=(612,792)) for _ in range(5)]; p.save(sys.argv[1])' $pdf; if($LASTEXITCODE){throw 'fixture generation failed'} } finally {Pop-Location}
$oldE2E=$env:CHEF_E2E; $oldData=$env:CHEF_USER_DATA_DIR; $env:CHEF_E2E='1'; $env:CHEF_USER_DATA_DIR=Join-Path $work 'userdata'; $log=Join-Path $work 'app.log'; $proc=$null
try {
  try{$proc=Start-Process -FilePath $Exe -ArgumentList ('"'+$pdf+'"') -PassThru -RedirectStandardError $log -WindowStyle Hidden} finally{$env:CHEF_E2E=$oldE2E;$env:CHEF_USER_DATA_DIR=$oldData}
  $until=(Get-Date).AddSeconds(30); while((Get-Date)-lt $until -and ((-not(Test-Path $log))-or((Get-Content $log -Raw)-notmatch 'CHEF_DEBUG_TOKEN='))){Start-Sleep -Milliseconds 200}
  $txt=Get-Content $log -Raw; $pipe=[regex]::Match($txt,'chef-native-\d+').Value; $token=[regex]::Match($txt,'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value; if(-not$pipe-or-not$token){throw 'debug pipe/token missing'}
  function Send([string]$cmd){$c=[IO.Pipes.NamedPipeClientStream]::new('.',$pipe,[IO.Pipes.PipeDirection]::InOut);$c.Connect(5000);try{$w=[IO.StreamWriter]::new($c,[Text.UTF8Encoding]::new($false));$w.AutoFlush=$true;$r=[IO.StreamReader]::new($c,[Text.UTF8Encoding]::new($false));$w.WriteLine("$token $cmd");$r.ReadLine()}finally{$c.Dispose()}}
  function State(){Send 'state'|ConvertFrom-Json}
  function Wait([scriptblock]$p,[string]$what){$end=(Get-Date).AddSeconds(30);while((Get-Date)-lt$end){if(& $p){return};Start-Sleep -Milliseconds 150};throw "Timed out: $what"}
  Wait {$null-ne(State).view} 'initial view'
  Send 'action zoomfitpage'|Out-Null; Wait {(State).view.fitPage} 'fit page state'
  Send 'action focuszoom'|Out-Null; Send 'action selectall'|Out-Null; Send 'char 150%'|Out-Null; Send 'action submit'|Out-Null
  Wait {$s=State;[math]::Abs($s.view.zoom-1.5)-lt0.02-and-not$s.view.fitPage-and-not$s.view.fitWidth} '150 percent zoom input'
  Send 'action rotateviewright'|Out-Null; Wait {(State).view.rotation-eq1} 'rotate right'
  Send 'action rotateviewright'|Out-Null; Wait {(State).view.rotation-eq2} 'rotate 180 degrees'
  Send 'action rotateviewleft'|Out-Null; Send 'action rotateviewleft'|Out-Null; Wait {(State).view.rotation-eq0} 'restore unrotated view'
  Send 'action zoomreset'|Out-Null; Wait {(State).view.fitWidth-and-not(State).view.fitPage} 'fit width'
  Send 'quit'|Out-Null
  Write-Output 'PASS R2.21: fit page, percentage zoom, view rotation, fit width; action-only, no OS input'
} finally {$env:CHEF_E2E=$oldE2E;$env:CHEF_USER_DATA_DIR=$oldData;if($proc-and-not$proc.HasExited){Stop-Process -Id $proc.Id -Force};Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue}
