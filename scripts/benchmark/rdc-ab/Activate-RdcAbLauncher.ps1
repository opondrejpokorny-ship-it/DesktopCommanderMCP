[CmdletBinding()]
param(
  [string]$BenchmarkRoot = 'C:\RDC-Benchmark',
  [Parameter(Mandatory=$true)][string]$LauncherPath
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($BenchmarkRoot).TrimEnd('\')
$launcher = [IO.Path]::GetFullPath($LauncherPath)
if ($launcher.Contains('"')) { throw 'Launcher path contains an unsupported quote character' }

$testControl = $env:RDC_AB_TEST_CONTROL_DIRECTORY
if ($testControl) {
  if ($env:RDC_AB_ENABLE_TEST_CONTROL -ne '1') { throw 'Activation test control is disabled' }
  $testControl = [IO.Path]::GetFullPath($testControl)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  if (-not $testControl.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Activation test control directory must be beneath the OS temp directory'
  }
  if (-not (Test-Path -LiteralPath $testControl -PathType Container)) {
    throw 'Activation test control directory is missing'
  }
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

$installedSupervisor = Join-Path $root 'host\Run-RdcAbSupervisor.ps1'
if (-not (Test-Path -LiteralPath $installedSupervisor -PathType Leaf)) { throw 'Installed RDC A/B supervisor is missing' }
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Installed launcher is missing' }
if (-not (Test-Path -LiteralPath "$launcher.rdc-ab-original" -PathType Leaf)) { throw 'Original launcher backup is missing' }

$validationOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installedSupervisor -BenchmarkRoot $root -ValidateOnly 2>&1
if ($LASTEXITCODE -ne 0) { throw "Installed supervisor validation failed: $($validationOutput -join ' ')" }
try { $validated = ($validationOutput -join "`n") | ConvertFrom-Json }
catch { throw 'Installed supervisor validation did not return JSON' }
if ($validated.variant -notin @('clean','prototype')) { throw 'Installed supervisor returned an invalid variant' }

$expectedDelegator = @(
  '@echo off',
  'setlocal',
  ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $installedSupervisor + '" -BenchmarkRoot "' + $root + '"'),
  'exit /b %errorlevel%'
) -join "`r`n"
$expectedDelegator += "`r`n"
$expectedBytes = [Text.Encoding]::ASCII.GetBytes($expectedDelegator)
$actualBytes = [IO.File]::ReadAllBytes($launcher)
if ($actualBytes.Length -ne $expectedBytes.Length) { throw 'Launcher is not the installed RDC A/B delegator' }
for ($index = 0; $index -lt $expectedBytes.Length; $index++) {
  if ($actualBytes[$index] -ne $expectedBytes[$index]) { throw 'Launcher is not the installed RDC A/B delegator' }
}

function Get-CmdLaunchTarget([string]$CommandLine) {
  if (-not $CommandLine) { return $null }

  # Win32_Process.CommandLine includes cmd.exe plus its arguments. Activation may
  # retire only the exact /c watcher invocation that runs this launcher. /k,
  # trailing cmd grammar, extra arguments, and ambiguous quoting fail closed.
  $invocation = [regex]::Match(
    $CommandLine,
    '(?is)^\s*(?:"[^"\r\n]*\\cmd\.exe"|[^\s"\r\n]*cmd\.exe)(?:\s+/(?:d|q|s))*\s+/c\s+(?<tail>.+?)\s*$'
  )
  if (-not $invocation.Success) { return $null }

  $tail = $invocation.Groups['tail'].Value.Trim()
  $targetMatch = [regex]::Match($tail, '^""(?<target>[^"\r\n]+)"\s*"$')
  if (-not $targetMatch.Success) { return $null }

  $target = $targetMatch.Groups['target'].Value
  if (-not $target -or $target.IndexOfAny([char[]]@('&','|','<','>','^','%','!')) -ge 0) {
    return $null
  }
  try { return [IO.Path]::GetFullPath($target) } catch { return $null }
}
function Get-CmdProcessInventory {
  if ($testControl) {
    $inventoryPath = Join-Path $testControl 'process-inventory.json'
    if (-not (Test-Path -LiteralPath $inventoryPath -PathType Leaf)) { throw 'Activation test process inventory is missing' }
    return (Get-Content -Raw -LiteralPath $inventoryPath | ConvertFrom-Json)
  }
  return (Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction Stop)
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

$mutationMutex = [Threading.Mutex]::new($false, (Get-IdentityScopedMutexName 'OpenAI.DesktopCommander.RdcAbLauncherMutation.'))
$ownsMutationMutex = $false
try {
  try { $ownsMutationMutex = $mutationMutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $ownsMutationMutex = $true }
  if (-not $ownsMutationMutex) { throw 'RDC A/B launcher mutation is already active' }

  if ($testControl -and (Test-Path -LiteralPath (Join-Path $testControl 'hold-activation') -PathType Leaf)) {
    [IO.File]::WriteAllText((Join-Path $testControl 'activation-ready'), '')
    while (-not (Test-Path -LiteralPath (Join-Path $testControl 'activation-release') -PathType Leaf)) {
      Start-Sleep -Milliseconds 25
    }
  }

  $matchingWatchers = @(Get-CmdProcessInventory | Where-Object {
    ([string]$_.Name).Equals('cmd.exe', [StringComparison]::OrdinalIgnoreCase) -and
    $null -ne (Get-CmdLaunchTarget ([string]$_.CommandLine)) -and
    (Get-CmdLaunchTarget ([string]$_.CommandLine)).Equals($launcher, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($matchingWatchers.Count -eq 0) { throw 'Watcher command is not exact; activation stopped without changes' }
  if ($matchingWatchers.Count -gt 1) { throw 'Multiple exact old launcher watchers were found; activation stopped without changes' }

  $knownRemote = @(Get-KnownRemoteProcesses)
  if ($knownRemote.Count -ne 1) { throw "Activation requires exactly one live RDC remote child; found $($knownRemote.Count)" }

  $cmdPath = $env:ComSpec
  if (-not $cmdPath -or -not (Test-Path -LiteralPath $cmdPath -PathType Leaf)) {
    $cmdPath = if ($env:SystemRoot) { Join-Path $env:SystemRoot 'System32\cmd.exe' } else { $null }
  }
  if (-not $cmdPath -or -not (Test-Path -LiteralPath $cmdPath -PathType Leaf)) { throw 'Windows command processor is unavailable' }

  $watcherPid = [int]$matchingWatchers[0].ProcessId
  if ($watcherPid -le 0 -or $watcherPid -eq $PID) { throw 'Old launcher watcher identity is invalid' }
  $watcherProcess = [Diagnostics.Process]::GetProcessById($watcherPid)
  if (-not $watcherProcess.ProcessName.Equals('cmd', [StringComparison]::OrdinalIgnoreCase)) {
    $watcherProcess.Dispose()
    throw 'Old launcher watcher changed before activation'
  }
  $watcherStartTime = $watcherProcess.StartTime.ToFileTimeUtc()

  $argumentLine = '/d /s /c ""' + $launcher + '""'
  $startedWrapper = $null
  try {
    $startedWrapper = Start-Process -FilePath $cmdPath -ArgumentList $argumentLine -WindowStyle Hidden -PassThru
    if ($null -eq $startedWrapper) { throw 'Unable to start installed RDC A/B launcher' }
    $startedWrapperPid = $startedWrapper.Id
    if ($startedWrapper.WaitForExit(250)) {
      throw "Installed RDC A/B launcher exited before watcher handoff (exit $($startedWrapper.ExitCode))"
    }

    try {
      # Retain the original handle: re-resolving the PID could target a later process.
      $watcherProcess.Refresh()
      if (($testControl -and (Test-Path -LiteralPath (Join-Path $testControl 'watcher-exit-or-change-before-retirement') -PathType Leaf)) -or
          $watcherProcess.HasExited -or
          -not $watcherProcess.ProcessName.Equals('cmd', [StringComparison]::OrdinalIgnoreCase) -or
          $watcherProcess.StartTime.ToFileTimeUtc() -ne $watcherStartTime) {
        throw 'Old launcher watcher exited or changed before retirement'
      }
      $watcherProcess.Kill()
      if (-not $watcherProcess.WaitForExit(5000)) { throw 'Old launcher watcher did not exit' }
    } catch {
      try { if (-not $startedWrapper.HasExited) { Stop-Process -Id $startedWrapperPid -ErrorAction SilentlyContinue } } catch {}
      throw
    }
  } finally {
    $watcherProcess.Dispose()
    if ($null -ne $startedWrapper) { $startedWrapper.Dispose() }
  }

  [ordered]@{
    variant = [string]$validated.variant
    stoppedWatcherPid = $watcherPid
    startedWrapperPid = $startedWrapperPid
  } | ConvertTo-Json -Compress
} finally {
  try { if ($ownsMutationMutex) { $mutationMutex.ReleaseMutex() } }
  finally { $mutationMutex.Dispose() }
}
