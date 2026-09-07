[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$BenchmarkRoot,
  [Parameter(Mandatory=$true)][string]$CleanSource,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$CleanSha,
  [Parameter(Mandatory=$true)][string]$PrototypeSource,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$PrototypeSha,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$UpstreamLatestObserved,
  [switch]$SkipInstallBuild
)

$ErrorActionPreference = 'Stop'
$testControl = $env:RDC_AB_TEST_CONTROL_DIRECTORY
if ($testControl) {
  if ($env:RDC_AB_ENABLE_TEST_CONTROL -ne '1') { throw 'Setup test control is disabled' }
  $testControl = [IO.Path]::GetFullPath($testControl).TrimEnd('\')
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  if (-not $testControl.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Setup test control directory must be beneath the OS temp directory'
  }
  if (-not (Test-Path -LiteralPath $testControl -PathType Container)) {
    throw 'Setup test control directory is missing'
  }
}
$root = [IO.Path]::GetFullPath($BenchmarkRoot).TrimEnd('\')
if (Test-Path -LiteralPath $root) { throw "Benchmark root already exists: $root" }
$parent = Split-Path -Parent $root
if (-not $parent) { throw 'BenchmarkRoot must have a parent directory' }
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
$stage = Join-Path $parent ('.' + (Split-Path -Leaf $root) + '.stage-' + [guid]::NewGuid().ToString('N'))

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$WorkingDirectory) {
  Push-Location $WorkingDirectory
  try {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
}
function Write-AtomicUtf8([string]$Path, [string]$Content) {
  $temp = "$Path.tmp-$PID-$([guid]::NewGuid().ToString('N'))"
  [IO.File]::WriteAllText($temp, $Content, (New-Object Text.UTF8Encoding($false)))
  try { Move-Item -LiteralPath $temp -Destination $Path -Force }
  finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
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

function Prepare-Variant([string]$Name, [string]$Source, [string]$Sha) {
  $repo = Join-Path $stage "$Name\repo"
  New-Item -ItemType Directory -Path (Split-Path -Parent $repo) -Force | Out-Null
  Invoke-Checked 'git.exe' @('clone','--no-checkout','--',$Source,$repo) $parent
  Invoke-Checked 'git.exe' @('-C',$repo,'checkout','--detach',$Sha) $parent
  $actual = (& git.exe -C $repo rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $actual -ne $Sha) { throw "$Name SHA mismatch: expected $Sha got $actual" }
  if (-not $SkipInstallBuild) {
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    $oldTelemetry = $env:DESKTOP_COMMANDER_DISABLE_TELEMETRY
    $env:DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true'
    try {
      Invoke-Checked $npm @('ci') $repo
      Invoke-Checked $npm @('run','build') $repo
    } finally { $env:DESKTOP_COMMANDER_DISABLE_TELEMETRY = $oldTelemetry }
  }
  $entry = Join-Path $repo 'dist\index.js'
  if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw "$Name build entrypoint is missing: $entry" }
  $digest = (Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash.ToLowerInvariant()
  $runtimeDigest = Get-RuntimeDigest $repo
  $packageJson = Join-Path $repo 'package.json'
  $version = if (Test-Path -LiteralPath $packageJson) {
    (Get-Content -Raw -LiteralPath $packageJson | ConvertFrom-Json).version
  } else { $null }
  return [pscustomobject]@{ Repo=$repo; Sha=$actual; Digest=$digest; RuntimeDigest=$runtimeDigest; Version=$version }
}
$published = $false
try {
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  $clean = Prepare-Variant 'clean' $CleanSource $CleanSha
  $prototype = Prepare-Variant 'prototype' $PrototypeSource $PrototypeSha
  foreach ($relative in @('state\prototype','fixtures','runs','logs')) {
    New-Item -ItemType Directory -Path (Join-Path $stage $relative) -Force | Out-Null
  }

  $finalPrototypeState = Join-Path $root 'state\prototype'
  $manifest = [ordered]@{
    schemaVersion = 1
    benchmarkRoot = $root
    upstreamLatestObserved = $UpstreamLatestObserved.ToLowerInvariant()
    createdAt = [DateTime]::UtcNow.ToString('o')
    variants = [ordered]@{
      clean = [ordered]@{
        repoPath = (Join-Path $root 'clean\repo')
        expectedSha = $CleanSha.ToLowerInvariant()
        buildDigest = $clean.Digest
        runtimeDigest = $clean.RuntimeDigest
        packageVersion = $clean.Version
      }
      prototype = [ordered]@{
        repoPath = (Join-Path $root 'prototype\repo')
        expectedSha = $PrototypeSha.ToLowerInvariant()
        buildDigest = $prototype.Digest
        runtimeDigest = $prototype.RuntimeDigest
        packageVersion = $prototype.Version
        statePaths = [ordered]@{
          policyFile = (Join-Path $finalPrototypeState 'policy.json')
          approvalFile = (Join-Path $finalPrototypeState 'approvals.json')
          auditFile = (Join-Path $finalPrototypeState 'audit.jsonl')
          usageFile = (Join-Path $finalPrototypeState 'usage.json')
          workflowStateDir = (Join-Path $finalPrototypeState 'workflow')
        }
      }
    }
  }
  Write-AtomicUtf8 (Join-Path $stage 'manifest.json') (($manifest | ConvertTo-Json -Depth 8) + "`n")
  Write-AtomicUtf8 (Join-Path $stage 'active-variant.txt') "prototype`n"
  if ($testControl) {
    [IO.File]::WriteAllText((Join-Path $testControl 'ready'), '')
    $releasePath = Join-Path $testControl 'release'
    while (-not (Test-Path -LiteralPath $releasePath -PathType Leaf)) {
      Start-Sleep -Milliseconds 25
    }
  }
  [IO.Directory]::Move($stage, $root)
  $published = $true
  Write-Output (($manifest | ConvertTo-Json -Depth 8 -Compress))
} catch {
  if (-not $published -and (Test-Path -LiteralPath $stage)) {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
  throw
}
