<#
.SYNOPSIS
  E2E cho menu và ô chọn (TASKS_RUST R2.06, R2.08, BLUEPRINT_RUST §6.6): chuột phải mở menu đúng
  vị trí chuột; mũi tên bỏ qua mục khóa và có vòng lại; Enter chọn; Esc và bấm ra ngoài đóng và trả
  tiêu điểm; gõ chữ đầu nhảy tới mục. Ô chọn: Enter mở, mũi tên, gõ chữ, Enter chọn, Esc, bấm nút để mở và đóng.

.DESCRIPTION
  Chạy trang thử (CHEF_E2E=1, CHEF_E2E_PROBE=1). Chuột đi qua `mouse rdown|rup|down|up x y` (tọa độ
  vật lý). Mọi tọa độ lấy từ `state.controls` (bounds logic × scale). Cần `cargo build -p chef-app`.
#>
param([string]$Exe)

$ErrorActionPreference = "Stop"
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot "..\apps\native\target\debug\chef-app.exe" }

Get-Process chef-app -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }

$env:CHEF_E2E = "1"
$env:CHEF_E2E_PROBE = "1"
$log = Join-Path $env:TEMP ("chef-menu-" + [guid]::NewGuid().ToString("N") + ".txt")
$proc = Start-Process -FilePath $Exe -PassThru -RedirectStandardError $log -WindowStyle Hidden
$env:CHEF_E2E = $null
$env:CHEF_E2E_PROBE = $null
Start-Sleep -Seconds 4

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
function State() { return (Send 'state' | ConvertFrom-Json) }
function Controls() { return (State).controls.controls }
function Ctrl([string]$id) { return Controls | Where-Object { $_.id -eq $id } | Select-Object -First 1 }
function Focused() {
    $f = Controls | Where-Object { $_.focused } | Select-Object -First 1
    if ($f) { return [string]$f.id } else { return "" }
}
function Key([int]$vk) { Send "key $vk" | Out-Null; Start-Sleep -Milliseconds 150 }
# Bấm vào điểm logic (lx, ly) bằng chuột trái hoặc phải.
function ClickAt([double]$lx, [double]$ly, [string]$button = "") {
    $s = [double](State).controls.scale
    $x = [int]($lx * $s); $y = [int]($ly * $s)
    $down = if ($button -eq "right") { "rdown" } else { "down" }
    $up = if ($button -eq "right") { "rup" } else { "up" }
    Send "mouse move $x $y" | Out-Null; Start-Sleep -Milliseconds 80
    Send "mouse $down $x $y" | Out-Null; Start-Sleep -Milliseconds 60
    Send "mouse $up $x $y" | Out-Null; Start-Sleep -Milliseconds 250
}
function CenterOf($control) {
    return @(($control.bounds[0] + $control.bounds[2] / 2), ($control.bounds[1] + $control.bounds[3] / 2))
}
function ClickCtrl($control, [string]$button = "") {
    $p = CenterOf $control
    ClickAt $p[0] $p[1] $button
}

$script:fails = 0
function Expect([string]$name, $actual, $expected) {
    if ($actual -ceq $expected) { Write-Output "PASS $name" }
    else { $script:fails++; Write-Output "FAIL $name : got [$actual] want [$expected]" }
}
function ExpectTrue([string]$name, [bool]$cond, [string]$detail) {
    if ($cond) { Write-Output "PASS $name" }
    else { $script:fails++; Write-Output "FAIL $name : $detail" }
}

