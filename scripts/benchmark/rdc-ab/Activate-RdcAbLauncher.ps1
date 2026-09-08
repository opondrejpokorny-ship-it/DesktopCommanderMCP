[CmdletBinding()]
param(
  [string]$BenchmarkRoot = 'C:\RDC-Benchmark',
  [Parameter(Mandatory=$true)][string]$LauncherPath,
  [ValidateRange(5,300)][int]$ShutdownWaitSeconds = 120
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

$hostDir = Join-Path $root 'host'
$installedSupervisor = Join-Path $hostDir 'Run-RdcAbSupervisor.ps1'
$installedAclHelper = Join-Path $hostDir 'RdcAbAcl.ps1'
$sourceAclHelper = Join-Path $PSScriptRoot 'RdcAbAcl.ps1'
if (-not (Test-Path -LiteralPath $sourceAclHelper -PathType Leaf)) { throw 'Trusted ACL helper is missing' }
if (-not (Test-Path -LiteralPath $installedSupervisor -PathType Leaf)) { throw 'Installed RDC A/B supervisor is missing' }
if (-not (Test-Path -LiteralPath $installedAclHelper -PathType Leaf)) { throw 'Installed RDC A/B ACL helper is missing' }
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Installed launcher is missing' }
if (-not (Test-Path -LiteralPath "$launcher.rdc-ab-original" -PathType Leaf)) { throw 'Original launcher backup is missing' }
. $sourceAclHelper

$expectedDelegator = @(
  '@echo off',
  'setlocal',
  ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $installedSupervisor + '" -BenchmarkRoot "' + $root + '"'),
  'exit /b %errorlevel%'
) -join "`r`n"
$expectedDelegator += "`r`n"
$expectedBytes = [Text.Encoding]::ASCII.GetBytes($expectedDelegator)

function Assert-VerifiedLauncherStream([IO.Stream]$Stream) {
  if (-not $Stream.CanRead -or -not $Stream.CanSeek) {
    throw 'Verified launcher bytes cannot be read safely'
  }
  $Stream.Position = 0
  if ($Stream.Length -ne $expectedBytes.Length) {
    throw 'Launcher changed after validation; verified bytes no longer match'
  }
  for ($index = 0; $index -lt $expectedBytes.Length; $index++) {
    if ($Stream.ReadByte() -ne [int]$expectedBytes[$index]) {
      throw 'Launcher changed after validation; verified bytes no longer match'
    }
  }
  $Stream.Position = 0
}

function Get-CmdLaunchTarget([string]$CommandLine) {
  if (-not $CommandLine) { return $null }

  # Win32_Process.CommandLine includes cmd.exe plus its arguments. Activation may
  # retire only the exact /c watcher invocation that runs this launcher. /k,
  # trailing cmd grammar, extra arguments, and ambiguous quoting fail closed.
  $invocation = [regex]::Match(
    $CommandLine,
    '(?is)^[ \t]*(?:"[^"\r\n]*\\cmd\.exe"|[^ \t"\r\n]*cmd\.exe)[ \t]+/c[ \t]+(?<tail>.+?)[ \t]*$'
  )
  if (-not $invocation.Success) { return $null }

  $tail = $invocation.Groups['tail'].Value.Trim()
  $targetMatch = [regex]::Match($tail, '^""(?<target>[^"\r\n]+)"[ \t]*"$')
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

function Get-HostOrchestratorInventory {
  if ($testControl) {
    $inventoryPath = Join-Path $testControl 'host-orchestrator-inventory.json'
    if (-not (Test-Path -LiteralPath $inventoryPath -PathType Leaf)) { return @() }
    return @((Get-Content -Raw -LiteralPath $inventoryPath | ConvertFrom-Json))
  }
  return @(Get-ScheduledTask -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{
      TaskName = [string]$_.TaskName
      Enabled = [bool]$_.Settings.Enabled -and ([string]$_.State -ne 'Disabled')
      State = [string]$_.State
      Actions = @($_.Actions)
    }
  })
}

