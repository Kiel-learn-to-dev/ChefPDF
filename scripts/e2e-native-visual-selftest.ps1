param(
  [switch]$SelfTestOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifestRoot = Join-Path $repoRoot 'tests/visual/native-refs'

function Get-ManifestItems {
  param([Parameter(Mandatory)][string]$ManifestPath)
  $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  $items = @($(if ($manifest.files) { $manifest.files } else { $manifest.images }))
  if ($items.Count -eq 0) { throw "Manifest has no image entries: $ManifestPath" }
  return ,$items
}

function Resolve-ReferencePath {
  param(
    [Parameter(Mandatory)][string]$ManifestPath,
    [Parameter(Mandatory)]$Item,
    [Parameter(Mandatory)][string]$RefsRoot
  )
  $name = [string]$Item.file
  if ([IO.Path]::IsPathRooted($name) -or $name -match '(^|[\\/])\.\.([\\/]|$)') {
    throw "Manifest entry escapes reference root: $name"
  }
  if ([IO.Path]::GetFileName($ManifestPath) -eq 'ui-audit-manifest.json') {
    $theme = [string]$Item.theme
    if ($theme -notin @('light', 'dark')) { throw "Unsupported or missing ui-audit theme for ${name}: $theme" }
    return Join-Path (Join-Path $RefsRoot "ui-audit-$theme") $name
  }
  return Join-Path $RefsRoot $name
}

function Test-VisualManifest {
  param(
    [Parameter(Mandatory)][string]$ManifestPath,
    [Parameter(Mandatory)][string]$RefsRoot
  )
  $items = Get-ManifestItems -ManifestPath $ManifestPath
  $checkedPaths = [Collections.Generic.List[string]]::new()
  $missingPaths = [Collections.Generic.List[string]]::new()
  foreach ($item in $items) {
    $path = Resolve-ReferencePath -ManifestPath $ManifestPath -Item $item -RefsRoot $RefsRoot
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      $missingPaths.Add($path)
      continue
    }
    $file = Get-Item -LiteralPath $path
    if ($null -ne $item.bytes -and [long]$item.bytes -ne $file.Length) {
      throw "Size mismatch for $($item.file): expected $($item.bytes), got $($file.Length)"
    }
    $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne ([string]$item.sha256).ToLowerInvariant()) {
      throw "SHA-256 mismatch for $($item.file) ($($item.theme))"
    }
    if ($null -ne $item.width -and $null -ne $item.height) {
      $bytes = [IO.File]::ReadAllBytes($path)
      if ($bytes.Length -lt 24 -or [Text.Encoding]::ASCII.GetString($bytes, 1, 3) -ne 'PNG') {
        throw "Expected PNG for dimension check: $($item.file)"
      }
      $width = [System.Buffers.Binary.BinaryPrimitives]::ReadInt32BigEndian($bytes.AsSpan(16, 4))
      $height = [System.Buffers.Binary.BinaryPrimitives]::ReadInt32BigEndian($bytes.AsSpan(20, 4))
      if ($width -ne [int]$item.width -or $height -ne [int]$item.height) {
        throw "PNG dimensions mismatch for $($item.file): expected $($item.width)x$($item.height), got ${width}x${height}"
      }
    }
    $checkedPaths.Add($path)
  }
  return [pscustomobject]@{
    CheckedPaths = @($checkedPaths.ToArray())
    MissingPaths = @($missingPaths.ToArray())
  }
}

