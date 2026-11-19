<#
R2.31 viewer shortcut matrix through the GPUI keymap (TASKS_RUST R2.31). Each combination goes through
debug `keystroke`, which calls Window::dispatch_keystroke, so the binding table is exercised without
OS focus. Physical-key coverage stays in e2e-native-keyboard.ps1 (CHEF_E2E_OS_INPUT=1).
#>
param([string]$Exe)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
if (-not (Test-Path $Exe)) { throw "chef-app.exe not found: $Exe" }
$work = Join-Path $env:TEMP ('chef-native-keymap-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
$pdfA = Join-Path $work 'a.pdf'
$pdfB = Join-Path $work 'b.pdf'
Push-Location (Join-Path $repo 'core')
try {
    & uv run --no-project python -c 'import pikepdf,sys; p=pikepdf.Pdf.new(); [p.add_blank_page(page_size=(612,792)) for _ in range(5)]; p.save(sys.argv[1])' $pdfA
    if ($LASTEXITCODE) { throw 'fixture a.pdf failed' }
    & uv run --no-project python -c 'import pikepdf,sys; p=pikepdf.Pdf.new(); [p.add_blank_page(page_size=(612,792)) for _ in range(3)]; p.save(sys.argv[1])' $pdfB
    if ($LASTEXITCODE) { throw 'fixture b.pdf failed' }
} finally { Pop-Location }

$oldE2E = $env:CHEF_E2E; $oldData = $env:CHEF_USER_DATA_DIR; $oldClose = $env:CHEF_E2E_CLOSE_DIALOGS
$env:CHEF_E2E = '1'; $env:CHEF_E2E_CLOSE_DIALOGS = '1'; $env:CHEF_USER_DATA_DIR = Join-Path $work 'userdata'
$log = Join-Path $work 'app.log'
$proc = $null
try {
    try {
        # Hai file: hai tab, để kiểm Ctrl+Tab.
        $proc = Start-Process -FilePath $Exe -ArgumentList ('"' + $pdfA + '" "' + $pdfB + '"') -PassThru -RedirectStandardError $log -WindowStyle Hidden
    } finally {
        $env:CHEF_E2E = $oldE2E; $env:CHEF_USER_DATA_DIR = $oldData; $env:CHEF_E2E_CLOSE_DIALOGS = $oldClose
    }
    $until = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $until -and ((-not (Test-Path $log)) -or (([string](Get-Content $log -Raw)) -notmatch 'CHEF_DEBUG_TOKEN='))) { Start-Sleep -Milliseconds 200 }
    $txt = Get-Content $log -Raw
    $pipe = [regex]::Match($txt, 'chef-native-\d+').Value
    $token = [regex]::Match($txt, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
    if (-not $pipe -or -not $token) { throw 'debug pipe/token missing' }

    function Send([string]$cmd) {
        $c = [IO.Pipes.NamedPipeClientStream]::new('.', $pipe, [IO.Pipes.PipeDirection]::InOut)
        $c.Connect(5000)
        try {
            $w = [IO.StreamWriter]::new($c, [Text.UTF8Encoding]::new($false)); $w.AutoFlush = $true
            $r = [IO.StreamReader]::new($c, [Text.UTF8Encoding]::new($false))
            $w.WriteLine("$token $cmd"); $r.ReadLine()
        } finally { $c.Dispose() }
    }
    function State() { Send 'state' | ConvertFrom-Json }
    function Wait([scriptblock]$p, [string]$what) {
        $end = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $end) {
            if ($proc -and $proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)) while waiting for $what. Log: $log" }
            if (& $p) { return }
            Start-Sleep -Milliseconds 120
        }
        throw "Timed out: $what"
    }
    function Pass([string]$what) { Write-Output "PASS $what" }
    function ActiveTitle($s) { ($s.tabs | Where-Object { $_.active } | Select-Object -First 1).title }

    Wait { $null -ne (State).view -and (State).tabs.Count -eq 2 } 'two tabs rendered'
    Wait { (State).view.visiblePages.Count -gt 0 } 'first page visible'
    # Lúc khởi động ô tìm kiếm đang có tiêu điểm (input.focused). Click vùng nội dung để trả tiêu điểm
    # về Viewer, như người dùng làm; phím Escape không đủ.
    function FocusViewerByClick() {
        Send 'mouse down 600 400' | Out-Null
        Send 'mouse up 600 400' | Out-Null
        Wait { -not (State).input.focused } 'click moves focus from the search input to the viewer'
    }
    FocusViewerByClick

    # Ctrl+= và Ctrl+−: phóng to rồi thu nhỏ.
    $z0 = (State).view.zoom
    Send 'keystroke ctrl-=' | Out-Null
    Wait { (State).view.zoom -gt $z0 } 'Ctrl+= zooms in'
    $zIn = (State).view.zoom
    Pass 'Ctrl+= zooms in'
    Send 'keystroke ctrl--' | Out-Null
    Wait { (State).view.zoom -lt $zIn } 'Ctrl+- zooms out'
    Pass 'Ctrl+- zooms out'
    # Ctrl+0: "Vừa khung" (ZoomReset) đưa về chế độ vừa chiều rộng.
    Send 'keystroke ctrl-0' | Out-Null
    Wait { (State).view.fitWidth -eq $true } 'Ctrl+0 returns to fit-width'
    Pass 'Ctrl+0 returns to fit-width'

    # PageDown và PageUp: di chuyển theo trang.
    $p0 = (State).view.firstPage
    Send 'keystroke pagedown' | Out-Null
    Wait { (State).view.firstPage -gt $p0 } 'PageDown advances the page'
    $p1 = (State).view.firstPage
    Pass 'PageDown advances the page'
    Send 'keystroke pageup' | Out-Null
    Wait { (State).view.firstPage -lt $p1 } 'PageUp goes back a page'
    Pass 'PageUp goes back a page'

    # F11: bật và tắt toàn màn hình.
    $fs0 = (State).view.fullscreen
    Send 'keystroke f11' | Out-Null
    Wait { (State).view.fullscreen -ne $fs0 } 'F11 toggles fullscreen'
    Send 'keystroke f11' | Out-Null
    Wait { (State).view.fullscreen -eq $fs0 } 'F11 toggles fullscreen back'
    Pass 'F11 toggles fullscreen and back'

    # Ctrl+F: đưa tiêu điểm vào ô tìm. Khi ô có tiêu điểm, PageUp/PageDown chỉ đưa caret, không đổi trang.
    Send 'keystroke ctrl-f' | Out-Null
    Wait { (State).input.focused -eq $true } 'Ctrl+F focuses the search input'
    Pass 'Ctrl+F focuses the search input'
    Send 'char x' | Out-Null
    Wait { $s = State; $s.input.text -eq 'x' -and $s.input.selStart -eq 1 } 'search text typed'
    $pFocus = (State).view.firstPage
    Send 'keystroke pageup' | Out-Null
    Wait { (State).input.selStart -eq 0 } 'PageUp moves the caret to the start of the focused input'
    if ((State).view.firstPage -ne $pFocus) { throw 'PageUp changed the PDF page while the search input was focused' }
    Send 'keystroke pagedown' | Out-Null
    Wait { (State).input.selStart -eq 1 } 'PageDown moves the caret to the end of the focused input'
    if ((State).view.firstPage -ne $pFocus) { throw 'PageDown changed the PDF page while the search input was focused' }
    Pass 'PageUp/PageDown stay in the focused search input and do not change the PDF page'
    FocusViewerByClick

    # Ctrl+K: mở bảng lệnh rồi đóng.
    Send 'keystroke ctrl-k' | Out-Null
    Wait { (State).palette.open -eq $true } 'Ctrl+K opens the command palette'
    Pass 'Ctrl+K opens the command palette'
    Send 'action cancel' | Out-Null
    Wait { (State).palette.open -eq $false } 'Escape closes the command palette'

    # Ctrl+O: mở hộp thoại mở file (E2E tự đóng hộp thoại OS).
    Send 'keystroke ctrl-o' | Out-Null
    Wait { (State).fileDialog.kind -eq 'open' } 'Ctrl+O requests the Open dialog'
    Pass 'Ctrl+O requests the Open dialog'

    # Ctrl+Tab: chuyển sang tab kế tiếp (b.pdf → a.pdf, vòng lại).
    $before = ActiveTitle (State)
    Send 'keystroke ctrl-tab' | Out-Null
    Wait { (ActiveTitle (State)) -ne $before } 'Ctrl+Tab switches to the next tab'
    Pass "Ctrl+Tab switches tab ($before -> $(ActiveTitle (State)))"

    Send 'quit' | Out-Null
    if (-not $proc.WaitForExit(5000)) { throw 'chef-app did not exit after quit.' }
    Write-Output 'PASS R2.31 keymap matrix: Ctrl+=, Ctrl+-, Ctrl+0, PageUp/PageDown, F11, Ctrl+F, Ctrl+K, Ctrl+O, Ctrl+Tab; search focus keeps PageUp/PageDown in the input'
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
