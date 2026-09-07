[CmdletBinding()]
param(
  [string]$BenchmarkRoot = 'C:\RDC-Benchmark',
  [switch]$ValidateOnly,
  [ValidateRange(1,30)][int]$RetrySeconds = 5,
  [string]$TestControlDirectory
)

$ErrorActionPreference = 'Stop'
$aclHelper = Join-Path $PSScriptRoot 'RdcAbAcl.ps1'
if (-not (Test-Path -LiteralPath $aclHelper -PathType Leaf)) { throw 'RDC A/B ACL helper is missing' }
. $aclHelper
$root = [IO.Path]::GetFullPath($BenchmarkRoot).TrimEnd('\')
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "Benchmark root missing: $root" }
[void](Assert-RdcAbProtectedRootAcl $root)
if (-not ('RdcAbNativePath' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class RdcAbNativePath {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFile(
    string name, uint access, uint share, IntPtr security, uint creation,
    uint flags, IntPtr template);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetFinalPathNameByHandle(
    SafeFileHandle handle, StringBuilder path, uint length, uint flags);

  public static string GetFinalPath(string path) {
    using (SafeFileHandle handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      StringBuilder buffer = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
      if (length == 0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      if (length >= buffer.Capacity) {
        buffer = new StringBuilder((int)length + 1);
        length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0 || length >= buffer.Capacity) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
      return buffer.ToString();
    }
  }
}
'@
}
function ConvertTo-CanonicalExistingPath([string]$Candidate, [string]$Label) {
  $full = [IO.Path]::GetFullPath($Candidate)
  if (-not (Test-Path -LiteralPath $full)) { throw "$Label does not exist: $full" }
  $canonical = [RdcAbNativePath]::GetFinalPath($full)
  if ($canonical.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
    return '\\' + $canonical.Substring(8)
  }
  if ($canonical.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
    return $canonical.Substring(4)
  }
  return $canonical
}
$canonicalRoot = ConvertTo-CanonicalExistingPath $root 'Benchmark root'
$manifestPath = Join-Path $root 'manifest.json'
$activePath = Join-Path $root 'active-variant.txt'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Benchmark manifest missing: $manifestPath" }
if (-not (Test-Path -LiteralPath $activePath -PathType Leaf)) { throw "Active variant pointer missing: $activePath" }
Assert-RdcAbInheritedChildAcl $root $manifestPath 'Benchmark manifest'
Assert-RdcAbInheritedChildAcl $root $activePath 'Active variant pointer'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1) { throw 'Unsupported benchmark schemaVersion' }
$manifestRoot = [IO.Path]::GetFullPath([string]$manifest.benchmarkRoot).TrimEnd('\')
if (-not $manifestRoot.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest benchmark root mismatch' }

function Assert-LexicallyWithinRoot([string]$Candidate, [string]$Label) {
  $full = [IO.Path]::GetFullPath($Candidate)
  $prefix = $root + '\'
  if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must stay within benchmark root"
  }
  return $full
}
function Assert-NoReparsePathWithinRoot([string]$Candidate, [string]$Label) {
  $current = $root
  $rootAttributes = [IO.File]::GetAttributes($current)
  if (($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label must not contain a symlink, junction, or reparse point"
  }
  $relative = $Candidate.Substring($root.Length).TrimStart('\')
  foreach ($part in $relative.Split('\', [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = Join-Path $current $part
    $attributes = [IO.File]::GetAttributes($current)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label must not contain a symlink, junction, or reparse point"
    }
  }
}
function Assert-CanonicallyWithinRoot([string]$CanonicalCandidate, [string]$Label) {
  $prefix = $canonicalRoot.TrimEnd('\') + '\'
  if (-not $CanonicalCandidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label real path must stay within benchmark root"
  }
  return $CanonicalCandidate
}
function Assert-CanonicalAncestorWithinRoot([string]$CanonicalCandidate, [string]$Label) {
  if ($CanonicalCandidate.Equals($canonicalRoot, [StringComparison]::OrdinalIgnoreCase)) {
    return $CanonicalCandidate
  }
  return Assert-CanonicallyWithinRoot $CanonicalCandidate $Label
}
function Assert-WithinRoot([string]$Candidate, [string]$Label) {
  $full = Assert-LexicallyWithinRoot $Candidate $Label
  Assert-NoReparsePathWithinRoot $full $Label
  return Assert-CanonicallyWithinRoot (ConvertTo-CanonicalExistingPath $full $Label) $Label
}
function Assert-StatePathWithinRoot([string]$Candidate, [string]$Label, [switch]$EnsureDirectories) {
  $full = Assert-LexicallyWithinRoot $Candidate $Label
  $parent = if ($Label -eq 'DESKTOP_COMMANDER_WORKFLOW_STATE_DIR') { $full } else { Split-Path -Parent $full }
  $existingAncestor = $parent
  while (-not (Test-Path -LiteralPath $existingAncestor)) {
    $next = Split-Path -Parent $existingAncestor
    if ([string]::IsNullOrEmpty($next) -or $next.Equals($existingAncestor, [StringComparison]::OrdinalIgnoreCase)) {
      throw "$Label has no existing parent beneath benchmark root"
    }
    $existingAncestor = $next
  }
  Assert-CanonicalAncestorWithinRoot (ConvertTo-CanonicalExistingPath $existingAncestor $Label) $Label | Out-Null
  if ($EnsureDirectories -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  if (Test-Path -LiteralPath $parent) {
    Assert-CanonicallyWithinRoot (ConvertTo-CanonicalExistingPath $parent $Label) $Label | Out-Null
  }
  if (Test-Path -LiteralPath $full) {
    Assert-CanonicallyWithinRoot (ConvertTo-CanonicalExistingPath $full $Label) $Label | Out-Null
  }
  return $full
}
function Get-RuntimeDigest([string]$Repository) {
  $rootAttributes = [IO.File]::GetAttributes($Repository)
  if (($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      ($rootAttributes -band [IO.FileAttributes]::Directory) -eq 0) {
    throw 'Runtime digest repository must be a real directory'
  }
  $files = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal)
  function Add-RuntimeDigestFiles([string]$Directory, [string]$RelativePath) {
    foreach ($child in [IO.Directory]::GetFileSystemEntries($Directory)) {
      $name = [IO.Path]::GetFileName($child)
      if ($RelativePath.Length -eq 0 -and $name -ceq '.git') { continue }
      $attributes = [IO.File]::GetAttributes($child)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Runtime digest rejects a symlink, junction, or reparse point'
      }
      $childRelative = if ($RelativePath.Length -eq 0) { $name } else { $RelativePath + '/' + $name }
      $item = Get-Item -LiteralPath $child -Force
      if ($item -is [IO.DirectoryInfo]) {
        Add-RuntimeDigestFiles $child $childRelative
      } elseif ($item -is [IO.FileInfo]) {
        $files.Add($childRelative, $child)
      } else {
        throw 'Runtime digest rejects a non-file, non-directory entry'
      }
    }
  }
  Add-RuntimeDigestFiles $Repository ''
  $relativePaths = New-Object string[] $files.Count
  $files.Keys.CopyTo($relativePaths, 0)
  [Array]::Sort($relativePaths, [StringComparer]::Ordinal)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    foreach ($relativePath in $relativePaths) {
      $filePath = $files[$relativePath]
      $attributes = [IO.File]::GetAttributes($filePath)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
          ($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
        throw 'Runtime digest rejects a symlink, junction, or reparse point'
      }
      $fileDigest = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
      $record = $relativePath + [char]0 + $fileDigest + [char]10
      $bytes = [Text.Encoding]::UTF8.GetBytes($record)
      [void]$hasher.TransformBlock($bytes, 0, $bytes.Length, $bytes, 0)
    }
    [void]$hasher.TransformFinalBlock([byte[]]@(), 0, 0)
    return ([BitConverter]::ToString($hasher.Hash)).Replace('-', '').ToLowerInvariant()
  } finally {
    $hasher.Dispose()
  }
}
function Assert-TrackedWorktreeClean([string]$Repository, [string]$Variant) {
  & git.exe -C $Repository diff --no-ext-diff --quiet HEAD --
  $status = $LASTEXITCODE
  if ($status -eq 0) { return }
  if ($status -eq 1) { throw "$Variant tracked worktree differs from HEAD" }
  throw "Unable to compare $Variant tracked worktree with HEAD"
}
function Get-ValidatedSelection {
  [void](Assert-RdcAbProtectedRootAcl $root)
  Assert-RdcAbInheritedChildAcl $root $manifestPath 'Benchmark manifest'
  Assert-RdcAbInheritedChildAcl $root $activePath 'Active variant pointer'
  $variant = (Get-Content -Raw -LiteralPath $activePath).Trim()
  if ($variant -notin @('clean','prototype')) { throw "Unknown active benchmark variant: $variant" }
  $entry = $manifest.variants.$variant
  if ($null -eq $entry) { throw "Manifest is missing variant: $variant" }
  $repo = Assert-WithinRoot ([string]$entry.repoPath) "$variant repoPath"
  Assert-RdcAbInheritedChildAcl $root $repo "$variant runtime root"
  $actualSha = (& git.exe -C $repo rev-parse HEAD 2>$null).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Unable to read $variant Git HEAD" }
  $expectedSha = ([string]$entry.expectedSha).ToLowerInvariant()
  if ($actualSha.ToLowerInvariant() -ne $expectedSha) {
    throw "$variant SHA mismatch: expected $expectedSha got $actualSha"
  }
  $entrypoint = Join-Path $repo 'dist\index.js'
  if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
    throw "$variant build entrypoint is missing: $entrypoint"
  }
  if ($entry.buildDigest) {
    $actualDigest = (Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualDigest -ne ([string]$entry.buildDigest).ToLowerInvariant()) {
      throw "$variant build digest mismatch"
    }
  }
  $expectedRuntimeDigest = [string]$entry.runtimeDigest
  if ($expectedRuntimeDigest -cnotmatch '^[0-9a-f]{64}$') {
    throw "$variant runtimeDigest is required and must be lowercase SHA-256 hex"
  }
  Assert-TrackedWorktreeClean $repo $variant
  $actualRuntimeDigest = Get-RuntimeDigest $repo
  if (-not $actualRuntimeDigest.Equals($expectedRuntimeDigest, [StringComparison]::Ordinal)) {
    throw "$variant runtime digest mismatch"
  }
  return [pscustomobject]@{ Variant=$variant; Entry=$entry; Repo=$repo; Sha=$actualSha; Entrypoint=$entrypoint }
}
function Get-PrototypeStateEnvironment($Selection, [switch]$EnsureDirectories) {
  if ($Selection.Variant -ne 'prototype') { return @{} }
  $state = $Selection.Entry.statePaths
  if ($null -eq $state) { throw 'Prototype statePaths are required' }
  $mapping = [ordered]@{
    DESKTOP_COMMANDER_POLICY_FILE = [string]$state.policyFile
    DESKTOP_COMMANDER_APPROVAL_FILE = [string]$state.approvalFile
    DESKTOP_COMMANDER_AUDIT_FILE = [string]$state.auditFile
    DESKTOP_COMMANDER_USAGE_FILE = [string]$state.usageFile
    DESKTOP_COMMANDER_WORKFLOW_STATE_DIR = [string]$state.workflowStateDir
  }
  foreach ($key in @($mapping.Keys)) {
    $resolved = Assert-StatePathWithinRoot ([string]$mapping[$key]) $key -EnsureDirectories:$EnsureDirectories
    $mapping[$key] = $resolved
  }
  return $mapping
}

$selection = Get-ValidatedSelection
$prototypeEnv = Get-PrototypeStateEnvironment $selection
if ($ValidateOnly) {
  [ordered]@{
    variant = $selection.Variant
    expectedSha = ([string]$selection.Entry.expectedSha).ToLowerInvariant()
    actualSha = $selection.Sha.ToLowerInvariant()
    prototypeStateInjected = ($selection.Variant -eq 'prototype')
  } | ConvertTo-Json -Compress
  exit 0
}
$testControl = if ($TestControlDirectory) { $TestControlDirectory } else { $env:RDC_AB_TEST_CONTROL_DIRECTORY }
if ($testControl) {
  if ($env:RDC_AB_ENABLE_TEST_CONTROL -ne '1') { throw 'Supervisor test control is disabled' }
  $testControl = [IO.Path]::GetFullPath($testControl)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  if (-not $testControl.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Supervisor test control directory must be beneath the OS temp directory'
  }
  if (-not (Test-Path -LiteralPath $testControl -PathType Container)) {
    throw 'Supervisor test control directory is missing'
  }
}

$windowsIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
try { $identitySid = $windowsIdentity.User.Value }
finally { $windowsIdentity.Dispose() }
if (-not $identitySid) { throw 'Unable to resolve the remote-device user identity' }
$mutexBaseName = 'OpenAI.DesktopCommander.RdcAbSupervisor.' + ($identitySid -replace '[^A-Za-z0-9_.-]', '_')
if ($testControl) {
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $controlBytes = [Text.Encoding]::UTF8.GetBytes($testControl.ToLowerInvariant())
    $controlHash = ([BitConverter]::ToString($hasher.ComputeHash($controlBytes))).Replace('-', '').Substring(0, 16)
    $mutexBaseName += ".Test.$controlHash"
  } finally {
    $hasher.Dispose()
  }
}
$mutexName = "Global\$mutexBaseName"
$supervisorMutex = [pscustomobject]@{
  Handle = [Threading.Mutex]::new($false, $mutexName)
  Name = $mutexName
}
$ownsSupervisorMutex = $false
try {
  try {
    $ownsSupervisorMutex = $supervisorMutex.Handle.WaitOne(0)
  } catch [Threading.AbandonedMutexException] {
    $ownsSupervisorMutex = $true
  }
  if (-not $ownsSupervisorMutex) {
    throw "RDC A/B supervisor is already active (mutex '$($supervisorMutex.Name)')"
  }

$managedKeys = @(
  'DESKTOP_COMMANDER_POLICY_FILE',
  'DESKTOP_COMMANDER_APPROVAL_FILE',
  'DESKTOP_COMMANDER_AUDIT_FILE',
  'DESKTOP_COMMANDER_USAGE_FILE',
  'DESKTOP_COMMANDER_WORKFLOW_STATE_DIR'
)
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logPath = Join-Path $logDir 'supervisor.jsonl'

function Write-SafeSupervisorEvent([string]$Event, $Selection, $ExitCode = $null) {
  $record = [ordered]@{
    timestamp = [DateTime]::UtcNow.ToString('o')
    event = $Event
    variant = $Selection.Variant
    sha = $Selection.Sha.ToLowerInvariant()
  }
  if ($null -ne $ExitCode) { $record.exitCode = [int]$ExitCode }
  Add-Content -LiteralPath $logPath -Value ($record | ConvertTo-Json -Compress) -Encoding UTF8
}

function Get-KnownRemoteProcesses {
  if ($testControl) {
    if (Test-Path -LiteralPath (Join-Path $testControl 'known-remote') -PathType Leaf) {
      return @([pscustomobject]@{ ProcessId = 1 })
    }
    return @()
  }
  $markers = @('DesktopCommanderTierPrototype', 'RDC-Benchmark')
  return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $cmd = [string]$_.CommandLine
    $hasMarker = $false
    foreach ($marker in $markers) { if ($cmd -like "*$marker*") { $hasMarker = $true; break } }
    $hasMarker -and $cmd -match 'dist[\\/]index\.js' -and $cmd -match '(?:^|\s)remote(?:\s|$)'
  })
}
function Wait-TestLaunchBarrier {
  if (-not $testControl) { return }
  $readyPath = Join-Path $testControl "ready-$PID"
  [IO.File]::WriteAllText($readyPath, '')
  $releasePath = Join-Path $testControl 'release'
  while (-not (Test-Path -LiteralPath $releasePath -PathType Leaf)) {
    Start-Sleep -Milliseconds 25
  }
}
function Complete-TestLaunchDecision {
  if (-not $testControl) { return $false }
  $launchPath = Join-Path $testControl "launch-$PID"
  [IO.File]::WriteAllText($launchPath, '')
  return $true
}
function Wait-RetryInterval {
  if ($testControl) { Start-Sleep -Milliseconds 50 }
  else { Start-Sleep -Seconds $RetrySeconds }
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
while ($true) {
  $selection = Get-ValidatedSelection
  $prototypeEnv = Get-PrototypeStateEnvironment $selection -EnsureDirectories
  $existing = @(Get-KnownRemoteProcesses)
  if ($existing.Count -gt 0) {
    Write-SafeSupervisorEvent 'waiting_existing_remote' $selection
    Wait-RetryInterval
    continue
  }

  Wait-TestLaunchBarrier
  $existing = @(Get-KnownRemoteProcesses)
  if ($existing.Count -gt 0) {
    Write-SafeSupervisorEvent 'waiting_existing_remote' $selection
    Wait-RetryInterval
    continue
  }
  if (Complete-TestLaunchDecision) { exit 0 }

  $exitCode = 1
  $launchBlocked = $false
  $environmentApplied = $false
  $saved = @{}
  try {
    $existing = @(Get-KnownRemoteProcesses)
    if ($existing.Count -gt 0) {
      $launchBlocked = $true
    } else {
      $selection = Get-ValidatedSelection
      $prototypeEnv = Get-PrototypeStateEnvironment $selection -EnsureDirectories
      foreach ($key in $managedKeys) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        $value = if ($prototypeEnv.Contains($key)) { [string]$prototypeEnv[$key] } else { $null }
        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
      }
      $environmentApplied = $true
      Write-SafeSupervisorEvent 'launch' $selection
      & $node $selection.Entrypoint remote
      $exitCode = $LASTEXITCODE
    }
  } finally {
    if ($environmentApplied) {
      foreach ($key in $managedKeys) {
        [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process')
      }
    }
  }
  if ($launchBlocked) {
    Write-SafeSupervisorEvent 'waiting_existing_remote' $selection
    Wait-RetryInterval
    continue
  }
  Write-SafeSupervisorEvent 'exit' $selection $exitCode
  Wait-RetryInterval
}
} finally {
  try {
    if ($ownsSupervisorMutex) { $supervisorMutex.Handle.ReleaseMutex() }
  } finally {
    $supervisorMutex.Handle.Dispose()
  }
}