try {
    Start-Sleep -Milliseconds 800

    # A. Chuột phải mở menu đúng vị trí chuột; mục đầu có tiêu điểm.
    $area = Ctrl "probe-context-area"
    ExpectTrue "context area has bounds" ($null -ne $area -and $null -ne $area.bounds) "không có bounds"
    $p = CenterOf $area
    ClickAt $p[0] $p[1] "right"
    $menu = Ctrl "probe-context"
    ExpectTrue "right click opens the context menu" ($null -ne $menu) "không thấy menu"
    if ($menu) {
        ExpectTrue "menu opens at the pointer (x)" ([math]::Abs($menu.bounds[0] - $p[0]) -lt 1.5) ("x menu " + $menu.bounds[0] + " chuột " + $p[0])
        ExpectTrue "menu opens at the pointer (y)" ([math]::Abs($menu.bounds[1] - $p[1]) -lt 1.5) ("y menu " + $menu.bounds[1] + " chuột " + $p[1])
    }
    Expect "first item is focused on open" (Focused) "probe-context-open"
    Expect "menu items have menuitem role" (Ctrl "probe-context-open").role "menuitem"

    # B. Mũi tên xuống bỏ qua mục khóa "Xóa" và vòng về đầu; mục "Chuyển đến" (có menu con) đứng sau "Xóa".
    Key 40
    Expect "Down moves to the second item" (Focused) "probe-context-copy"
    Key 40
    Expect "Down skips the disabled item to the submenu item" (Focused) "probe-context-more"
    Key 40
    Expect "Down wraps to the first item" (Focused) "probe-context-open"
    Key 38
    Expect "Up wraps back to the submenu item" (Focused) "probe-context-more"
    Key 38
    Expect "Up moves to the second item" (Focused) "probe-context-copy"

    # C. Enter chọn mục và đóng menu; tiêu điểm về vùng chuột phải.
    Key 13
    Start-Sleep -Milliseconds 200
    ExpectTrue "Enter closes the menu" ($null -eq (Ctrl "probe-context")) "menu vẫn mở sau Enter"
    Expect "focus returns to the area after picking" (Focused) "probe-context-area"

    # D. Esc đóng menu và trả tiêu điểm.
    ClickAt $p[0] $p[1] "right"
    ExpectTrue "menu reopens on a second right click" ($null -ne (Ctrl "probe-context")) "không mở lại"
    Key 27
    Start-Sleep -Milliseconds 200
    ExpectTrue "Esc closes the menu" ($null -eq (Ctrl "probe-context")) "menu vẫn mở sau Esc"
    Expect "focus returns to the area after Esc" (Focused) "probe-context-area"

    # E. Gõ chữ đầu nhảy tới mục ("s" tới "Sao chép"). Phím tắt hiện đúng chữ (R2.07 tiêu chí 3).
    ClickAt $p[0] $p[1] "right"
    Expect "shortcut text is exposed on the item" (Ctrl "probe-context-copy").value "Ctrl+C"
    Key 83
    Expect "typeahead S moves to Sao chép" (Focused) "probe-context-copy"
    Key 27
    Start-Sleep -Milliseconds 200

    # F. Bấm ra ngoài đóng menu.
    ClickAt $p[0] $p[1] "right"
    ExpectTrue "menu is open before the outside click" ($null -ne (Ctrl "probe-context")) "menu không mở"
    ClickAt 20 20
    Start-Sleep -Milliseconds 200
    ExpectTrue "click outside closes the menu" ($null -eq (Ctrl "probe-context")) "menu vẫn mở sau khi bấm ra ngoài"

    # F2. Mục có menu con (R2.07): phải mở, trái và Esc đóng menu con và trả tiêu điểm về mục cha.
    ClickAt $p[0] $p[1] "right"
    Key 40
    Key 40
    Expect "focus reaches the submenu item" (Focused) "probe-context-more"
    ExpectTrue "submenu items are hidden until opened" ($null -eq (Ctrl "probe-context-first")) "mục con hiện sẵn"
    Key 39
    Expect "Right opens the submenu and focuses its first item" (Focused) "probe-context-first"
    ExpectTrue "submenu items are shown" ($null -ne (Ctrl "probe-context-last")) "không thấy mục con"
    Key 40
    Expect "Down moves inside the submenu" (Focused) "probe-context-last"
    Key 38
    Expect "Up moves back to the first submenu item" (Focused) "probe-context-first"
    Key 37
    Expect "Left closes the submenu and returns focus to its parent" (Focused) "probe-context-more"
    ExpectTrue "submenu closed after Left" ($null -eq (Ctrl "probe-context-first")) "menu con vẫn mở sau Left"
    Key 39
    Expect "Right reopens the submenu" (Focused) "probe-context-first"
    Key 27
    Start-Sleep -Milliseconds 150
    ExpectTrue "Esc closes only the submenu" ($null -eq (Ctrl "probe-context-first") -and $null -ne (Ctrl "probe-context")) "Esc không đóng đúng menu con"
    Expect "focus returns to the parent after Esc" (Focused) "probe-context-more"
    Key 27
    Start-Sleep -Milliseconds 200
    ExpectTrue "second Esc closes the menu" ($null -eq (Ctrl "probe-context")) "menu vẫn mở sau Esc thứ hai"
    Expect "focus returns to the area after closing" (Focused) "probe-context-area"

    # F3. Enter trên mục con chọn mục đó và đóng menu; lần mở sau menu con đóng sẵn.
    ClickAt $p[0] $p[1] "right"
    Key 40
    Key 40
    Key 39
    Key 13
    Start-Sleep -Milliseconds 200
    ExpectTrue "Enter on a submenu item closes the menu" ($null -eq (Ctrl "probe-context")) "menu vẫn mở sau Enter ở mục con"
    Expect "focus returns to the area after picking a submenu item" (Focused) "probe-context-area"
    ClickAt $p[0] $p[1] "right"
    ExpectTrue "submenu starts closed on the next open" ($null -eq (Ctrl "probe-context-first")) "menu con còn mở từ lần trước"
    Key 27
    Start-Sleep -Milliseconds 200

    # G. Ô chọn: Tab tới, Enter mở, mục đang chọn có tiêu điểm.
    for ($i = 0; $i -lt 90 -and (Focused) -ne "probe-select"; $i++) { Key 9 }
    Expect "Tab reaches the select trigger" (Focused) "probe-select"
    Expect "select exposes its value" (Ctrl "probe-select").value "Tiếng Việt"
    Key 13
    Start-Sleep -Milliseconds 200
    ExpectTrue "Enter opens the select list" ($null -ne (Ctrl "probe-select-menu")) "không thấy danh sách"
    Expect "list opens with the selected item focused" (Focused) "probe-select-opt-0"
    Expect "selected item shows checked" (Ctrl "probe-select-opt-0").checked "true"

    # H. Mũi tên trong danh sách có vòng lại; gõ "e" nhảy tới English.
    Key 40
    Expect "Down moves to the second option" (Focused) "probe-select-opt-1"
    Key 40
    Expect "Down reaches the third option" (Focused) "probe-select-opt-2"
    Key 40
    Expect "Down wraps to the first option" (Focused) "probe-select-opt-0"
    Key 69
    Expect "typeahead E moves to English" (Focused) "probe-select-opt-1"

    # I. Enter chọn English: danh sách đóng, nút hiện English, tiêu điểm về nút.
    Key 13
    Start-Sleep -Milliseconds 250
    ExpectTrue "picking closes the list" ($null -eq (Ctrl "probe-select-menu")) "danh sách vẫn mở"
    Expect "select shows the picked label" (Ctrl "probe-select").value "English"
    Expect "focus returns to the trigger" (Focused) "probe-select"

    # J. Enter mở lại, Esc đóng, giá trị giữ nguyên.
    Key 13
    Start-Sleep -Milliseconds 200
    Key 27
    Start-Sleep -Milliseconds 200
    ExpectTrue "Esc closes the list" ($null -eq (Ctrl "probe-select-menu")) "danh sách vẫn mở sau Esc"
    Expect "value unchanged after Esc" (Ctrl "probe-select").value "English"

    # K. Bấm nút mở; bấm nút lần nữa đóng (không mở lại); bấm ra ngoài đóng.
    $trigger = Ctrl "probe-select"
    ClickCtrl $trigger
    ExpectTrue "click on the trigger opens the list" ($null -ne (Ctrl "probe-select-menu")) "bấm nút không mở"
    ClickCtrl $trigger
    Start-Sleep -Milliseconds 200
    ExpectTrue "second click on the trigger closes the list" ($null -eq (Ctrl "probe-select-menu")) "bấm nút lần hai vẫn mở"
    ClickCtrl $trigger
    ExpectTrue "third click reopens" ($null -ne (Ctrl "probe-select-menu")) "không mở lại"
    ClickAt 20 20
    Start-Sleep -Milliseconds 200
    ExpectTrue "click outside closes the list" ($null -eq (Ctrl "probe-select-menu")) "danh sách vẫn mở sau khi bấm ra ngoài"

    # L. Chọn bằng chuột: mở, bấm mục "Français".
    ClickCtrl $trigger
    Start-Sleep -Milliseconds 200
    $pick = Ctrl "probe-select-opt-2"
    if ($pick -and $pick.bounds) { ClickCtrl $pick }
    Start-Sleep -Milliseconds 200
    ExpectTrue "mouse pick closes the list" ($null -eq (Ctrl "probe-select-menu")) "danh sách vẫn mở sau khi bấm mục"
}
finally {
    Send "quit" | Out-Null
    Start-Sleep -Milliseconds 300
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
Write-Output ("FAILS: " + $script:fails)
if ($script:fails -gt 0) { exit 1 }
