<#
.SYNOPSIS
  R2.22 sidebar E2E: verify visible thumbnail count stays within 60, then click a real outline
  entry and confirm the viewer navigates to its destination page.
.DESCRIPTION
  Windows only. Requires chef-app.exe, pdfium.dll, Python/pikepdf via uv, and the debug pipe.
#>
param([string]$Exe)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path $Exe)) { throw "chef-app.exe not found: $Exe" }
$work = Join-Path $env:TEMP ('chef-native-toc-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
$pdf = Join-Path $work 'outline.pdf'
$fixture = @'
import pikepdf, sys
pdf = pikepdf.Pdf.new()
# Shallow, tiny pages make >60 thumbnail rows intersect the initial sidebar viewport. That
# exercises the hard cap instead of merely checking that a normal four-row viewport is small.
for _ in range(500):
    pdf.add_blank_page(page_size=(100, 1))
target = pdf.pages[8]
with pdf.open_outline() as outline:
    outline.root.append(pikepdf.OutlineItem("Jump to page 9", pikepdf.Array([target.obj, pikepdf.Name.Fit])))
pdf.save(sys.argv[1])
'@
Push-Location (Join-Path $repo 'core')
try {
    & uv run --no-project python -c $fixture $pdf
    if ($LASTEXITCODE) { throw 'bookmark fixture generation failed' }
} finally { Pop-Location }

$oldE2E = $env:CHEF_E2E
$oldUserData = $env:CHEF_USER_DATA_DIR
$dataDir = Join-Path $work 'userdata'
$env:CHEF_E2E = '1'
$env:CHEF_USER_DATA_DIR = $dataDir
$log = Join-Path $work 'app.log'
$proc = $null
try {
    try { $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $pdf + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden }
    finally {
        $env:CHEF_E2E = $oldE2E
        $env:CHEF_USER_DATA_DIR = $oldUserData
    }
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline -and ((-not (Test-Path $log)) -or ((Get-Content $log -Raw) -notmatch 'CHEF_DEBUG_TOKEN='))) { Start-Sleep -Milliseconds 200 }
    $logText = Get-Content $log -Raw
    $pipe = [regex]::Match($logText, 'chef-native-\d+').Value
    $token = [regex]::Match($logText, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    if (-not $pipe -or -not $token) { throw 'debug pipe/token missing from app log' }
    function Send([string]$command) {
        $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipe, [System.IO.Pipes.PipeDirection]::InOut)
        $client.Connect(5000)
        try {
            $writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false)); $writer.AutoFlush = $true
            $reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false))
            $writer.WriteLine("$token $command"); return $reader.ReadLine()
        } finally { $client.Dispose() }
    }
    function State() { return (Send 'state' | ConvertFrom-Json) }
    function WaitFor([scriptblock]$predicate, [string]$what) {
        $end = (Get-Date).AddSeconds(45)
        while ((Get-Date) -lt $end) { if (& $predicate) { return }; Start-Sleep -Milliseconds 250 }
        throw "Timed out waiting for $what"
    }
    function Click-Client([double]$x, [double]$y, [double]$scale) {
        $px = [int][math]::Round($x * $scale); $py = [int][math]::Round($y * $scale)
        Send "mouse down $px $py" | Out-Null
        Send "mouse up $px $py" | Out-Null
    }

    WaitFor { $s = State; $s.view -and $s.view.firstPage -eq 0 -and $s.sidebarThumbnails -gt 0 } 'first page and rendered thumbnails'
    $state = State
    if ($state.sidebarThumbnails -ne 60) { throw "expected hard cap of 60 visible thumbnail rows for 500 tiny pages, got $($state.sidebarThumbnails)" }
    Write-Output "PASS 500 tiny pages produce exactly 60 retained thumbnails (hard cap)"

    # Host tab strip and Viewer toolbar are each 40 logical pixels high; the sidebar mode
    # controls are centered near x=130, y=100.
    Click-Client 135 100 $state.scale
    WaitFor { $s = State; $s.sidebarOutline -and $s.sidebarBookmarks -eq 1 } 'outline mode with one PDF bookmark'
    # First bookmark row follows the 40 px sidebar header, below the host strip and viewer toolbar.
    Click-Client 110 134 $state.scale
    WaitFor { $s = State; $s.view.firstPage -eq 8 } 'bookmark click navigates to PDF page 9'
    Write-Output 'PASS clicking the PDF outline entry navigates to page 9'
    Send 'quit' | Out-Null
}
finally {
    $env:CHEF_E2E = $oldE2E
    $env:CHEF_USER_DATA_DIR = $oldUserData
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
