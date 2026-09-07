[CmdletBinding()]
param(
  [string]$BenchmarkRoot = 'C:\RDC-Benchmark',
  [Parameter(Mandatory=$true)][string]$LauncherPath
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($BenchmarkRoot).TrimEnd('\')
$launcher = [IO.Path]::GetFullPath($LauncherPath)
$testControl = $env:RDC_AB_TEST_CONTROL_DIRECTORY
if ($testControl) {
  if ($env:RDC_AB_ENABLE_TEST_CONTROL -ne '1') { throw 'Install test control is disabled' }
  $testControl = [IO.Path]::GetFullPath($testControl)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  if (-not $testControl.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Install test control directory must be beneath the OS temp directory' }
  if (-not (Test-Path -LiteralPath $testControl -PathType Container)) { throw 'Install test control directory is missing' }
}

function Get-IdentityScopedMutexName([string]$Prefix) {
  $windowsIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try { $identitySid = $windowsIdentity.User.Value }
  finally { $windowsIdentity.Dispose() }
  if (-not $identitySid) { throw 'Unable to resolve the remote-device user identity' }
  $name = $Prefix + ($identitySid -replace '[^A-Za-z0-9_.-]', '_')
  if ($testControl) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
      $controlBytes = [Text.Encoding]::UTF8.GetBytes($testControl.ToLowerInvariant())
      $controlHash = ([BitConverter]::ToString($hasher.ComputeHash($controlBytes))).Replace('-', '').Substring(0, 16)
      $name += ".Test.$controlHash"
    } finally { $hasher.Dispose() }
  }
  return "Global\$name"
}

$sourceSupervisor = Join-Path $PSScriptRoot 'Run-RdcAbSupervisor.ps1'
if (-not (Test-Path -LiteralPath $sourceSupervisor -PathType Leaf)) { throw 'Supervisor source script is missing' }
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Launcher is missing: $launcher" }

function Test-Supervisor([string]$ScriptPath) {
  $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath -BenchmarkRoot $root -ValidateOnly 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Supervisor validation failed: $($output -join ' ')" }
  try { return (($output -join "`n") | ConvertFrom-Json) }
  catch { throw 'Supervisor validation did not return JSON' }
}

$validated = Test-Supervisor $sourceSupervisor
if ($validated.variant -notin @('clean','prototype')) { throw 'Supervisor returned an invalid variant' }
$hostDir = Join-Path $root 'host'
New-Item -ItemType Directory -Path $hostDir -Force | Out-Null
$installedSupervisor = Join-Path $hostDir 'Run-RdcAbSupervisor.ps1'
$supervisorTemp = "$installedSupervisor.tmp-$PID-$([guid]::NewGuid().ToString('N'))"
Copy-Item -LiteralPath $sourceSupervisor -Destination $supervisorTemp -Force
try { Move-Item -LiteralPath $supervisorTemp -Destination $installedSupervisor -Force }
finally { Remove-Item -LiteralPath $supervisorTemp -Force -ErrorAction SilentlyContinue }
$null = Test-Supervisor $installedSupervisor

$mutationMutex = [Threading.Mutex]::new($false, (Get-IdentityScopedMutexName 'OpenAI.DesktopCommander.RdcAbLauncherMutation.'))
$ownsMutationMutex = $false
try {
  try { $ownsMutationMutex = $mutationMutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $ownsMutationMutex = $true }
  if (-not $ownsMutationMutex) { throw 'RDC A/B launcher mutation is already active' }

  if ($testControl -and (Test-Path -LiteralPath (Join-Path $testControl 'hold-install') -PathType Leaf)) {
    [IO.File]::WriteAllText((Join-Path $testControl 'install-ready'), '')
    while (-not (Test-Path -LiteralPath (Join-Path $testControl 'install-release') -PathType Leaf)) { Start-Sleep -Milliseconds 25 }
  }

  $backup = "$launcher.rdc-ab-original"
  if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
    [IO.File]::WriteAllBytes($backup, [IO.File]::ReadAllBytes($launcher))
  }

  $delegator = @(
    '@echo off',
    'setlocal',
    ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $installedSupervisor + '" -BenchmarkRoot "' + $root + '"'),
    'exit /b %errorlevel%'
  ) -join "`r`n"
  $delegator += "`r`n"
  $tempLauncher = "$launcher.tmp-$PID-$([guid]::NewGuid().ToString('N'))"
  [IO.File]::WriteAllText($tempLauncher, $delegator, [Text.Encoding]::ASCII)
  try { Move-Item -LiteralPath $tempLauncher -Destination $launcher -Force }
  finally { Remove-Item -LiteralPath $tempLauncher -Force -ErrorAction SilentlyContinue }
} finally {
  try { if ($ownsMutationMutex) { $mutationMutex.ReleaseMutex() } }
  finally { $mutationMutex.Dispose() }
}
Write-Output "Installed RDC A/B delegator: $launcher"
