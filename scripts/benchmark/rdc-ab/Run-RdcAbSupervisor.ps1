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
function Open-SealedRuntime([string]$Repository) {
  $rootAttributes = [IO.File]::GetAttributes($Repository)
  if (($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      ($rootAttributes -band [IO.FileAttributes]::Directory) -eq 0) {
    throw 'Runtime seal repository must be a real directory'
  }
  $files = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal)
  function Add-SealedRuntimeFiles([string]$Directory, [string]$RelativePath) {
    foreach ($child in [IO.Directory]::GetFileSystemEntries($Directory)) {
      $name = [IO.Path]::GetFileName($child)
      if ($RelativePath.Length -eq 0 -and $name -ceq '.git') { continue }
      $attributes = [IO.File]::GetAttributes($child)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Runtime seal rejects a symlink, junction, or reparse point'
      }
      $childRelative = if ($RelativePath.Length -eq 0) { $name } else { $RelativePath + '/' + $name }
      $item = Get-Item -LiteralPath $child -Force
      if ($item -is [IO.DirectoryInfo]) {
        Add-SealedRuntimeFiles $child $childRelative
      } elseif ($item -is [IO.FileInfo]) {
        $files.Add($childRelative, $child)
      } else {
        throw 'Runtime seal rejects a non-file, non-directory entry'
      }
    }
  }
  Add-SealedRuntimeFiles $Repository ''
  $relativePaths = New-Object string[] $files.Count
  $files.Keys.CopyTo($relativePaths, 0)
  [Array]::Sort($relativePaths, [StringComparer]::Ordinal)
  $handles = New-Object 'System.Collections.Generic.List[System.IO.FileStream]'
  $sealedFiles = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
  try {
    foreach ($relativePath in $relativePaths) {
      $filePath = $files[$relativePath]
      $attributes = [IO.File]::GetAttributes($filePath)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
          ($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
        throw 'Runtime seal rejects a symlink, junction, or reparse point'
      }
      $handle = [IO.File]::Open($filePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
      $handles.Add($handle)
      $sealedFiles.Add($relativePath, [pscustomobject]@{ Path=$filePath; Handle=$handle })
    }
    return [pscustomobject]@{ Repository=$Repository; Files=$sealedFiles; Handles=$handles }
  } catch {
    foreach ($handle in $handles) { $handle.Dispose() }
    throw
  }
}
function Close-SealedRuntime($SealedRuntime) {
  if ($null -ne $SealedRuntime) {
    foreach ($handle in $SealedRuntime.Handles) { $handle.Dispose() }
  }
}
function Get-SealedRuntimeDigest($SealedRuntime) {
  $relativePaths = New-Object string[] $SealedRuntime.Files.Count
  $SealedRuntime.Files.Keys.CopyTo($relativePaths, 0)
  [Array]::Sort($relativePaths, [StringComparer]::Ordinal)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    foreach ($relativePath in $relativePaths) {
      $stream = $SealedRuntime.Files[$relativePath].Handle
      $stream.Position = 0
      $fileHasher = [Security.Cryptography.SHA256]::Create()
      try { $fileDigest = ([BitConverter]::ToString($fileHasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
      finally { $fileHasher.Dispose(); $stream.Position = 0 }
      $record = $relativePath + [char]0 + $fileDigest + [char]10
      $bytes = [Text.Encoding]::UTF8.GetBytes($record)
      [void]$hasher.TransformBlock($bytes, 0, $bytes.Length, $bytes, 0)
    }
    [void]$hasher.TransformFinalBlock([byte[]]@(), 0, 0)
    return ([BitConverter]::ToString($hasher.Hash)).Replace('-', '').ToLowerInvariant()
  } finally { $hasher.Dispose() }
}
function Get-SealedRuntimeFileDigest($SealedRuntime, [string]$Path) {
  foreach ($sealedFile in $SealedRuntime.Files.Values) {
    if ($sealedFile.Path.Equals($Path, [StringComparison]::OrdinalIgnoreCase)) {
      $sealedFile.Handle.Position = 0
      $hasher = [Security.Cryptography.SHA256]::Create()
      try { return ([BitConverter]::ToString($hasher.ComputeHash($sealedFile.Handle))).Replace('-', '').ToLowerInvariant() }
      finally { $hasher.Dispose(); $sealedFile.Handle.Position = 0 }
    }
  }
  throw 'Runtime seal is missing the build entrypoint'
}
function Assert-TrackedWorktreeClean([string]$Repository, [string]$Variant) {
  & git.exe -C $Repository diff --no-ext-diff --quiet HEAD --
  $status = $LASTEXITCODE
  if ($status -eq 0) { return }
  if ($status -eq 1) { throw "$Variant tracked worktree differs from HEAD" }
  throw "Unable to compare $Variant tracked worktree with HEAD"
}
function Get-ValidatedSelection($SealedRuntime = $null) {
  [void](Assert-RdcAbProtectedRootAcl $root)
  Assert-RdcAbInheritedChildAcl $root $manifestPath 'Benchmark manifest'
  Assert-RdcAbInheritedChildAcl $root $activePath 'Active variant pointer'
  $variant = (Get-Content -Raw -LiteralPath $activePath).Trim()
  if ($variant -notin @('clean','prototype')) { throw "Unknown active benchmark variant: $variant" }
  $entry = $manifest.variants.$variant
  if ($null -eq $entry) { throw "Manifest is missing variant: $variant" }
  $repo = Assert-WithinRoot ([string]$entry.repoPath) "$variant repoPath"
  if ($null -ne $SealedRuntime) {
    Assert-RdcAbRuntimeNamespaceSeal $root $repo $SealedRuntime.NamespaceSeal.OwnerSid
  } else {
    Assert-RdcAbInheritedChildAcl $root $repo "$variant runtime root"
    Assert-RdcAbRuntimeTreeAcl $root $repo "$variant runtime tree"
  }
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
    $actualDigest = if ($null -ne $SealedRuntime) { Get-SealedRuntimeFileDigest $SealedRuntime $entrypoint } else { (Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256).Hash.ToLowerInvariant() }
    if ($actualDigest -ne ([string]$entry.buildDigest).ToLowerInvariant()) {
      throw "$variant build digest mismatch"
    }
  }
  $expectedRuntimeDigest = [string]$entry.runtimeDigest
  if ($expectedRuntimeDigest -cnotmatch '^[0-9a-f]{64}$') {
    throw "$variant runtimeDigest is required and must be lowercase SHA-256 hex"
  }
  Assert-TrackedWorktreeClean $repo $variant
  if ($null -ne $SealedRuntime) {
    if (-not $SealedRuntime.Repository.Equals($repo, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Runtime seal repository mismatch'
    }
    # Re-enumerate using the digest's rules after every file is locked; this
    # detects additions/removals while the sealed-stream digest binds the
    # selected bytes that will remain locked through node's lifetime.
    $liveRuntimeDigest = Get-RuntimeDigest $repo
    $actualRuntimeDigest = Get-SealedRuntimeDigest $SealedRuntime
    if (-not $liveRuntimeDigest.Equals($actualRuntimeDigest, [StringComparison]::Ordinal)) {
      throw 'Runtime tree changed after sealing'
    }
  } else {
    $actualRuntimeDigest = Get-RuntimeDigest $repo
  }
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

$namespaceSealJournal = Join-Path $root '.rdc-ab-runtime-namespace-seal.json'
function Assert-RdcAbNamespaceSealJournal($Journal) {
  if ($null -eq $Journal -or $Journal -is [Array] -or $Journal.SchemaVersion -ne 1) {
    throw 'RDC A/B runtime namespace seal journal schema is invalid; refusing recovery'
  }
  foreach ($field in @('Repository','CanonicalRepository','Entrypoint','CanonicalEntrypoint','OwnerSid','SupervisorStartUtc')) {
    if ($Journal.$field -isnot [string] -or [string]::IsNullOrWhiteSpace($Journal.$field)) {
      throw "RDC A/B runtime namespace seal journal field $field is invalid"
    }
  }
  foreach ($field in @('SupervisorPid','ChildPid','Rights')) {
    if ($null -eq $Journal.$field -or $Journal.$field -is [string] -or
        [int64]$Journal.$field -ne $Journal.$field -or [int64]$Journal.$field -gt [int]::MaxValue -or [int64]$Journal.$field -lt 0) {
      throw "RDC A/B runtime namespace seal journal field $field is invalid"
    }
  }
  if ($Journal.SupervisorPid -eq 0 -or $Journal.Rights -eq 0 -or $Journal.ChildStartUtc -isnot [string]) {
    throw 'RDC A/B runtime namespace seal journal identity is incomplete'
  }
  foreach ($field in @('SupervisorStartUtc','ChildStartUtc')) {
    if ($field -eq 'ChildStartUtc' -and $Journal.ChildPid -eq 0) {
      if ($Journal.ChildStartUtc -ne '') { throw 'Unpublished child must not have a start time' }
      continue
    }
    $parsed = [DateTime]::MinValue
    if (-not [DateTime]::TryParseExact($Journal.$field, 'o', [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed) -or $parsed.Kind -ne [DateTimeKind]::Utc) {
      throw 'RDC A/B runtime namespace seal journal start time is invalid'
    }
  }
}
function Get-RdcAbNamespaceSealJournal {
  if (-not (Test-Path -LiteralPath $namespaceSealJournal)) { return $null }
  Assert-RdcAbInheritedChildAcl $root $namespaceSealJournal 'Runtime namespace seal journal'
  if ((Get-Item -LiteralPath $namespaceSealJournal).Length -gt 16384) { throw 'RDC A/B runtime namespace seal journal is oversized' }
  try { $journal = Get-Content -Raw -LiteralPath $namespaceSealJournal | ConvertFrom-Json }
  catch { throw 'RDC A/B runtime namespace seal journal is malformed; refusing to mutate it' }
  Assert-RdcAbNamespaceSealJournal $journal
  return $journal
}
function Set-RdcAbNamespaceSealJournal($Journal) {
  Assert-RdcAbNamespaceSealJournal $Journal
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Journal | ConvertTo-Json -Compress))
  $temporary = $namespaceSealJournal + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  $stream = $null
  try {
    $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    $stream.Dispose()
    $stream = $null
    if (Test-Path -LiteralPath $namespaceSealJournal) {
      Assert-RdcAbInheritedChildAcl $root $namespaceSealJournal 'Runtime namespace seal journal'
      [IO.File]::Replace($temporary, $namespaceSealJournal, [NullString]::Value)
    } else {
      [IO.File]::Move($temporary, $namespaceSealJournal)
    }
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
}
function Test-RdcAbJournalRemoteChildAlive($Journal, $ConfirmedExitedChild = $null) {
  $entrypoint = [string]$Journal.Entrypoint
  $expectedPid = [int]$Journal.ChildPid
  $expectedStart = [string]$Journal.ChildStartUtc
  $confirmedExitedPid = 0
  $confirmedExitedStartUtc = $null
  if ($null -ne $ConfirmedExitedChild) {
    $confirmedExitedPid = [int]$ConfirmedExitedChild.ProcessId
    if ($confirmedExitedPid -le 0 -or $ConfirmedExitedChild.StartUtc -isnot [DateTime]) {
      throw 'RDC A/B confirmed-exited child identity is incomplete; refusing recovery'
    }
    $confirmedExitedStartUtc = ([DateTime]$ConfirmedExitedChild.StartUtc).ToUniversalTime()
  }
  foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)) {
    if ($expectedPid -ne 0 -and $process.ProcessId -ne $expectedPid) { continue }
    if ($confirmedExitedPid -ne 0 -and [int]$process.ProcessId -eq $confirmedExitedPid) {
      if ($process.CreationDate -isnot [DateTime]) {
        throw 'RDC A/B confirmed-exited CIM creation identity is unavailable; refusing recovery'
      }
      $cimStartUtc = ([DateTime]$process.CreationDate).ToUniversalTime()
      if ([Math]::Abs(($cimStartUtc - $confirmedExitedStartUtc).TotalMilliseconds) -le 1) { continue }
    }
    # Before ChildPid is published, parent PID alone is not durable authority.
    # Conservatively block on any process using this runtime, including a local
    # MCP child that could have outlived its Remote or supervisor.
    $cmd = [string]$process.CommandLine
    if (-not $cmd) { throw 'RDC A/B child command line is unavailable; refusing recovery' }
    if ($expectedPid -eq 0) {
      if ($cmd.Replace('/', '\').IndexOf($entrypoint.Replace('/', '\'), [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
      continue
    }
    if ($expectedStart) {
      $candidate = $null
      try {
        $candidate = Get-Process -Id $process.ProcessId -ErrorAction Stop
        [void]$candidate.Handle
        $start = $candidate.StartTime.ToUniversalTime().ToString('o')
        if (-not $start.Equals($expectedStart, [StringComparison]::Ordinal)) { continue }
      } catch { throw 'RDC A/B child identity is uncertain; refusing recovery' }
      finally { if ($null -ne $candidate) { $candidate.Dispose() } }
    }
    return $true
  }
  return $false
}
function Complete-RdcAbRuntimeSeal($Journal, $SealedRuntime, $Child) {
  if ($null -ne $Child -and -not $Child.HasExited) {
    throw 'RDC A/B child exit is not confirmed; preserving runtime seal and journal'
  }
  if ($null -eq $Journal) { Close-SealedRuntime $SealedRuntime; return }
  $confirmedExitedChild = $null
  if ($null -ne $Child -and $null -ne $Child.PSObject.Properties['Id'] -and $null -ne $Child.PSObject.Properties['StartTime']) {
    if ([int]$Journal.ChildPid -le 0 -or [int]$Journal.ChildPid -ne [int]$Child.Id -or -not [string]$Journal.ChildStartUtc) {
      throw 'RDC A/B confirmed-exited child does not match the journal identity; preserving runtime seal and journal'
    }
    try { $journalChildStartUtc = [DateTime]::Parse([string]$Journal.ChildStartUtc).ToUniversalTime() }
    catch { throw 'RDC A/B journal child start identity is invalid; preserving runtime seal and journal' }
    $childStartUtc = ([DateTime]$Child.StartTime).ToUniversalTime()
    if ([Math]::Abs(($journalChildStartUtc - $childStartUtc).TotalMilliseconds) -gt 1) {
      throw 'RDC A/B confirmed-exited child start identity does not match the journal; preserving runtime seal and journal'
    }
    $confirmedExitedChild = [pscustomobject]@{ ProcessId = [int]$Child.Id; StartUtc = $childStartUtc }
  }
  $runtimeUse = [pscustomobject]@{
    Entrypoint = [string]$Journal.Entrypoint; ChildPid = 0; ChildStartUtc = ''
  }
  $runtimeUseDrained = $false
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    if (-not (Test-RdcAbJournalRemoteChildAlive $runtimeUse $confirmedExitedChild)) {
      $runtimeUseDrained = $true
      break
    }
    if ($attempt -lt 49) { Start-Sleep -Milliseconds 100 }
  }
  if (-not $runtimeUseDrained) {
    throw 'RDC A/B runtime is still in use after bounded drain wait; preserving runtime seal and journal'
  }
  Close-SealedRuntime $SealedRuntime
  try {
    # The journal is written before ACL installation. Attempt recovery even if
    # installation threw before returning its seal object.
    Remove-RdcAbRuntimeNamespaceSeal $root ([string]$Journal.Repository) ([string]$Journal.OwnerSid)
  } catch {
    Assert-RdcAbRuntimeTreeAcl $root ([string]$Journal.Repository) 'Runtime tree after incomplete namespace seal operation'
  }
  Assert-RdcAbRuntimeTreeAcl $root ([string]$Journal.Repository) 'Runtime tree before namespace seal journal deletion'
  if (Test-Path -LiteralPath $namespaceSealJournal -PathType Leaf) {
    Remove-Item -LiteralPath $namespaceSealJournal -Force
  }
}
function Recover-RdcAbRuntimeNamespaceSeal {
  $journal = Get-RdcAbNamespaceSealJournal
  if ($null -eq $journal) { return }
  if ([int]$journal.Rights -ne [int](Get-RdcAbRuntimeNamespaceSealRights)) {
    throw 'RDC A/B runtime namespace seal journal has an unexpected ACE mask; refusing recovery'
  }
  if ((Test-RdcAbJournalRemoteChildAlive $journal) -or
      (Test-RdcAbJournalRemoteChildAlive ([pscustomobject]@{ Entrypoint=$journal.Entrypoint; ChildPid=0; ChildStartUtc='' }))) {
    throw 'RDC A/B runtime namespace seal journal belongs to a live exact remote child; refusing recovery'
  }
  $repo = [IO.Path]::GetFullPath([string]$journal.Repository).TrimEnd('\')
  $entrypoint = [IO.Path]::GetFullPath([string]$journal.Entrypoint)
  Assert-LexicallyWithinRoot $repo 'Runtime namespace seal journal repository' | Out-Null
  if (-not (Test-Path -LiteralPath $repo -PathType Container) -or -not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
    throw 'RDC A/B runtime namespace seal journal target is unavailable; refusing recovery'
  }
  if (-not (ConvertTo-CanonicalExistingPath $repo 'Runtime namespace seal journal repository').Equals([string]$journal.CanonicalRepository, [StringComparison]::OrdinalIgnoreCase) -or
      -not (ConvertTo-CanonicalExistingPath $entrypoint 'Runtime namespace seal journal entrypoint').Equals([string]$journal.CanonicalEntrypoint, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'RDC A/B runtime namespace seal journal target changed; refusing recovery'
  }
  try {
    Remove-RdcAbRuntimeNamespaceSeal $root $repo ([string]$journal.OwnerSid)
  } catch {
    # A crash can occur after the exact ACE is removed but before this journal
    # is deleted.  Only accept that case when the strict unsealed baseline is
    # already restored; otherwise preserve the journal and fail closed.
    Assert-RdcAbRuntimeTreeAcl $root $repo 'Runtime tree during stale namespace seal recovery'
  }
  Assert-RdcAbRuntimeTreeAcl $root $repo 'Runtime tree after stale namespace seal recovery'
  Remove-Item -LiteralPath $namespaceSealJournal -Force
}
$staleNamespaceSeal = Get-RdcAbNamespaceSealJournal
if ($ValidateOnly) {
  if ($null -ne $staleNamespaceSeal) { throw 'RDC A/B stale runtime namespace seal journal detected; ValidateOnly will not mutate it' }
  $selection = Get-ValidatedSelection
  $prototypeEnv = Get-PrototypeStateEnvironment $selection
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
  Recover-RdcAbRuntimeNamespaceSeal

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
  if (Test-Path -LiteralPath (Join-Path $testControl 'hold-post-validation-seal') -PathType Leaf) {
    return $false
  }
  $launchPath = Join-Path $testControl "launch-$PID"
  [IO.File]::WriteAllText($launchPath, '')
  return $true
}
function Wait-TestPostValidationSealBarrier {
  if (-not $testControl) { return }
  $holdPath = Join-Path $testControl 'hold-post-validation-seal'
  if (-not (Test-Path -LiteralPath $holdPath -PathType Leaf)) { return }
  [IO.File]::WriteAllText((Join-Path $testControl 'post-validation-seal-ready'), '')
  $releasePath = Join-Path $testControl 'post-validation-seal-release'
  while (-not (Test-Path -LiteralPath $releasePath -PathType Leaf)) {
    Start-Sleep -Milliseconds 25
  }
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
  $sealedRuntime = $null
  $namespaceSeal = $null
  $namespaceSealJournalRecord = $null
  $child = $null
  try {
    $existing = @(Get-KnownRemoteProcesses)
    if ($existing.Count -gt 0) {
      $launchBlocked = $true
    } else {
      $selection = Get-ValidatedSelection
      $prototypeEnv = Get-PrototypeStateEnvironment $selection -EnsureDirectories
      # Journal before installing the ACE: if this process dies at any later
      # point, recovery can identify a direct node child by parent/PID/start.
      $namespaceSealJournalRecord = [ordered]@{
        SchemaVersion = 1
        Repository = $selection.Repo
        CanonicalRepository = ConvertTo-CanonicalExistingPath $selection.Repo 'Runtime namespace seal repository'
        Entrypoint = $selection.Entrypoint
        CanonicalEntrypoint = ConvertTo-CanonicalExistingPath $selection.Entrypoint 'Runtime namespace seal entrypoint'
        OwnerSid = $identitySid
        Rights = [int](Get-RdcAbRuntimeNamespaceSealRights)
        SupervisorPid = $PID
        SupervisorStartUtc = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')
        ChildPid = 0
        ChildStartUtc = ''
      }
      Set-RdcAbNamespaceSealJournal $namespaceSealJournalRecord
      $namespaceSeal = Install-RdcAbRuntimeNamespaceSeal $root $selection.Repo
      Assert-RdcAbRuntimeNamespaceSeal $root $selection.Repo $namespaceSeal.OwnerSid
      $sealedRuntime = Open-SealedRuntime $selection.Repo
      $sealedRuntime | Add-Member -NotePropertyName NamespaceSeal -NotePropertyValue $namespaceSeal
      # This is the final validation: it runs only after all runtime files are
      # opened read-only without delete/write sharing, and hashes those streams.
      $selection = Get-ValidatedSelection $sealedRuntime
      foreach ($key in $managedKeys) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        $value = if ($prototypeEnv.Contains($key)) { [string]$prototypeEnv[$key] } else { $null }
        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
      }
      $environmentApplied = $true
      Wait-TestPostValidationSealBarrier
      Write-SafeSupervisorEvent 'launch' $selection
      $startInfo = [Diagnostics.ProcessStartInfo]::new()
      $startInfo.FileName = $node
      $startInfo.Arguments = '"' + $selection.Entrypoint.Replace('"', '\"') + '" remote'
      $startInfo.UseShellExecute = $false
      $child = [Diagnostics.Process]::Start($startInfo)
      [void]$child.Handle
      $namespaceSealJournalRecord.ChildPid = $child.Id
      $namespaceSealJournalRecord.ChildStartUtc = $child.StartTime.ToUniversalTime().ToString('o')
      if ($testControl -and (Test-Path -LiteralPath (Join-Path $testControl 'fail-child-journal-publication') -PathType Leaf)) {
        throw 'Test-controlled child journal publication failure'
      }
      Set-RdcAbNamespaceSealJournal $namespaceSealJournalRecord
      $child.WaitForExit()
      $exitCode = $child.ExitCode
    }
  } finally {
    try {
      if ($environmentApplied) {
        foreach ($key in $managedKeys) {
          [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process')
        }
      }
    } finally {
      # Publication or identity-read errors after Start must not release the
      # runtime while its child is alive. Keep the retained handle and wait for
      # natural/graceful exit; there is deliberately no termination fallback.
      try {
        if ($null -ne $child) { $child.WaitForExit() }
        Complete-RdcAbRuntimeSeal $namespaceSealJournalRecord $sealedRuntime $child
      } finally { if ($null -ne $child) { $child.Dispose() } }
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
