#requires -Version 7.0
<#
.SYNOPSIS
  Render deterministic thumbnail shimmer frames and capture an external visual artifact.
.DESCRIPTION
  Uses the existing CHEF_E2E_PROBE window with fixed animation phases 0 and 0.5 plus a reduced
  motion frame. The output stays outside the repository and system temporary directory.
#>
[CmdletBinding()]
param(
    [string]$Exe,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
if (-not $Exe) { $Exe = Join-Path $repo 'apps\native\target\debug\chef-app.exe' }
$Exe = (Resolve-Path -LiteralPath $Exe).Path
if (-not $OutputDirectory) {
    if (-not $env:LOCALAPPDATA) { throw 'Pass OutputDirectory or set LOCALAPPDATA.' }
    $OutputDirectory = Join-Path $env:LOCALAPPDATA 'ChefPDF/visual-candidates/R4.01/thumbnail-shimmer'
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if ($OutputDirectory.Equals($repo, [StringComparison]::OrdinalIgnoreCase) -or
    $OutputDirectory.StartsWith($repo + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $OutputDirectory.Equals($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $OutputDirectory.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputDirectory must be outside the repository and system temporary directory.'
}

$previous = $env:CHEF_E2E_PROBE_THUMBNAIL_SHIMMER
$capturePath = Join-Path $OutputDirectory 'probe_light_w800.bmp'
$indexPath = Join-Path $OutputDirectory 'capture-index.json'
Remove-Item -LiteralPath $capturePath, $indexPath -Force -ErrorAction SilentlyContinue
$captureError = $null
try {
    $env:CHEF_E2E_PROBE_THUMBNAIL_SHIMMER = '1'
    & (Join-Path $PSScriptRoot 'capture-native-probes.ps1') `
        -Exe $Exe -OutputDirectory $OutputDirectory -Widths @(800) -Themes @('light')
} catch {
    # The existing runner writes its WGC BMP before trying to crop the client area. For this
    # fixed, single-window probe, retain that durable raw frame even if DWM reports bad offscreen
    # frame coordinates during the optional crop step.
    $captureError = $_.Exception.Message
    if ($captureError -notmatch 'Client box .* outside capture' -or
        -not (Test-Path -LiteralPath $capturePath -PathType Leaf)) {
        throw
    }
} finally {
    if ($null -eq $previous) { Remove-Item Env:CHEF_E2E_PROBE_THUMBNAIL_SHIMMER -ErrorAction SilentlyContinue }
    else { $env:CHEF_E2E_PROBE_THUMBNAIL_SHIMMER = $previous }
}

if (-not (Test-Path -LiteralPath $capturePath -PathType Leaf)) {
    throw "WGC did not produce the shimmer BMP. $captureError"
}
Add-Type -AssemblyName System.Drawing
$bitmap = [System.Drawing.Bitmap]::FromFile($capturePath)
try { $widthPx = $bitmap.Width; $heightPx = $bitmap.Height } finally { $bitmap.Dispose() }
$hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($capturePath))).Replace('-', '').ToLowerInvariant()
$index = [pscustomobject]@{
    generatedAt = [DateTime]::UtcNow.ToString('o')
    source = 'Chef PDF native shimmer probe; raw WGC frame, no DWM crop'
    visualOnly = $true
    captures = @([pscustomobject]@{
        name = 'probe_light_w800'
        logicalWidth = 800
        widthPx = $widthPx
        heightPx = $heightPx
        format = 'bmp'
        cropped = $false
        frames = @('phase-0.0', 'phase-0.5', 'reduced-motion-static')
        file = [IO.Path]::GetFileName($capturePath)
        sha256 = $hash
    })
}
$index | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $indexPath -Encoding utf8
Write-Output "PASS deterministic shimmer capture: $capturePath (${widthPx}x${heightPx})"
if ($captureError) { Write-Output "NOTE raw frame kept; optional client crop failed: $captureError" }
