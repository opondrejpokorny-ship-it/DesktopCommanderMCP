[CmdletBinding()]
param(
  [string]$BenchmarkRoot = 'C:\RDC-Benchmark',
  [Parameter(Mandatory=$true)][string]$LauncherPath
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($BenchmarkRoot).TrimEnd('\')
$launcher = [IO.Path]::GetFullPath($LauncherPath)
$activePath = Join-Path $root 'active-variant.txt'
if (-not (Test-Path -LiteralPath $activePath -PathType Leaf)) { throw 'Active variant pointer is missing' }
$active = (Get-Content -Raw -LiteralPath $activePath).Trim()
if ($active -ne 'prototype') { throw 'Rollback requires prototype to be selected' }

$installedSupervisor = Join-Path $root 'host\Run-RdcAbSupervisor.ps1'
$supervisor = if (Test-Path -LiteralPath $installedSupervisor -PathType Leaf) { $installedSupervisor } else { Join-Path $PSScriptRoot 'Run-RdcAbSupervisor.ps1' }
$output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $supervisor -BenchmarkRoot $root -ValidateOnly 2>&1
if ($LASTEXITCODE -ne 0) { throw "Prototype validation failed: $($output -join ' ')" }
try { $validated = ($output -join "`n") | ConvertFrom-Json }
catch { throw 'Prototype validation did not return JSON' }
if ($validated.variant -ne 'prototype') { throw 'Rollback validation did not resolve prototype' }
$backup = "$launcher.rdc-ab-original"
if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) { throw "Original launcher backup is missing: $backup" }

$testControl = $env:RDC_AB_TEST_CONTROL_DIRECTORY
if ($testControl) {
  if ($env:RDC_AB_ENABLE_TEST_CONTROL -ne '1') { throw 'Restore test control is disabled' }
  $testControl = [IO.Path]::GetFullPath($testControl)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  if (-not $testControl.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Restore test control directory must be beneath the OS temp directory' }
  if (-not (Test-Path -LiteralPath $testControl -PathType Container)) { throw 'Restore test control directory is missing' }
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

$mutationMutex = [Threading.Mutex]::new($false, (Get-IdentityScopedMutexName 'OpenAI.DesktopCommander.RdcAbLauncherMutation.'))
$ownsMutationMutex = $false
try {
  try { $ownsMutationMutex = $mutationMutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $ownsMutationMutex = $true }
  if (-not $ownsMutationMutex) { throw 'RDC A/B launcher mutation is already active' }

  $supervisorMutex = [Threading.Mutex]::new($false, (Get-IdentityScopedMutexName 'OpenAI.DesktopCommander.RdcAbSupervisor.'))
  $ownsSupervisorMutex = $false
  try {
    try { $ownsSupervisorMutex = $supervisorMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsSupervisorMutex = $true }
    if (-not $ownsSupervisorMutex) { throw 'RDC A/B supervisor is active; restore stopped without changes' }

    $installedDelegatorSupervisor = Join-Path $root 'host\Run-RdcAbSupervisor.ps1'
    $expectedDelegator = @(
      '@echo off',
      'setlocal',
      ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $installedDelegatorSupervisor + '" -BenchmarkRoot "' + $root + '"'),
      'exit /b %errorlevel%'
    ) -join "`r`n"
    $expectedDelegator += "`r`n"
    $expectedBytes = [Text.Encoding]::ASCII.GetBytes($expectedDelegator)
    $actualBytes = [IO.File]::ReadAllBytes($launcher)
    if ($actualBytes.Length -ne $expectedBytes.Length) { throw 'Launcher is not the installed RDC A/B delegator; restore stopped without changes' }
    for ($index = 0; $index -lt $expectedBytes.Length; $index++) {
      if ($actualBytes[$index] -ne $expectedBytes[$index]) { throw 'Launcher is not the installed RDC A/B delegator; restore stopped without changes' }
    }

    $temp = "$launcher.restore-$PID-$([guid]::NewGuid().ToString('N'))"
    [IO.File]::WriteAllBytes($temp, [IO.File]::ReadAllBytes($backup))
    try { Move-Item -LiteralPath $temp -Destination $launcher -Force }
    finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
  } finally {
    try { if ($ownsSupervisorMutex) { $supervisorMutex.ReleaseMutex() } }
    finally { $supervisorMutex.Dispose() }
  }
} finally {
  try { if ($ownsMutationMutex) { $mutationMutex.ReleaseMutex() } }
  finally { $mutationMutex.Dispose() }
}
Write-Output "Restored original RDC launcher: $launcher"
