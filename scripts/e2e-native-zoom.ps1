<# R2.21 zoom/rotation Windows E2E. CHEF_E2E_OS_INPUT=1 enables physical Ctrl zoom shortcuts. #>
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
  function Wait([scriptblock]$p,[string]$what){$end=(Get-Date).AddSeconds(30);while((Get-Date)-lt$end){if($proc-and$proc.HasExited){throw "chef-app exited ($($proc.ExitCode)) while waiting for $what. Log: $log"};if(& $p){return};Start-Sleep -Milliseconds 150};throw "Timed out: $what"}
  if(-not('ChefZoomKeyboard'-as[type])){Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ChefZoomKeyboard {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@}
  function Focus-App{if($env:CHEF_E2E_OS_INPUT-ne'1'){return};$s=State;$hwnd=[IntPtr]::new([long]$s.hwnd);[void][ChefZoomKeyboard]::ShowWindow($hwnd,9);[void][ChefZoomKeyboard]::SetWindowPos($hwnd,[IntPtr]::Zero,100,100,1280,900,0x0040);Start-Sleep -Milliseconds 200;[void][ChefZoomKeyboard]::SetForegroundWindow($hwnd);Wait {(State).foreground} 'app foreground'}
  function Ctrl-Key([byte]$vk){if($env:CHEF_E2E_OS_INPUT-ne'1'){switch($vk){0xBB{Send 'action zoomin'|Out-Null;return}0xBD{Send 'action zoomout'|Out-Null;return}0x30{Send 'action zoomreset'|Out-Null;return}default{throw "unsupported non-OS Ctrl key: $vk"}}};[ChefZoomKeyboard]::keybd_event(0x11,0,0,[UIntPtr]::Zero);[ChefZoomKeyboard]::keybd_event($vk,0,0,[UIntPtr]::Zero);[ChefZoomKeyboard]::keybd_event($vk,0,2,[UIntPtr]::Zero);[ChefZoomKeyboard]::keybd_event(0x11,0,2,[UIntPtr]::Zero)}
  Wait {$null-ne(State).view} 'initial view'
  Focus-App
  Send 'action zoomfitpage'|Out-Null; Wait {(State).view.fitPage} 'fit page state'
  $before=[double](State).view.zoom; Ctrl-Key 0xBB # Ctrl+= (VK_OEM_PLUS)
  Wait {$s=State;[double]$s.view.zoom-gt$before-and-not$s.view.fitPage-and-not$s.view.fitWidth} 'physical Ctrl+= zooms in'
  $before=[double](State).view.zoom; Ctrl-Key 0xBD # Ctrl+- (VK_OEM_MINUS)
  Wait {$s=State;[double]$s.view.zoom-lt$before} 'physical Ctrl+- zooms out'
  Ctrl-Key 0x30 # Ctrl+0
  Wait {(State).view.fitWidth-and-not(State).view.fitPage} 'physical Ctrl+0 restores fit width'
  Send 'action focuszoom'|Out-Null; Send 'action selectall'|Out-Null; Send 'char 150%'|Out-Null; Send 'action submit'|Out-Null
  Wait {$s=State;[math]::Abs($s.view.zoom-1.5)-lt0.02-and-not$s.view.fitPage-and-not$s.view.fitWidth} '150 percent zoom input'
  Send 'action rotateviewright'|Out-Null; Wait {(State).view.rotation-eq1} 'rotate right'
  Send 'action rotateviewright'|Out-Null; Wait {(State).view.rotation-eq2} 'rotate 180 degrees'
  Send 'action rotateviewleft'|Out-Null; Send 'action rotateviewleft'|Out-Null; Wait {(State).view.rotation-eq0} 'restore unrotated view'
  Ctrl-Key 0x30; Wait {(State).view.fitWidth-and-not(State).view.fitPage} 'Ctrl+0 restores fit width after manual zoom/rotation'
  Send 'quit'|Out-Null; if(-not$proc.WaitForExit(5000)){throw 'chef-app did not exit after quit.'}
  Write-Output 'PASS R2.21: physical Ctrl+=/Ctrl+-/Ctrl+0, percentage zoom, and view rotation; Windows runtime and Electron comparisons still required'
} finally {$env:CHEF_E2E=$oldE2E;$env:CHEF_USER_DATA_DIR=$oldData;if($proc-and-not$proc.HasExited){Stop-Process -Id $proc.Id -Force};Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue}
