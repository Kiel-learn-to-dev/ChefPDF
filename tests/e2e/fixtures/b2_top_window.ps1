# B2 helper (PLAN_V1_1 §2): shows a small TopMost window over the top strip of the Chef window, so
# Chef is not the active window while the wheel is sent. Runs until the stop file exists.
# Usage: pwsh -File b2_top_window.ps1 -X 100 -Y 100 -W 380 -H 56 -Stop C:\path\stop.flag
param([int]$X, [int]$Y, [int]$W, [int]$H, [string]$Stop)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'ChefPDF B2 test window'
$form.FormBorderStyle = 'FixedToolWindow'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.Size = New-Object System.Drawing.Size($W, $H)
$form.TopMost = $true
$form.Show()
$form.Activate()
while (-not (Test-Path $Stop)) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 100
}
$form.Close()
