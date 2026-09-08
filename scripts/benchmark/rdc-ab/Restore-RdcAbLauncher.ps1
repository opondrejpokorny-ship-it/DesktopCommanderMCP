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

function Read-AllStreamBytes([IO.Stream]$Stream) {
  $Stream.Position = 0
  $buffer = New-Object byte[] $Stream.Length
  $offset = 0
  while ($offset -lt $buffer.Length) {
    $read = $Stream.Read($buffer, $offset, $buffer.Length - $offset)
    if ($read -le 0) { throw 'Unexpected end of stream while reading launcher backup' }
    $offset += $read
  }
  $Stream.Position = 0
  return $buffer
}

function Get-BytesSha256([byte[]]$Bytes) {
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $hasher.Dispose() }
}

$hostDir = Join-Path $root 'host'
$installedSupervisor = Join-Path $hostDir 'Run-RdcAbSupervisor.ps1'
$installedAclHelper = Join-Path $hostDir 'RdcAbAcl.ps1'
$metadataPath = Join-Path $hostDir 'launcher-install.json'
$sourceAclHelper = Join-Path $PSScriptRoot 'RdcAbAcl.ps1'
$backup = "$launcher.rdc-ab-original"
if (-not (Test-Path -LiteralPath $sourceAclHelper -PathType Leaf)) { throw 'Trusted ACL helper is missing' }
if (-not (Test-Path -LiteralPath $installedSupervisor -PathType Leaf)) { throw 'Installed RDC A/B supervisor is missing' }
if (-not (Test-Path -LiteralPath $installedAclHelper -PathType Leaf)) { throw 'Installed RDC A/B ACL helper is missing' }
if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) { throw 'Launcher install metadata is missing' }
if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) { throw "Original launcher backup is missing: $backup" }
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Installed launcher is missing' }
. $sourceAclHelper

$mutationMutex = [Threading.Mutex]::new($false, (Get-IdentityScopedMutexName 'OpenAI.DesktopCommander.RdcAbLauncherMutation.'))
$ownsMutationMutex = $false
try {
  try { $ownsMutationMutex = $mutationMutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $ownsMutationMutex = $true }
  if (-not $ownsMutationMutex) { throw 'RDC A/B launcher mutation is already active' }

  [void](Assert-RdcAbProtectedRootAcl $root)
  [void](Assert-RdcAbInheritedChildAcl $root $hostDir 'RDC A/B host directory')
  [void](Assert-RdcAbInheritedChildAcl $root $installedAclHelper 'RDC A/B installed ACL helper')
  [void](Assert-RdcAbInheritedChildAcl $root $installedSupervisor 'RDC A/B installed supervisor')
  [void](Assert-RdcAbInheritedChildAcl $root $metadataPath 'RDC A/B launcher install metadata')

  $activePath = Join-Path $root 'active-variant.txt'
  if (-not (Test-Path -LiteralPath $activePath -PathType Leaf)) { throw 'Active variant pointer is missing' }
  $active = (Get-Content -Raw -LiteralPath $activePath).Trim()
  if ($active -ne 'prototype') { throw 'Rollback requires prototype to be selected' }

  $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installedSupervisor -BenchmarkRoot $root -ValidateOnly 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Prototype validation failed: $($output -join ' ')" }
  try { $validated = ($output -join "`n") | ConvertFrom-Json }
  catch { throw 'Prototype validation did not return JSON' }
  if ($validated.variant -ne 'prototype') { throw 'Rollback validation did not resolve prototype' }

  try { $metadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json }
  catch { throw 'Launcher install metadata is invalid' }
  if ([int]$metadata.schemaVersion -ne 1 -or -not ([string]$metadata.launcherPath).Equals($launcher, [StringComparison]::OrdinalIgnoreCase) -or
      [string]$metadata.backupSha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw 'Launcher install metadata does not authenticate this launcher backup'
  }
  $backupStream = [IO.File]::Open($backup, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try { $backupBytes = Read-AllStreamBytes $backupStream }
  finally { $backupStream.Dispose() }
  if (-not (Get-BytesSha256 $backupBytes).Equals([string]$metadata.backupSha256, [StringComparison]::Ordinal)) {
    throw 'Launcher backup digest does not match protected install metadata'
  }

  $supervisorMutex = [Threading.Mutex]::new($false, (Get-IdentityScopedMutexName 'OpenAI.DesktopCommander.RdcAbSupervisor.'))
  $ownsSupervisorMutex = $false
  try {
    try { $ownsSupervisorMutex = $supervisorMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsSupervisorMutex = $true }
    if (-not $ownsSupervisorMutex) { throw 'RDC A/B supervisor is active; restore stopped without changes' }

    $expectedDelegator = @(
      '@echo off',
      'setlocal',
      ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $installedSupervisor + '" -BenchmarkRoot "' + $root + '"'),
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
    [IO.File]::WriteAllBytes($temp, $backupBytes)
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