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

function Read-AllStreamBytes([IO.Stream]$Stream) {
  $Stream.Position = 0
  $buffer = New-Object byte[] $Stream.Length
  $offset = 0
  while ($offset -lt $buffer.Length) {
    $read = $Stream.Read($buffer, $offset, $buffer.Length - $offset)
    if ($read -le 0) { throw 'Unexpected end of stream while reading launcher bytes' }
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

function Test-Supervisor([string]$ScriptPath) {
  $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath -BenchmarkRoot $root -ValidateOnly 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Supervisor validation failed: $($output -join ' ')" }
  try { return (($output -join "`n") | ConvertFrom-Json) }
  catch { throw 'Supervisor validation did not return JSON' }
}

$sourceSupervisor = Join-Path $PSScriptRoot 'Run-RdcAbSupervisor.ps1'
$sourceAclHelper = Join-Path $PSScriptRoot 'RdcAbAcl.ps1'
if (-not (Test-Path -LiteralPath $sourceSupervisor -PathType Leaf)) { throw 'Supervisor source script is missing' }
if (-not (Test-Path -LiteralPath $sourceAclHelper -PathType Leaf)) { throw 'ACL helper source script is missing' }
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Launcher is missing: $launcher" }
. $sourceAclHelper
[void](Assert-RdcAbProtectedRootAcl $root)

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

  $validated = Test-Supervisor $sourceSupervisor
  if ($validated.variant -notin @('clean','prototype')) { throw 'Supervisor returned an invalid variant' }

  $hostDir = Join-Path $root 'host'
  $installedSupervisor = Join-Path $hostDir 'Run-RdcAbSupervisor.ps1'
  $installedAclHelper = Join-Path $hostDir 'RdcAbAcl.ps1'
  $metadataPath = Join-Path $hostDir 'launcher-install.json'
  $backup = "$launcher.rdc-ab-original"
  $backupExists = Test-Path -LiteralPath $backup -PathType Leaf
  $metadataExists = Test-Path -LiteralPath $metadataPath -PathType Leaf
  if ($backupExists -ne $metadataExists) {
    throw 'Launcher backup is not authenticated by benchmark install metadata'
  }

  if ($backupExists) {
    [void](Assert-RdcAbInheritedChildAcl $root $metadataPath 'RDC A/B launcher install metadata')
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
  } else {
    New-Item -ItemType Directory -Path $hostDir -Force | Out-Null
    [void](Assert-RdcAbInheritedChildAcl $root $hostDir 'RDC A/B host directory')
    $launcherStream = [IO.File]::Open($launcher, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { $backupBytes = Read-AllStreamBytes $launcherStream }
    finally { $launcherStream.Dispose() }
    $backupStream = [IO.File]::Open($backup, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $backupStream.Write($backupBytes, 0, $backupBytes.Length)
      $backupStream.Flush($true)
    } finally { $backupStream.Dispose() }
    $metadata = [ordered]@{
      schemaVersion = 1
      launcherPath = $launcher
      backupSha256 = Get-BytesSha256 $backupBytes
    }
    $metadataTemp = "$metadataPath.tmp-$PID-$([guid]::NewGuid().ToString('N'))"
    $metadataBytes = [Text.Encoding]::UTF8.GetBytes(($metadata | ConvertTo-Json -Compress))
    $metadataStream = [IO.File]::Open($metadataTemp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $metadataStream.Write($metadataBytes, 0, $metadataBytes.Length)
      $metadataStream.Flush($true)
    } finally { $metadataStream.Dispose() }
    try { [IO.File]::Move($metadataTemp, $metadataPath) }
    finally { Remove-Item -LiteralPath $metadataTemp -Force -ErrorAction SilentlyContinue }
    [void](Assert-RdcAbInheritedChildAcl $root $metadataPath 'RDC A/B launcher install metadata')
  }

  New-Item -ItemType Directory -Path $hostDir -Force | Out-Null
  [void](Assert-RdcAbInheritedChildAcl $root $hostDir 'RDC A/B host directory')
  $aclTemp = "$installedAclHelper.tmp-$PID-$([guid]::NewGuid().ToString('N'))"
  Copy-Item -LiteralPath $sourceAclHelper -Destination $aclTemp -Force
  try { Move-Item -LiteralPath $aclTemp -Destination $installedAclHelper -Force }
  finally { Remove-Item -LiteralPath $aclTemp -Force -ErrorAction SilentlyContinue }
  $supervisorTemp = "$installedSupervisor.tmp-$PID-$([guid]::NewGuid().ToString('N'))"
  Copy-Item -LiteralPath $sourceSupervisor -Destination $supervisorTemp -Force
  try { Move-Item -LiteralPath $supervisorTemp -Destination $installedSupervisor -Force }
  finally { Remove-Item -LiteralPath $supervisorTemp -Force -ErrorAction SilentlyContinue }
  [void](Assert-RdcAbInheritedChildAcl $root $installedAclHelper 'RDC A/B installed ACL helper')
  [void](Assert-RdcAbInheritedChildAcl $root $installedSupervisor 'RDC A/B installed supervisor')
  $null = Test-Supervisor $installedSupervisor

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