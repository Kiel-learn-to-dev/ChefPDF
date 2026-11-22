<# R2.21 criterion 1: fit-width zoom at three client widths (800, 1184, 1484 logical px). No focus/OS input. #>
param([string]$Exe)
$ErrorActionPreference='Stop'
$repo=Resolve-Path (Join-Path $PSScriptRoot '..')
if(-not $Exe){$Exe=Join-Path $repo 'apps\native\target\debug\chef-app.exe'}
if(-not(Test-Path $Exe)){throw "chef-app.exe not found: $Exe"}
$work=Join-Path $env:TEMP ('chef-native-fitw-'+[guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Force $work|Out-Null
$pdf=Join-Path $work 'five-pages.pdf'
Push-Location (Join-Path $repo 'core')
try { & uv run --no-project python -c 'import pikepdf,sys; p=pikepdf.Pdf.new(); [p.add_blank_page(page_size=(612,792)) for _ in range(5)]; p.save(sys.argv[1])' $pdf; if($LASTEXITCODE){throw 'fixture generation failed'} } finally {Pop-Location}
if(-not('ChefFitWin'-as[type])){Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ChefFitWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
}
'@}
$fails=0
$oldE2E=$env:CHEF_E2E; $oldData=$env:CHEF_USER_DATA_DIR; $env:CHEF_E2E='1'; $env:CHEF_USER_DATA_DIR=Join-Path $work 'userdata'; $log=Join-Path $work 'app.log'; $proc=$null
try {
  try{$proc=Start-Process -FilePath $Exe -ArgumentList ('"'+$pdf+'"') -PassThru -RedirectStandardError $log -WindowStyle Hidden} finally{$env:CHEF_E2E=$oldE2E;$env:CHEF_USER_DATA_DIR=$oldData}
  $until=(Get-Date).AddSeconds(30); while((Get-Date)-lt $until -and ((-not(Test-Path $log))-or(([string](Get-Content $log -Raw)) -notmatch 'CHEF_DEBUG_TOKEN='))){Start-Sleep -Milliseconds 200}
  $txt=Get-Content $log -Raw; $pipe=[regex]::Match($txt,'chef-native-\d+').Value; $token=[regex]::Match($txt,'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value; if(-not$pipe-or-not$token){throw 'debug pipe/token missing'}
  function Send([string]$cmd){$c=[IO.Pipes.NamedPipeClientStream]::new('.',$pipe,[IO.Pipes.PipeDirection]::InOut);$c.Connect(5000);try{$w=[IO.StreamWriter]::new($c,[Text.UTF8Encoding]::new($false));$w.AutoFlush=$true;$r=[IO.StreamReader]::new($c,[Text.UTF8Encoding]::new($false));$w.WriteLine("$token $cmd");$r.ReadLine()}finally{$c.Dispose()}}
  function State(){Send 'state'|ConvertFrom-Json}
  function Wait([scriptblock]$p,[string]$what){$end=(Get-Date).AddSeconds(30);while((Get-Date)-lt$end){if($proc-and$proc.HasExited){throw "chef-app exited while waiting for $what. Log: $log"};if(& $p){return};Start-Sleep -Milliseconds 150};throw "Timed out: $what"}
  Wait {(State).view} 'document open'
  $hwnd=[IntPtr]::new([long](State).hwnd)
  $scale=1.0 # this process is DPI-unaware: Win32 sizes are already logical
  $sidebar=210.0; $margin=28.0; $pageW=612.0
  foreach($w in 800,1184,1484){
    # SWP_NOACTIVATE|SWP_NOZORDER|SWP_NOMOVE; outer size is larger than the client area, so adjust until the client width matches.
    $outer=[int]($w*$scale)+40
    for($i=0;$i -lt 4;$i++){
      [void][ChefFitWin]::SetWindowPos($hwnd,[IntPtr]::Zero,0,0,$outer,900,0x0016)
      Start-Sleep -Milliseconds 300
      $r=New-Object ChefFitWin+RECT; [void][ChefFitWin]::GetClientRect($hwnd,[ref]$r)
      $cw=($r.R-$r.L)
      if([math]::Abs($cw-$w) -lt 1){break}
      $outer+=[int](($w-$cw)*$scale)
    }
    Send 'action zoomreset'|Out-Null
    Start-Sleep -Milliseconds 500
    $s=State
    $expected=($cw-$sidebar-2*$margin)/$pageW
    if($s.view.fitWidth -and [math]::Abs([double]$s.view.zoom-$expected) -lt 0.01){Write-Output "PASS fit-width at ${w}px (client $cw): zoom $($s.view.zoom) vs $([math]::Round($expected,4))"}
    else{$fails++; Write-Output "FAIL fit-width at ${w}px (client $cw): zoom $($s.view.zoom) fitWidth=$($s.view.fitWidth) expected $([math]::Round($expected,4))"}
  }
  Write-Output "FAILS: $fails"
} finally {$env:CHEF_E2E=$oldE2E;$env:CHEF_USER_DATA_DIR=$oldData;if($proc-and-not$proc.HasExited){Stop-Process -Id $proc.Id -Force};Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue}
if($fails -gt 0){exit 1}