function Invoke-ReferenceResolverFixtureTest {
  $fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) "chef-visual-resolver-$([guid]::NewGuid().ToString('N'))"
  try {
    $lightDir = Join-Path $fixtureRoot 'ui-audit-light'
    $darkDir = Join-Path $fixtureRoot 'ui-audit-dark'
    New-Item -ItemType Directory -Path $lightDir, $darkDir -Force | Out-Null
    $lightBytes = [Text.Encoding]::UTF8.GetBytes('unique light fixture image')
    $darkBytes = [Text.Encoding]::UTF8.GetBytes('unique dark fixture image')
    [IO.File]::WriteAllBytes((Join-Path $lightDir 'same.png'), $lightBytes)
    [IO.File]::WriteAllBytes((Join-Path $darkDir 'same.png'), $darkBytes)
    $lightHash = (Get-FileHash (Join-Path $lightDir 'same.png') -Algorithm SHA256).Hash.ToLowerInvariant()
    $darkHash = (Get-FileHash (Join-Path $darkDir 'same.png') -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($lightHash -eq $darkHash) { throw 'Fixture themes must have different image content and hashes.' }
    $fixtureManifest = Join-Path $fixtureRoot 'ui-audit-manifest.json'
    @{
      images = @(
        @{ file = 'same.png'; theme = 'light'; bytes = $lightBytes.Length; sha256 = $lightHash },
        @{ file = 'same.png'; theme = 'dark'; bytes = $darkBytes.Length; sha256 = $darkHash }
      )
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $fixtureManifest -Encoding utf8
    $result = Test-VisualManifest -ManifestPath $fixtureManifest -RefsRoot $fixtureRoot
    if ($result.CheckedPaths.Count -ne 2 -or $result.MissingPaths.Count -ne 0) {
      throw "Theme resolver fixture expected 2 verified paths, got $($result.CheckedPaths.Count)."
    }
    if ($result.CheckedPaths[0] -eq $result.CheckedPaths[1] -or
        $result.CheckedPaths -notcontains (Join-Path $lightDir 'same.png') -or
        $result.CheckedPaths -notcontains (Join-Path $darkDir 'same.png')) {
      throw 'Theme resolver fixture did not resolve duplicate basenames to separate theme folders.'
    }
    Write-Host 'Theme resolver fixture: 2 same-name files, different hashes, both verified.'
  } finally {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host 'Running visual comparator self-test...'
Push-Location (Join-Path $repoRoot 'apps/native')
try {
  cargo test -p chef-testkit
} finally {
  Pop-Location
}
if ($LASTEXITCODE -ne 0) { throw "chef-testkit self-test failed ($LASTEXITCODE)" }
Invoke-ReferenceResolverFixtureTest
if ($SelfTestOnly) { exit 0 }

# Keep references under a stable user data directory. Do not use %TEMP%, which Windows may clean.
if ($env:CHEF_VISUAL_REFS) {
  $refsRoot = [IO.Path]::GetFullPath($env:CHEF_VISUAL_REFS)
} elseif ($env:LOCALAPPDATA) {
  $refsRoot = Join-Path $env:LOCALAPPDATA 'ChefPDF/visual-refs'
} else {
  $refsRoot = Join-Path $HOME '.local/share/chef-pdf/visual-refs'
}
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$fullRefs = [IO.Path]::GetFullPath($refsRoot)
$repoPath = [IO.Path]::GetFullPath($repoRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$refsPath = $fullRefs.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$isWithin = {
  param([string]$Path, [string]$Root)
  $Path.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or
    $Path.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    $Path.StartsWith($Root + [IO.Path]::AltDirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}
if (& $isWithin $refsPath $tempRoot) {
  throw "CHEF_VISUAL_REFS must be outside the temporary directory: $fullRefs"
}
if (& $isWithin $refsPath $repoPath) {
  throw "CHEF_VISUAL_REFS must be outside the repository: $fullRefs"
}

$manifests = @(
  (Join-Path $manifestRoot 'manifest.json'),
  (Join-Path $manifestRoot 'ui-audit-manifest.json')
)
$checked = 0
$missing = [Collections.Generic.List[string]]::new()
foreach ($manifestPath in $manifests) {
  $result = Test-VisualManifest -ManifestPath $manifestPath -RefsRoot $fullRefs
  $checked += $result.CheckedPaths.Count
  foreach ($path in $result.MissingPaths) { $missing.Add($path) }
}

Write-Host "CHEF_VISUAL_REFS: $fullRefs"
Write-Host "Verified references: $checked"
if ($missing.Count -gt 0) {
  Write-Host "Missing references: $($missing.Count)"
  $missing | Select-Object -First 12 | ForEach-Object { Write-Host "  $_" }
  throw 'Reference corpus is incomplete. Copy the Electron reference files to CHEF_VISUAL_REFS and rerun.'
}
Write-Host 'Visual self-test and reference manifest verification passed.'
