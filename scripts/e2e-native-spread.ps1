<# R2.20 modes/slideshow Windows E2E. CHEF_E2E_OS_INPUT=1 enables physical navigation/fullscreen keys. #>
param([string]$Exe)
$ErrorActionPreference='Stop'
$repo=Resolve-Path (Join-Path $PSScriptRoot '..')
if(-not $Exe){$Exe=Join-Path $repo 'apps\native\target\debug\chef-app.exe'}
if(-not(Test-Path $Exe)){throw "chef-app.exe not found: $Exe"}
$work=Join-Path $env:TEMP ('chef-native-spread-'+[guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Force $work|Out-Null
$pdf=Join-Path $work 'five-pages.pdf'; Push-Location (Join-Path $repo 'core')
try { & uv run --no-project python -c 'import pikepdf,sys; p=pikepdf.Pdf.new(); [p.add_blank_page(page_size=(612,792)) for _ in range(5)]; p.save(sys.argv[1])' $pdf; if($LASTEXITCODE){throw 'fixture generation failed'} } finally {Pop-Location}
$oldE2E=$env:CHEF_E2E; $oldData=$env:CHEF_USER_DATA_DIR; $env:CHEF_E2E='1'; $env:CHEF_USER_DATA_DIR=Join-Path $work 'userdata'; $log=Join-Path $work 'app.log'; $proc=$null
try {
  try{$proc=Start-Process -FilePath $Exe -ArgumentList ('"'+$pdf+'"') -PassThru -RedirectStandardError $log -WindowStyle Hidden} finally{$env:CHEF_E2E=$oldE2E;$env:CHEF_USER_DATA_DIR=$oldData}
  $until=(Get-Date).AddSeconds(30); while((Get-Date)-lt $until -and ((-not(Test-Path $log))-or((Get-Content $log -Raw)-notmatch 'CHEF_DEBUG_TOKEN='))){Start-Sleep -Milliseconds 200}
  $txt=Get-Content $log -Raw; $pipe=[regex]::Match($txt,'chef-native-\d+').Value; $token=[regex]::Match($txt,'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value; if(-not$pipe-or-not$token){throw 'debug pipe/token missing'}
  function Send([string]$cmd){$c=[IO.Pipes.NamedPipeClientStream]::new('.',$pipe,[IO.Pipes.PipeDirection]::InOut);$c.Connect(5000);try{$w=[IO.StreamWriter]::new($c,[Text.UTF8Encoding]::new($false));$w.AutoFlush=$true;$r=[IO.StreamReader]::new($c,[Text.UTF8Encoding]::new($false));$w.WriteLine("$token $cmd");$r.ReadLine()}finally{$c.Dispose()}}
  function State(){Send 'state'|ConvertFrom-Json}
  function Wait([scriptblock]$p,[string]$what){$end=(Get-Date).AddSeconds(30);while((Get-Date)-lt$end){if($proc-and$proc.HasExited){throw "chef-app exited ($($proc.ExitCode)) while waiting for $what. Log: $log"};if(& $p){return};Start-Sleep -Milliseconds 150};throw "Timed out: $what"}
  if(-not('ChefSpreadKeyboard'-as[type])){Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ChefSpreadKeyboard {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@}
  function Focus-App{if($env:CHEF_E2E_OS_INPUT-ne'1'){return};$s=State;$hwnd=[IntPtr]::new([long]$s.hwnd);[void][ChefSpreadKeyboard]::ShowWindow($hwnd,9);[void][ChefSpreadKeyboard]::SetWindowPos($hwnd,[IntPtr]::Zero,100,100,1280,900,0x0040);Start-Sleep -Milliseconds 200;[void][ChefSpreadKeyboard]::SetForegroundWindow($hwnd);Wait {(State).foreground} 'app foreground'}
  function Key([byte]$vk){if($env:CHEF_E2E_OS_INPUT-ne'1'){switch($vk){0x27{Send 'action slidenext'|Out-Null;return}0x25{Send 'action slideprevious'|Out-Null;return}0x7A{Send 'action togglefullscreen'|Out-Null;return}default{throw "unsupported non-OS key: $vk"}}};[ChefSpreadKeyboard]::keybd_event($vk,0,0,[UIntPtr]::Zero);[ChefSpreadKeyboard]::keybd_event($vk,0,2,[UIntPtr]::Zero)}
  Wait {$null-ne(State).view} 'initial render'; Focus-App
  Send 'action viewbook'|Out-Null; Wait {$s=State;$s.view.mode-eq'book'-and(@($s.view.visiblePages).Count-eq1)} 'book cover alone'
  Send 'action viewtwopage'|Out-Null; Wait {$s=State;$s.view.mode-eq'twoPage'-and(@($s.view.visiblePages).Count-ge2)} 'two-page spread'
  Send 'action viewslideshow'|Out-Null; Wait {$s=State;$s.view.pageMode-eq'slideshow'-and$s.view.fullscreen-and(@($s.view.visiblePages).Count-eq1)} 'one-page fullscreen slideshow'
  $shot=Join-Path $work 'slideshow.bmp'; Send "screenshot $shot"|Out-Null; if(-not(Test-Path $shot)){throw 'slideshow screenshot was not captured'}
  $before=(State).view.firstPage; Key 0x27 # Right arrow
  Wait {$s=State;$s.view.firstPage-gt$before} 'next slide from physical Right arrow'; Key 0x25 # Left arrow
  Wait {$s=State;$s.view.firstPage-eq$before} 'previous slide from physical Left arrow'
  $full=(State).view.fullscreen; Key 0x7A # F11
  Wait {(State).view.fullscreen-ne$full} 'physical F11 toggles fullscreen'; Key 0x7A
  Wait {(State).view.fullscreen-eq$full} 'F11 toggles fullscreen back'
  Send 'action focussearch'|Out-Null; Send 'char x'|Out-Null; Wait {$s=State;$s.input.text-eq'x'-and$s.input.selStart-eq1} 'slideshow search input'
  Send 'action left'|Out-Null; Wait {(State).input.selStart-eq0} 'Left edits search cursor during slideshow'
  Send 'action right'|Out-Null; Wait {(State).input.selStart-eq1} 'Right edits search cursor during slideshow'
  Send 'action cancel'|Out-Null; Wait {$s=State;$s.view.pageMode-eq'slideshow'} 'Escape leaves search without changing slideshow'
  Send 'action exitslideshow'|Out-Null; Wait {$s=State;$s.view.pageMode-eq'continuous'-and-not$s.view.fullscreen} 'Escape exits slideshow and restores fullscreen'; Send 'quit'|Out-Null; if(-not$proc.WaitForExit(5000)){throw 'chef-app did not exit after quit.'}
  Write-Output 'PASS R2.20: book/two-page/slideshow grouping, slide navigation, fullscreen toggle, search cursor actions'
} finally {$env:CHEF_E2E=$oldE2E;$env:CHEF_USER_DATA_DIR=$oldData;if($proc-and-not$proc.HasExited){Stop-Process -Id $proc.Id -Force}}