function Assert-NoCompetingHostOrchestrator($Contract) {
  $entrypoint = [IO.Path]::GetFullPath([string]$Contract.Entrypoint).Replace('/', '\')
  foreach ($task in @(Get-HostOrchestratorInventory)) {
    if (-not [bool]$task.Enabled -or ([string]$task.State -eq 'Disabled')) { continue }
    foreach ($action in @($task.Actions)) {
      $text = ([string]$action.Execute) + ' ' + ([string]$action.Arguments)
      $fileMatch = [regex]::Match([string]$action.Arguments, '(?i)(?:^|\s)-File\s+(?:"(?<quoted>[^"\r\n]+)"|(?<bare>[^\s"\r\n]+))')
      if ($fileMatch.Success) {
        $scriptPath = if ($fileMatch.Groups['quoted'].Success) { $fileMatch.Groups['quoted'].Value } else { $fileMatch.Groups['bare'].Value }
        try {
          $scriptPath = [IO.Path]::GetFullPath($scriptPath)
          if (Test-Path -LiteralPath $scriptPath -PathType Leaf) {
            $text += "`n" + [IO.File]::ReadAllText($scriptPath)
          }
        } catch { }
      }
      $normalized = $text.Replace('/', '\')
      if ($normalized.IndexOf($entrypoint, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
          [regex]::IsMatch($text, '(?i)(?:^|[^A-Za-z0-9_])remote(?:[^A-Za-z0-9_]|$)')) {
        throw "Enabled competing host orchestrator '$([string]$task.TaskName)' can launch the canonical RDC Remote; activation stopped without changes"
      }
    }
  }
}
function Get-OriginalLauncherRemoteContract {
  $backup = "$launcher.rdc-ab-original"
  $text = [IO.File]::ReadAllText($backup)
  $rootMatches = [regex]::Matches($text, '(?im)^[ \t]*set[ \t]+"ROOT=(?<value>[^"\r\n]+)"[ \t]*\r?$')
  $nodeMatches = [regex]::Matches($text, '(?im)^[ \t]*set[ \t]+"NODE=(?<value>[^"\r\n]+)"[ \t]*\r?$')
  $entryMatches = [regex]::Matches($text, '(?im)^[ \t]*set[ \t]+"ENTRY=%ROOT%\\dist\\index\.js"[ \t]*\r?$')
  $launchMatches = [regex]::Matches(
    $text,
    '(?im)^[ \t]*"%NODE%"[ \t]+"%ENTRY%"[ \t]+remote(?:[ \t]+>>[ \t]+"[^"\r\n]+"[ \t]+2>&1)?[ \t]*\r?$'
  )
  if ($rootMatches.Count -ne 1 -or $nodeMatches.Count -ne 1 -or
      $entryMatches.Count -ne 1 -or $launchMatches.Count -ne 1) {
    throw 'Original launcher remote contract is not exact'
  }

  $rootValue = $rootMatches[0].Groups['value'].Value
  $nodeValue = $nodeMatches[0].Groups['value'].Value
  $unsafe = [char[]]@('&','|','<','>','^','%','!')
  if ($rootValue.IndexOfAny($unsafe) -ge 0 -or $nodeValue.IndexOfAny($unsafe) -ge 0) {
    throw 'Original launcher remote contract contains unsafe expansion syntax'
  }
  try {
    $legacyRoot = [IO.Path]::GetFullPath($rootValue).TrimEnd('\\')
    $legacyNode = [IO.Path]::GetFullPath($nodeValue)
    $legacyEntrypoint = [IO.Path]::GetFullPath((Join-Path $legacyRoot 'dist\\index.js'))
  } catch { throw 'Original launcher remote contract contains an invalid path' }
  if (-not [IO.Path]::GetFileName($legacyNode).Equals('node.exe', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Original launcher remote contract does not name node.exe'
  }
  if (-not (Test-Path -LiteralPath $legacyNode -PathType Leaf) -or
      -not (Test-Path -LiteralPath $legacyEntrypoint -PathType Leaf)) {
    throw 'Original launcher remote contract target is missing'
  }
  return [pscustomobject]@{ Node = $legacyNode; Entrypoint = $legacyEntrypoint }
}

function Get-RemoteProcessInventory {
  if ($testControl) {
    $inventoryPath = Join-Path $testControl 'remote-process-inventory.json'
    if (-not (Test-Path -LiteralPath $inventoryPath -PathType Leaf)) {
      throw 'Activation test remote process inventory is missing'
    }
    return @((Get-Content -Raw -LiteralPath $inventoryPath | ConvertFrom-Json))
  }
  return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
}

function ConvertTo-ProcessCreationUtc($Value) {
  if ($null -eq $Value) { return $null }
  try {
    if ($Value -is [DateTime]) { return ([DateTime]$Value).ToUniversalTime() }
    return ([DateTimeOffset]::Parse([string]$Value)).UtcDateTime
  } catch { return $null }
}

function Get-ExactRemoteProcesses([int]$WatcherPid, [DateTime]$WatcherCreationUtc, $Contract) {
  return @(Get-RemoteProcessInventory | Where-Object {
    if (-not ([string]$_.Name).Equals('node.exe', [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if ([int64]$_.ParentProcessId -ne [int64]$WatcherPid) { return $false }
    $remoteCreationUtc = ConvertTo-ProcessCreationUtc $_.CreationDate
    if ($null -eq $remoteCreationUtc -or $remoteCreationUtc -lt $WatcherCreationUtc) { return $false }
    $match = [regex]::Match(
      [string]$_.CommandLine,
      '^[ \t]*"(?<node>[^"\r\n]+)"[ \t]+"(?<entry>[^"\r\n]+)"[ \t]+remote[ \t]*$'
    )
    if (-not $match.Success) { return $false }
    try {
      $node = [IO.Path]::GetFullPath($match.Groups['node'].Value)
      $entry = [IO.Path]::GetFullPath($match.Groups['entry'].Value)
    } catch { return $false }
    return $node.Equals([string]$Contract.Node, [StringComparison]::OrdinalIgnoreCase) -and
      $entry.Equals([string]$Contract.Entrypoint, [StringComparison]::OrdinalIgnoreCase)
  })
}

function Get-ExactLocalMcpProcesses([int]$RemotePid, [DateTime]$RemoteCreationUtc, $Contract) {
  return @(Get-RemoteProcessInventory | Where-Object {
    if (-not ([string]$_.Name).Equals('node.exe', [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if ([int64]$_.ParentProcessId -ne [int64]$RemotePid) { return $false }
    $creationUtc = ConvertTo-ProcessCreationUtc $_.CreationDate
    if ($null -eq $creationUtc -or $creationUtc -lt $RemoteCreationUtc) { return $false }
    $match = [regex]::Match(
      [string]$_.CommandLine,
      '^[ \t]*"(?<node>[^"\r\n]+)"[ \t]+(?:"(?<entryQuoted>[^"\r\n]+)"|(?<entryBare>[^ \t"\r\n]+))[ \t]*$'
    )
    if (-not $match.Success) { return $false }
    try {
      $node = [IO.Path]::GetFullPath($match.Groups['node'].Value)
      $entryText = if ($match.Groups['entryQuoted'].Success) {
        $match.Groups['entryQuoted'].Value
      } else {
        $match.Groups['entryBare'].Value
      }
      $entry = [IO.Path]::GetFullPath($entryText)
    } catch { return $false }
    return $node.Equals([string]$Contract.Node, [StringComparison]::OrdinalIgnoreCase) -and
      $entry.Equals([string]$Contract.Entrypoint, [StringComparison]::OrdinalIgnoreCase)
  })
}

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

  $validationOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installedSupervisor -BenchmarkRoot $root -ValidateOnly 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Installed supervisor validation failed: $($validationOutput -join ' ')" }
  try { $validated = ($validationOutput -join "`n") | ConvertFrom-Json }
  catch { throw 'Installed supervisor validation did not return JSON' }
  if ($validated.variant -notin @('clean','prototype')) { throw 'Installed supervisor returned an invalid variant' }

  $actualBytes = [IO.File]::ReadAllBytes($launcher)
  if ($actualBytes.Length -ne $expectedBytes.Length) { throw 'Launcher is not the installed RDC A/B delegator' }
  for ($index = 0; $index -lt $expectedBytes.Length; $index++) {
    if ($actualBytes[$index] -ne $expectedBytes[$index]) { throw 'Launcher is not the installed RDC A/B delegator' }
  }
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

  $watcherPid = [int]$matchingWatchers[0].ProcessId
  if ($watcherPid -le 0 -or $watcherPid -eq $PID) { throw 'Old launcher watcher identity is invalid' }
  $watcherCreationUtc = ConvertTo-ProcessCreationUtc $matchingWatchers[0].CreationDate
  if ($null -eq $watcherCreationUtc) { throw 'Old launcher watcher creation time is unavailable' }

  $watcherProcess = [Diagnostics.Process]::GetProcessById($watcherPid)
  if (-not $watcherProcess.ProcessName.Equals('cmd', [StringComparison]::OrdinalIgnoreCase)) {
    $watcherProcess.Dispose()
    throw 'Old launcher watcher changed before activation'
  }
  $actualWatcherCreationUtc = $watcherProcess.StartTime.ToUniversalTime()
  if ([Math]::Abs(($actualWatcherCreationUtc - $watcherCreationUtc).TotalMilliseconds) -gt 1) {
    $watcherProcess.Dispose()
    throw 'Old launcher watcher creation identity changed or was reused before activation'
  }
  $watcherStartTime = $watcherProcess.StartTime.ToFileTimeUtc()

  $legacyContract = Get-OriginalLauncherRemoteContract
  Assert-NoCompetingHostOrchestrator $legacyContract
  $knownRemote = @(Get-ExactRemoteProcesses -WatcherPid $watcherPid -WatcherCreationUtc $actualWatcherCreationUtc -Contract $legacyContract)
  if ($knownRemote.Count -ne 1) {
    $watcherProcess.Dispose()
    throw "Activation requires exactly one exact live RDC remote child of the watcher; found $($knownRemote.Count)"
  }

  $remotePid = [int]$knownRemote[0].ProcessId
  $remoteCreationUtc = ConvertTo-ProcessCreationUtc $knownRemote[0].CreationDate
  if ($remotePid -le 0 -or $remotePid -eq $PID -or $null -eq $remoteCreationUtc) {
    $watcherProcess.Dispose()
    throw 'Exact old RDC remote child identity is incomplete'
  }
  $remoteProcess = [Diagnostics.Process]::GetProcessById($remotePid)
  if (-not $remoteProcess.ProcessName.Equals('node', [StringComparison]::OrdinalIgnoreCase)) {
    $remoteProcess.Dispose()
    $watcherProcess.Dispose()
    throw 'Exact old RDC remote child changed before activation'
  }
  $actualRemoteCreationUtc = $remoteProcess.StartTime.ToUniversalTime()
  if ([Math]::Abs(($actualRemoteCreationUtc - $remoteCreationUtc).TotalMilliseconds) -gt 1) {
    $remoteProcess.Dispose()
    $watcherProcess.Dispose()
    throw 'Exact old RDC remote child creation identity changed or was reused before activation'
  }
  $remoteStartTime = $remoteProcess.StartTime.ToFileTimeUtc()
  $localMcp = @(Get-ExactLocalMcpProcesses -RemotePid $remotePid -RemoteCreationUtc $actualRemoteCreationUtc -Contract $legacyContract)
  $directNodeChildren = @(Get-RemoteProcessInventory | Where-Object {
    ([string]$_.Name).Equals('node.exe', [StringComparison]::OrdinalIgnoreCase) -and
    [int64]$_.ParentProcessId -eq [int64]$remotePid
  })
  if ($directNodeChildren.Count -ne $localMcp.Count) {
    $remoteProcess.Dispose()
    $watcherProcess.Dispose()
    throw 'Exact old RDC remote child has an unexpected direct Node child; authenticated shutdown handoff refused'
  }
  $localMcpPids = @($localMcp | ForEach-Object { [int]$_.ProcessId })

  $cmdPath = if ($env:SystemRoot) { Join-Path ([IO.Path]::GetFullPath($env:SystemRoot)) 'System32\cmd.exe' } else { $null }
  if (-not $cmdPath -or -not (Test-Path -LiteralPath $cmdPath -PathType Leaf)) {
    throw 'Canonical Windows command processor is unavailable'
  }

  $argumentLine = '/d /s /c ""' + $launcher + '""'
  $startedWrapper = $null
  $launcherReadLock = $null
  try {
    try {
      # Hold a read-only, no-write/no-delete share on the verified launcher for
      # the entire authenticated shutdown handoff. Install/Restore are also
      # excluded by the mutation mutex held by this process.
      $launcherReadLock = [IO.File]::Open(
        $launcher, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read
      )
    } catch {
      throw "Unable to lock verified launcher bytes before handoff: $($_.Exception.Message)"
    }
    Assert-VerifiedLauncherStream $launcherReadLock
    if ($testControl -and (Test-Path -LiteralPath (Join-Path $testControl 'fail-replacement-launch') -PathType Leaf)) {
      throw 'Test-controlled replacement launcher failure'
    }

    # Retain original process handles so PID reuse cannot redirect retirement or
    # completion checks. No OS signal is ever sent to the Remote process.
    $watcherProcess.Refresh()
    if (($testControl -and (Test-Path -LiteralPath (Join-Path $testControl 'watcher-exit-or-change-before-retirement') -PathType Leaf)) -or
        $watcherProcess.HasExited -or
        -not $watcherProcess.ProcessName.Equals('cmd', [StringComparison]::OrdinalIgnoreCase) -or
        $watcherProcess.StartTime.ToFileTimeUtc() -ne $watcherStartTime) {
      throw 'Old launcher watcher exited or changed before retirement'
    }
    $remoteProcess.Refresh()
    if ($remoteProcess.HasExited -or
        -not $remoteProcess.ProcessName.Equals('node', [StringComparison]::OrdinalIgnoreCase) -or
        $remoteProcess.StartTime.ToFileTimeUtc() -ne $remoteStartTime) {
      throw 'Exact old RDC remote child exited or changed before authenticated shutdown handoff'
    }
    $currentRemote = @(Get-ExactRemoteProcesses -WatcherPid $watcherPid -WatcherCreationUtc $actualWatcherCreationUtc -Contract $legacyContract)
    if ($currentRemote.Count -ne 1 -or [int]$currentRemote[0].ProcessId -ne $remotePid) {
      throw 'Exact old RDC remote child identity changed before authenticated shutdown handoff'
    }
    $currentLocalMcp = @(Get-ExactLocalMcpProcesses -RemotePid $remotePid -RemoteCreationUtc $actualRemoteCreationUtc -Contract $legacyContract)
    $currentLocalMcpPids = @($currentLocalMcp | ForEach-Object { [int]$_.ProcessId } | Sort-Object)
    $expectedLocalMcpPids = @($localMcpPids | Sort-Object)
    if (($currentLocalMcpPids -join ',') -ne ($expectedLocalMcpPids -join ',')) {
      throw 'Exact old RDC local MCP child set changed before authenticated shutdown handoff'
    }

    # Stop only the exact legacy cmd watcher so the authenticated Remote shutdown
    # cannot respawn the old runtime. The Remote itself remains alive and must be
    # shut down through its authenticated remote-channel shutdown tool.
    $watcherProcess.Kill()
    if (-not $watcherProcess.WaitForExit(5000)) { throw 'Old launcher watcher did not exit' }
    if ($testControl) {
      [IO.File]::WriteAllText((Join-Path $testControl 'authenticated-shutdown-ready'), '')
    }
    [ordered]@{
      phase = 'awaiting-authenticated-shutdown'
      variant = [string]$validated.variant
      stoppedWatcherPid = $watcherPid
      remotePid = $remotePid
    } | ConvertTo-Json -Compress | Write-Output

    if (-not $remoteProcess.WaitForExit($ShutdownWaitSeconds * 1000)) {
      throw 'Exact old RDC remote child did not complete authenticated graceful shutdown before timeout'
    }

    # The Remote shutdown closes its local MCP transport. Refuse replacement
    # launch if an exact local MCP child remains alive; there is no kill fallback.
    foreach ($localMcpPid in $localMcpPids) {
      $localProcess = $null
      try {
        $localProcess = [Diagnostics.Process]::GetProcessById($localMcpPid)
        if (-not $localProcess.WaitForExit(5000)) {
          throw 'Exact old RDC local MCP child remained alive after authenticated Remote shutdown'
        }
      } catch [ArgumentException] {
        # Already exited is the expected state.
      } finally {
        if ($null -ne $localProcess) { $localProcess.Dispose() }
      }
    }

    # Revalidate the selected runtime after the shutdown window. A selection or
    # runtime change while activation was armed must fail closed rather than start
    # a different runtime from the one the operator approved.
    $postValidationOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installedSupervisor -BenchmarkRoot $root -ValidateOnly 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Installed supervisor post-shutdown validation failed: $($postValidationOutput -join ' ')" }
    try { $postValidated = ($postValidationOutput -join "`n") | ConvertFrom-Json }
    catch { throw 'Installed supervisor post-shutdown validation did not return JSON' }
    if ([string]$postValidated.variant -ne [string]$validated.variant -or
        [string]$postValidated.expectedSha -ne [string]$validated.expectedSha -or
        [string]$postValidated.actualSha -ne [string]$validated.actualSha) {
      throw 'RDC A/B selected runtime changed during authenticated shutdown handoff'
    }
    Assert-VerifiedLauncherStream $launcherReadLock

    $startedWrapper = Start-Process -FilePath $cmdPath -ArgumentList $argumentLine -WindowStyle Hidden -PassThru
    if ($null -eq $startedWrapper) { throw 'Unable to start installed RDC A/B launcher after authenticated shutdown' }
    $startedWrapperPid = $startedWrapper.Id
    if ($startedWrapper.WaitForExit(250)) {
      throw "Installed RDC A/B launcher exited immediately after authenticated handoff (exit $($startedWrapper.ExitCode))"
    }
  } finally {
    $watcherProcess.Dispose()
    $remoteProcess.Dispose()
    if ($null -ne $startedWrapper) { $startedWrapper.Dispose() }
    if ($null -ne $launcherReadLock) { $launcherReadLock.Dispose() }
  }

  [ordered]@{
    phase = 'completed'
    variant = [string]$validated.variant
    stoppedWatcherPid = $watcherPid
    startedWrapperPid = $startedWrapperPid
  } | ConvertTo-Json -Compress
} finally {
  try { if ($ownsMutationMutex) { $mutationMutex.ReleaseMutex() } }
  finally { $mutationMutex.Dispose() }
}
