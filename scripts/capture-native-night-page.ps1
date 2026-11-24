<#
Export the native page-1 raster in day and night mode for R2.28 (page bitmap, not a window crop).
Uses the debug command `exportpage` (BMP, BGRA -> written as BMP) and the `togglenight` action.
Output goes outside the repository and %TEMP%; BMP files are converted to PNG by core (Pillow).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$Pdf,
    [Parameter(Mandatory = $true)] [string]$OutputDirectory,
    [string]$Exe,
    [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
if (-not $Exe) { $Exe = Join-Path $PSScriptRoot '..\apps\native\target\debug\chef-app.exe' }
$Exe = (Resolve-Path -LiteralPath $Exe).Path
$Pdf = (Resolve-Path -LiteralPath $Pdf).Path
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd([IO.Path]::DirectorySeparatorChar)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
foreach ($root in @($repoRoot, $tempRoot)) {
    if ($OutputDirectory.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or
        $OutputDirectory.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "OutputDirectory must be outside the repository and temporary directory: $OutputDirectory"
    }
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

function Send([string]$Command) {
    $client = [IO.Pipes.NamedPipeClientStream]::new('.', $script:pipe, [IO.Pipes.PipeDirection]::InOut)
    try {
        $client.Connect(5000)
        $writer = [IO.StreamWriter]::new($client, [Text.UTF8Encoding]::new($false))
        $writer.AutoFlush = $true
        $reader = [IO.StreamReader]::new($client, [Text.UTF8Encoding]::new($false))
        $writer.WriteLine("$script:token $Command")
        $line = $reader.ReadLine()
        if (-not $line -and $Command -eq 'quit') { return }
        if (-not $line) { throw "No response to '$Command'." }
        return $line | ConvertFrom-Json
    } finally { $client.Dispose() }
}

$work = Join-Path $env:TEMP ("chef-native-night-page-" + [guid]::NewGuid().ToString('N'))
$userData = Join-Path $work 'userdata'
New-Item -ItemType Directory -Path $userData -Force | Out-Null
$settings = @{ version = 1; language = 'vi'; theme = 'light'; defaultSaveDir = $work; recentFiles = @() }
[IO.File]::WriteAllText((Join-Path $userData 'settings.json'), ($settings | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
$log = Join-Path $work 'app.log'
$saved = @{ E2E = $env:CHEF_E2E; UserData = $env:CHEF_USER_DATA_DIR }
$proc = $null
$script:pipe = $null; $script:token = $null
try {
    $env:CHEF_E2E = '1'
    $env:CHEF_USER_DATA_DIR = $userData
    try { $proc = Start-Process -FilePath $Exe -ArgumentList @("`"$Pdf`"") -PassThru -RedirectStandardError $log -WindowStyle Hidden }
    finally {
        if ($null -eq $saved.E2E) { Remove-Item Env:CHEF_E2E -ErrorAction SilentlyContinue } else { $env:CHEF_E2E = $saved.E2E }
        if ($null -eq $saved.UserData) { Remove-Item Env:CHEF_USER_DATA_DIR -ErrorAction SilentlyContinue } else { $env:CHEF_USER_DATA_DIR = $saved.UserData }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $ready = $false
    do {
        if ($proc.HasExited) { throw "chef-app exited ($($proc.ExitCode)): $log" }
        if (Test-Path -LiteralPath $log) {
            $text = [string](Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue)
            $script:pipe = [regex]::Match($text, 'chef-native-\d+').Value
            $script:token = [regex]::Match($text, 'CHEF_DEBUG_TOKEN=([0-9a-f]+)').Groups[1].Value
            if ($script:pipe -and $script:token) {
                try {
                    $state = Send 'state'
                    if ($null -ne $state.view -and [int]$state.cached -gt 0 -and [int]$state.pending -eq 0) { $ready = $true; break }
                } catch { }
            }
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $ready) { throw "Viewer did not render within ${TimeoutSeconds}s: $log" }

    $dayBmp = Join-Path $OutputDirectory 'native_r228_day.bmp'
    $nightBmp = Join-Path $OutputDirectory 'native_r228_night.bmp'
    $day = Send "exportpage 0 $dayBmp"
    if (-not $day.ok) { throw "exportpage (day) failed: $($day.error)" }
    if ($day.night -ne $false) { throw "day export reports night=$($day.night)" }

    Send 'action togglenight' | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 200
        $state = Send 'state'
    } while (-not $state.view.night -and [DateTime]::UtcNow -lt $deadline)
    if (-not $state.view.night) { throw 'night mode did not turn on' }

    $night = Send "exportpage 0 $nightBmp"
    if (-not $night.ok) { throw "exportpage (night) failed: $($night.error)" }
    if ($night.night -ne $true) { throw "night export reports night=$($night.night)" }
    Write-Output "EXPORTED day=$($day.width)x$($day.height) night=$($night.width)x$($night.height) zoom=$($night.zoom)"

    Send 'quit' | Out-Null
    $proc.WaitForExit(10000) | Out-Null
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
