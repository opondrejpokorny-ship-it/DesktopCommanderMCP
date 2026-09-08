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
      TaskPath = [string]$_.TaskPath
      TaskName = [string]$_.TaskName
      Enabled = [bool]$_.Settings.Enabled -and ([string]$_.State -ne 'Disabled')
      State = [string]$_.State
      Actions = @($_.Actions)
    }
  })
}

function Assert-NoCompetingHostOrchestrator($Contract, [string]$AllowedTaskPath = $null, [string]$AllowedTaskName = $null) {
  $entrypoint = [IO.Path]::GetFullPath([string]$Contract.Entrypoint).Replace('/', '\')
  foreach ($task in @(Get-HostOrchestratorInventory)) {
    if ($AllowedTaskPath -and $AllowedTaskName -and
        ([string]$task.TaskPath).Equals($AllowedTaskPath, [StringComparison]::OrdinalIgnoreCase) -and
        ([string]$task.TaskName).Equals($AllowedTaskName, [StringComparison]::OrdinalIgnoreCase)) {
      continue
    }
    $taskState = [string]$task.State
    $definitionEnabled = [bool]$task.Enabled -and ($taskState -ne 'Disabled')
    $instanceRunning = $taskState -eq 'Running'
    if (-not ($definitionEnabled -or $instanceRunning)) { continue }
    foreach ($action in @($task.Actions)) {
      $execute = [string]$action.Execute
      $arguments = [string]$action.Arguments
      $text = $execute + ' ' + $arguments
      $fileMatch = [regex]::Match($arguments, '(?i)(?:^|\s)-File\s+(?:"(?<quoted>[^"\r\n]+)"|(?<bare>[^\s"\r\n]+))')
      if ($fileMatch.Success) {
        try { $executeName = [IO.Path]::GetFileName($execute) }
        catch { $executeName = $null }
        $isPowerShellFileAction = $executeName -and
          ($executeName.Equals('powershell.exe', [StringComparison]::OrdinalIgnoreCase) -or
           $executeName.Equals('pwsh.exe', [StringComparison]::OrdinalIgnoreCase))
        $scriptText = $null
        try {
          if (-not $isPowerShellFileAction) { throw 'not a PowerShell file action' }
          $scriptPath = if ($fileMatch.Groups['quoted'].Success) { $fileMatch.Groups['quoted'].Value } else { $fileMatch.Groups['bare'].Value }
          $scriptPath = [IO.Path]::GetFullPath($scriptPath)
          if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw 'script target is not a file' }
          $scriptText = [IO.File]::ReadAllText($scriptPath)
        } catch {
          if ($isPowerShellFileAction) {
            throw "Enabled PowerShell host orchestrator '$([string]$task.TaskName)' has an unverifiable script target; activation stopped without changes"
          }
        }
        if ($null -ne $scriptText) { $text += "`n" + $scriptText }
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

function Get-TrustedWindowsPowerShellPath {
  $systemRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
  if ([string]::IsNullOrWhiteSpace($systemRoot)) {
    throw 'Machine SystemRoot is unavailable'
  }
  try {
    $trustedPowerShell = [IO.Path]::GetFullPath((Join-Path $systemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
  } catch {
    throw 'Trusted Windows PowerShell path is invalid'
  }
  if (-not (Test-Path -LiteralPath $trustedPowerShell -PathType Leaf)) {
    throw 'Trusted Windows PowerShell executable is unavailable'
  }
  return $trustedPowerShell
}

function Get-SystemTaskHostInventory($Contract) {
  if ($testControl) {
    $taskPath = Join-Path $testControl 'system-task-inventory.json'
    $processPath = Join-Path $testControl 'system-process-inventory.json'
    if (-not (Test-Path -LiteralPath $taskPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $processPath -PathType Leaf)) {
      return [pscustomobject]@{ Tasks = @(); Processes = @() }
    }
    return [pscustomobject]@{
      Tasks = @((Get-Content -Raw -LiteralPath $taskPath | ConvertFrom-Json))
      Processes = @((Get-Content -Raw -LiteralPath $processPath | ConvertFrom-Json))
    }
  }

  $tasks = @(Get-ScheduledTask -TaskName ([string]$Contract.TaskName) -ErrorAction Stop |
    Where-Object { ([string]$_.TaskPath).Equals([string]$Contract.TaskPath, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object {
      $taskInfo = Get-ScheduledTaskInfo -TaskName ([string]$_.TaskName) -TaskPath ([string]$_.TaskPath) -ErrorAction Stop
      [pscustomobject]@{
        TaskPath = [string]$_.TaskPath
        TaskName = [string]$_.TaskName
        State = [string]$_.State
        LastTaskResult = [int64]$taskInfo.LastTaskResult
        Principal = [pscustomobject]@{
          UserId = [string]$_.Principal.UserId
          LogonType = [string]$_.Principal.LogonType
          RunLevel = [string]$_.Principal.RunLevel
        }
        Actions = @($_.Actions | ForEach-Object {
          [pscustomobject]@{ Execute = [string]$_.Execute; Arguments = [string]$_.Arguments }
        })
        Settings = [pscustomobject]@{
          MultipleInstances = [string]$_.Settings.MultipleInstances
          RestartCount = [int]$_.Settings.RestartCount
          RestartInterval = [string]$_.Settings.RestartInterval
        }
        Triggers = @($_.Triggers | ForEach-Object {
          [pscustomobject]@{ Class = [string]$_.CimClass.CimClassName; Enabled = [bool]$_.Enabled }
        })
      }
    })
  $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    ([string]$_.Name) -in @('powershell.exe','node.exe','svchost.exe')
  })
  return [pscustomobject]@{ Tasks = $tasks; Processes = $processes }
}

function Assert-ExactSystemTaskDefinition($TaskInventory, $Contract, [string[]]$AllowedStates = @('Running')) {
  $tasks = @($TaskInventory | Where-Object {
    ([string]$_.TaskPath).Equals([string]$Contract.TaskPath, [StringComparison]::OrdinalIgnoreCase) -and
    ([string]$_.TaskName).Equals([string]$Contract.TaskName, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($tasks.Count -ne 1) { throw "Expected exactly one configured SYSTEM RDC task; found $($tasks.Count)" }
  $task = $tasks[0]
  if ([string]$task.State -notin $AllowedStates) { throw "SYSTEM RDC task state is not allowed for handoff: $([string]$task.State)" }

  $principal = $task.Principal
  $systemUsers = @('SYSTEM','NT AUTHORITY\SYSTEM','S-1-5-18')
  if ([string]$principal.UserId -notin $systemUsers -or
      -not ([string]$principal.LogonType).Equals('ServiceAccount', [StringComparison]::OrdinalIgnoreCase) -or
      -not ([string]$principal.RunLevel).Equals('Highest', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'SYSTEM RDC task principal is not exact'
  }

  $actions = @($task.Actions)
  if ($actions.Count -ne 1) { throw 'SYSTEM RDC task must have exactly one action' }
  try { $actionExe = [IO.Path]::GetFullPath([string]$actions[0].Execute) } catch { throw 'SYSTEM RDC task action executable is invalid' }
  $trustedPowerShell = Get-TrustedWindowsPowerShellPath
  if (-not $actionExe.Equals($trustedPowerShell, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'SYSTEM RDC task action executable is not the trusted Windows PowerShell image'
  }
  $actionMatch = [regex]::Match(
    [string]$actions[0].Arguments,
    '(?i)^[ \t]*-NoProfile[ \t]+-NonInteractive[ \t]+-WindowStyle[ \t]+Hidden[ \t]+-ExecutionPolicy[ \t]+Bypass[ \t]+-File[ \t]+(?:"(?<quoted>[^"\r\n]+)"|(?<bare>[^ \t"\r\n]+))[ \t]*$'
  )
  if (-not $actionMatch.Success) { throw 'SYSTEM RDC task PowerShell arguments are not exact' }
  $wrapperText = if ($actionMatch.Groups['quoted'].Success) { $actionMatch.Groups['quoted'].Value } else { $actionMatch.Groups['bare'].Value }
  try { $actionWrapper = [IO.Path]::GetFullPath($wrapperText) } catch { throw 'SYSTEM RDC task wrapper path is invalid' }
  if (-not $actionWrapper.Equals([IO.Path]::GetFullPath([string]$Contract.WrapperPath), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'SYSTEM RDC task wrapper path is not exact'
  }

  if (-not ([string]$task.Settings.MultipleInstances).Equals('IgnoreNew', [StringComparison]::OrdinalIgnoreCase) -or
      [int]$task.Settings.RestartCount -ne 999 -or
      -not ([string]$task.Settings.RestartInterval).Equals('PT1M', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'SYSTEM RDC task restart/multiple-instance semantics are not exact'
  }
  $triggers = @($task.Triggers)
  if ($triggers.Count -ne 1 -or -not [bool]$triggers[0].Enabled -or
      -not ([string]$triggers[0].Class).Equals('MSFT_TaskBootTrigger', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'SYSTEM RDC task trigger is not the exact enabled boot trigger'
  }
  return $task
}

function Assert-ExactSystemTaskHostIdentity($TaskInventory, $ProcessInventory, $Contract) {
  $task = Assert-ExactSystemTaskDefinition -TaskInventory $TaskInventory -Contract $Contract -AllowedStates @('Running')
  $wrapperPath = [IO.Path]::GetFullPath([string]$Contract.WrapperPath)
  $nodePath = [IO.Path]::GetFullPath([string]$Contract.NodePath)
  $entrypoint = [IO.Path]::GetFullPath([string]$Contract.Entrypoint)
  $trustedPowerShell = Get-TrustedWindowsPowerShellPath

  $wrappers = @($ProcessInventory | Where-Object {
    if (-not ([string]$_.Name).Equals('powershell.exe', [StringComparison]::OrdinalIgnoreCase)) { return $false }
    $match = [regex]::Match(
      [string]$_.CommandLine,
      '(?i)^[ \t]*(?:"(?<exeQuoted>[^"\r\n]+)"|(?<exeBare>[^ \t"\r\n]+))[ \t]+-NoProfile[ \t]+-NonInteractive[ \t]+-WindowStyle[ \t]+Hidden[ \t]+-ExecutionPolicy[ \t]+Bypass[ \t]+-File[ \t]+(?:"(?<wrapperQuoted>[^"\r\n]+)"|(?<wrapperBare>[^ \t"\r\n]+))[ \t]*$'
    )
    if (-not $match.Success) { return $false }
    $exeText = if ($match.Groups['exeQuoted'].Success) { $match.Groups['exeQuoted'].Value } else { $match.Groups['exeBare'].Value }
    $wrapperText = if ($match.Groups['wrapperQuoted'].Success) { $match.Groups['wrapperQuoted'].Value } else { $match.Groups['wrapperBare'].Value }
    try {
      return [IO.Path]::GetFullPath([string]$_.ExecutablePath).Equals($trustedPowerShell, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFullPath($exeText).Equals($trustedPowerShell, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFullPath($wrapperText).Equals($wrapperPath, [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
  })
  if ($wrappers.Count -ne 1) { throw "Expected exactly one exact SYSTEM PowerShell wrapper process; found $($wrappers.Count)" }
  $wrapper = $wrappers[0]
  $wrapperCreationUtc = ConvertTo-ProcessCreationUtc $wrapper.CreationDate
  if ($null -eq $wrapperCreationUtc) { throw 'SYSTEM PowerShell wrapper creation identity is unavailable' }

  $parents = @($ProcessInventory | Where-Object { [int64]$_.ProcessId -eq [int64]$wrapper.ParentProcessId })
  if ($parents.Count -ne 1 -or
      -not ([string]$parents[0].Name).Equals('svchost.exe', [StringComparison]::OrdinalIgnoreCase) -or
      -not [regex]::IsMatch([string]$parents[0].CommandLine, '(?i)(?:^|[ \t])-s[ \t]+Schedule(?:[ \t]|$)')) {
    throw 'SYSTEM PowerShell wrapper parent is not the Task Scheduler service host'
  }
  $parentCreationUtc = ConvertTo-ProcessCreationUtc $parents[0].CreationDate
  if ($null -ne $parentCreationUtc -and $parentCreationUtc -gt $wrapperCreationUtc) {
    throw 'SYSTEM PowerShell wrapper predates its Task Scheduler parent'
  }

  $remotes = @($ProcessInventory | Where-Object {
    if (-not ([string]$_.Name).Equals('node.exe', [StringComparison]::OrdinalIgnoreCase) -or
        [int64]$_.ParentProcessId -ne [int64]$wrapper.ProcessId) { return $false }
    $creationUtc = ConvertTo-ProcessCreationUtc $_.CreationDate
    if ($null -eq $creationUtc -or $creationUtc -lt $wrapperCreationUtc) { return $false }
    $match = [regex]::Match(
      [string]$_.CommandLine,
      '^[ \t]*"(?<node>[^"\r\n]+)"[ \t]+(?:"(?<entryQuoted>[^"\r\n]+)"|(?<entryBare>[^ \t"\r\n]+))[ \t]+remote[ \t]+--persist-session[ \t]*$'
    )
    if (-not $match.Success) { return $false }
    $entryText = if ($match.Groups['entryQuoted'].Success) { $match.Groups['entryQuoted'].Value } else { $match.Groups['entryBare'].Value }
    try {
      return [IO.Path]::GetFullPath($match.Groups['node'].Value).Equals($nodePath, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFullPath($entryText).Equals($entrypoint, [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
  })
  if ($remotes.Count -ne 1) { throw "Expected exactly one exact SYSTEM-hosted RDC Remote; found $($remotes.Count)" }
  $remote = $remotes[0]
  $remoteCreationUtc = ConvertTo-ProcessCreationUtc $remote.CreationDate

  $localMcp = @($ProcessInventory | Where-Object {
    if (-not ([string]$_.Name).Equals('node.exe', [StringComparison]::OrdinalIgnoreCase) -or
        [int64]$_.ParentProcessId -ne [int64]$remote.ProcessId) { return $false }
    $creationUtc = ConvertTo-ProcessCreationUtc $_.CreationDate
    if ($null -eq $creationUtc -or $creationUtc -lt $remoteCreationUtc) { return $false }
    $match = [regex]::Match(
      [string]$_.CommandLine,
      '^[ \t]*"(?<node>[^"\r\n]+)"[ \t]+(?:"(?<entryQuoted>[^"\r\n]+)"|(?<entryBare>[^ \t"\r\n]+))[ \t]*$'
    )
    if (-not $match.Success) { return $false }
    $entryText = if ($match.Groups['entryQuoted'].Success) { $match.Groups['entryQuoted'].Value } else { $match.Groups['entryBare'].Value }
    try {
      return [IO.Path]::GetFullPath($match.Groups['node'].Value).Equals($nodePath, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFullPath($entryText).Equals($entrypoint, [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
  })
  $directNodeChildren = @($ProcessInventory | Where-Object {
    ([string]$_.Name).Equals('node.exe', [StringComparison]::OrdinalIgnoreCase) -and
    [int64]$_.ParentProcessId -eq [int64]$remote.ProcessId
  })
  if ($localMcp.Count -ne 1 -or $directNodeChildren.Count -ne $localMcp.Count) {
    throw 'SYSTEM-hosted RDC Remote local MCP child identity is not exact'
  }

  return [pscustomobject]@{
    Task = $task
    WrapperProcess = $wrapper
    RemoteProcess = $remote
    LocalMcpProcesses = $localMcp
  }
}

function Assert-SystemTaskHostQuiesced($TaskInventory, $ProcessInventory, $Contract) {
  $task = Assert-ExactSystemTaskDefinition -TaskInventory $TaskInventory -Contract $Contract -AllowedStates @('Ready')
  if ($null -eq $task.LastTaskResult -or [int64]$task.LastTaskResult -ne 0) {
    throw "SYSTEM RDC task did not record a successful wrapper exit ($([string]$task.LastTaskResult))"
  }
  $wrapperPath = [IO.Path]::GetFullPath([string]$Contract.WrapperPath)
  $entrypoint = [IO.Path]::GetFullPath([string]$Contract.Entrypoint)
  foreach ($process in @($ProcessInventory)) {
    $commandLine = [string]$process.CommandLine
    if (([string]$process.Name).Equals('powershell.exe', [StringComparison]::OrdinalIgnoreCase)) {
      $fileMatch = [regex]::Match($commandLine, '(?i)(?:^|[ \t])-File[ \t]+(?:"(?<quoted>[^"\r\n]+)"|(?<bare>[^ \t"\r\n]+))(?:[ \t]*$)')
      if ($fileMatch.Success) {
        $candidate = if ($fileMatch.Groups['quoted'].Success) { $fileMatch.Groups['quoted'].Value } else { $fileMatch.Groups['bare'].Value }
        try {
          if ([IO.Path]::GetFullPath($candidate).Equals($wrapperPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'SYSTEM RDC wrapper restarted during handoff'
          }
        } catch [Management.Automation.RuntimeException] { throw } catch { }
      }
    }
    if (([string]$process.Name).Equals('node.exe', [StringComparison]::OrdinalIgnoreCase) -and
        [regex]::IsMatch($commandLine, '(?i)(?:^|[ \t])remote[ \t]+--persist-session[ \t]*$')) {
      $escapedEntry = [regex]::Escape($entrypoint.Replace('/', '\'))
      if ($commandLine.Replace('/', '\') -match $escapedEntry) {
        throw 'SYSTEM RDC Remote restarted during handoff'
      }
    }
  }
}

function Invoke-SystemTaskHostGracefulHandoff($HostInfo, $Contract, [int]$ShutdownWaitSeconds, [string]$Variant) {
  $wrapperRecord = $HostInfo.WrapperProcess
  $remoteRecord = $HostInfo.RemoteProcess
  $localRecords = @($HostInfo.LocalMcpProcesses)
  $wrapperProcess = $null
  $remoteProcess = $null
  $localProcesses = @()
  try {
    $wrapperProcess = [Diagnostics.Process]::GetProcessById([int]$wrapperRecord.ProcessId)
    $remoteProcess = [Diagnostics.Process]::GetProcessById([int]$remoteRecord.ProcessId)
    if (-not $wrapperProcess.ProcessName.Equals('powershell', [StringComparison]::OrdinalIgnoreCase) -or
        -not $remoteProcess.ProcessName.Equals('node', [StringComparison]::OrdinalIgnoreCase)) {
      throw 'SYSTEM host process type changed before graceful handoff'
    }
    $wrapperCreationUtc = ConvertTo-ProcessCreationUtc $wrapperRecord.CreationDate
    $remoteCreationUtc = ConvertTo-ProcessCreationUtc $remoteRecord.CreationDate
    if ($null -eq $wrapperCreationUtc -or $null -eq $remoteCreationUtc -or
        [Math]::Abs(($wrapperProcess.StartTime.ToUniversalTime() - $wrapperCreationUtc).TotalMilliseconds) -gt 1 -or
        [Math]::Abs(($remoteProcess.StartTime.ToUniversalTime() - $remoteCreationUtc).TotalMilliseconds) -gt 1) {
      throw 'SYSTEM host PID/creation identity changed before graceful handoff'
    }
    foreach ($localRecord in $localRecords) {
      $localProcess = [Diagnostics.Process]::GetProcessById([int]$localRecord.ProcessId)
      $localCreationUtc = ConvertTo-ProcessCreationUtc $localRecord.CreationDate
      if (-not $localProcess.ProcessName.Equals('node', [StringComparison]::OrdinalIgnoreCase) -or
          $null -eq $localCreationUtc -or
          [Math]::Abs(($localProcess.StartTime.ToUniversalTime() - $localCreationUtc).TotalMilliseconds) -gt 1) {
        $localProcess.Dispose()
        throw 'SYSTEM local MCP PID/creation identity changed before graceful handoff'
      }
      $localProcesses += $localProcess
    }

    $freshInventory = Get-SystemTaskHostInventory $Contract
    $freshHost = Assert-ExactSystemTaskHostIdentity -TaskInventory $freshInventory.Tasks -ProcessInventory $freshInventory.Processes -Contract $Contract
    $freshLocal = @($freshHost.LocalMcpProcesses | ForEach-Object { [int]$_.ProcessId } | Sort-Object)
    $expectedLocal = @($localRecords | ForEach-Object { [int]$_.ProcessId } | Sort-Object)
    if ([int]$freshHost.WrapperProcess.ProcessId -ne [int]$wrapperRecord.ProcessId -or
        [int]$freshHost.RemoteProcess.ProcessId -ne [int]$remoteRecord.ProcessId -or
        ($freshLocal -join ',') -ne ($expectedLocal -join ',')) {
      throw 'SYSTEM host identity changed immediately before authenticated shutdown handoff'
    }

    if ($testControl) { [IO.File]::WriteAllText((Join-Path $testControl 'authenticated-shutdown-ready'), '') }
    [ordered]@{
      phase = 'awaiting-authenticated-shutdown'
      host = 'system-task'
      variant = $Variant
      systemWrapperPid = [int]$wrapperRecord.ProcessId
      remotePid = [int]$remoteRecord.ProcessId
    } | ConvertTo-Json -Compress | Write-Output

    if (-not $remoteProcess.WaitForExit($ShutdownWaitSeconds * 1000)) {
      throw 'Exact SYSTEM-hosted RDC Remote did not complete authenticated graceful shutdown before timeout'
    }
    foreach ($localProcess in $localProcesses) {
      if (-not $localProcess.WaitForExit(5000)) {
        throw 'Exact SYSTEM-hosted RDC local MCP child remained alive after authenticated Remote shutdown'
      }
    }
    if (-not $wrapperProcess.WaitForExit(5000)) {
      throw 'SYSTEM PowerShell wrapper did not exit cleanly after the Remote completed'
    }
    # A Process object attached with GetProcessById can wait for an externally
    # owned process on Windows but may not expose ExitCode. When it does, retain
    # this early negative; the authoritative Task Scheduler result is required
    # below at the Ready/quiescence boundary in every case.
    $attachedWrapperExitCode = $wrapperProcess.ExitCode
    if ($null -ne $attachedWrapperExitCode -and $attachedWrapperExitCode -ne 0) {
      throw "SYSTEM PowerShell wrapper exited non-zero after Remote shutdown ($($wrapperProcess.ExitCode)); replacement launch refused"
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    $lastQuiescenceError = $null
    do {
      try {
        $postInventory = Get-SystemTaskHostInventory $Contract
        Assert-SystemTaskHostQuiesced -TaskInventory $postInventory.Tasks -ProcessInventory $postInventory.Processes -Contract $Contract
        $lastQuiescenceError = $null
        break
      } catch {
        $lastQuiescenceError = $_
        Start-Sleep -Milliseconds 100
      }
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($null -ne $lastQuiescenceError) {
      throw "SYSTEM task host did not become quiescent after graceful shutdown: $($lastQuiescenceError.Exception.Message)"
    }
  } finally {
    foreach ($localProcess in $localProcesses) { if ($null -ne $localProcess) { $localProcess.Dispose() } }
    if ($null -ne $remoteProcess) { $remoteProcess.Dispose() }
    if ($null -ne $wrapperProcess) { $wrapperProcess.Dispose() }
  }
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
  if ($matchingWatchers.Count -gt 1) { throw 'Multiple exact old launcher watchers were found; activation stopped without changes' }
  if ($matchingWatchers.Count -eq 0) {
    $legacyContract = Get-OriginalLauncherRemoteContract
    $systemContract = [pscustomobject]@{
      TaskPath = '\'
      TaskName = 'Codebase44 Remote Desktop Commander SYSTEM'
      WrapperPath = 'C:\Codebase44\system\rdc-system\Start-RemoteDesktopCommanderSystem.ps1'
      NodePath = [string]$legacyContract.Node
      Entrypoint = [string]$legacyContract.Entrypoint
    }
    if ($testControl) {
      $testContractPath = Join-Path $testControl 'system-host-contract.json'
      if (Test-Path -LiteralPath $testContractPath -PathType Leaf) {
        try { $testContract = Get-Content -Raw -LiteralPath $testContractPath | ConvertFrom-Json }
        catch { throw 'Activation test SYSTEM host contract is invalid' }
        if ([string]::IsNullOrWhiteSpace([string]$testContract.WrapperPath)) {
          throw 'Activation test SYSTEM host wrapper path is missing'
        }
        $systemContract.WrapperPath = [IO.Path]::GetFullPath([string]$testContract.WrapperPath)
      }
    }
    try {
      $systemInventory = Get-SystemTaskHostInventory $systemContract
      $systemHost = Assert-ExactSystemTaskHostIdentity -TaskInventory $systemInventory.Tasks -ProcessInventory $systemInventory.Processes -Contract $systemContract
    } catch {
      throw "Watcher command is not exact and no exact SYSTEM task host was authenticated; activation stopped without changes: $($_.Exception.Message)"
    }

    # Only the fully authenticated SYSTEM task may be excluded from the competing
    # orchestrator gate. Any other enabled/running canonical Remote launcher still
    # fails closed before the handoff acquires authority.
    Assert-NoCompetingHostOrchestrator $legacyContract $systemContract.TaskPath $systemContract.TaskName

    $cmdPath = if ($env:SystemRoot) { Join-Path ([IO.Path]::GetFullPath($env:SystemRoot)) 'System32\cmd.exe' } else { $null }
    if (-not $cmdPath -or -not (Test-Path -LiteralPath $cmdPath -PathType Leaf)) {
      throw 'Canonical Windows command processor is unavailable'
    }
    $argumentLine = '/d /s /c ""' + $launcher + '""'
    $startedWrapper = $null
    $launcherReadLock = $null
    try {
      try {
        $launcherReadLock = [IO.File]::Open(
          $launcher, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read
        )
      } catch {
        throw "Unable to lock verified launcher bytes before SYSTEM handoff: $($_.Exception.Message)"
      }
      Assert-VerifiedLauncherStream $launcherReadLock
      if ($testControl -and (Test-Path -LiteralPath (Join-Path $testControl 'fail-replacement-launch') -PathType Leaf)) {
        throw 'Test-controlled replacement launcher failure'
      }

      Invoke-SystemTaskHostGracefulHandoff -HostInfo $systemHost -Contract $systemContract -ShutdownWaitSeconds $ShutdownWaitSeconds -Variant ([string]$validated.variant)

      # The selected runtime is authority-sensitive across the shutdown window.
      # Revalidate it and the immutable launcher bytes before granting launch.
      $postValidationOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installedSupervisor -BenchmarkRoot $root -ValidateOnly 2>&1
      if ($LASTEXITCODE -ne 0) { throw "Installed supervisor post-shutdown validation failed: $($postValidationOutput -join ' ')" }
      try { $postValidated = ($postValidationOutput -join "`n") | ConvertFrom-Json }
      catch { throw 'Installed supervisor post-shutdown validation did not return JSON' }
      if ([string]$postValidated.variant -ne [string]$validated.variant -or
          [string]$postValidated.expectedSha -ne [string]$validated.expectedSha -or
          [string]$postValidated.actualSha -ne [string]$validated.actualSha) {
        throw 'RDC A/B selected runtime changed during SYSTEM authenticated shutdown handoff'
      }
      Assert-VerifiedLauncherStream $launcherReadLock

      $startedWrapper = Start-Process -FilePath $cmdPath -ArgumentList $argumentLine -WindowStyle Hidden -PassThru
      if ($null -eq $startedWrapper) { throw 'Unable to start installed RDC A/B launcher after SYSTEM authenticated shutdown' }
      $startedWrapperPid = $startedWrapper.Id
      if ($startedWrapper.WaitForExit(250)) {
        throw "Installed RDC A/B launcher exited immediately after SYSTEM authenticated handoff (exit $($startedWrapper.ExitCode))"
      }
    } finally {
      if ($null -ne $startedWrapper) { $startedWrapper.Dispose() }
      if ($null -ne $launcherReadLock) { $launcherReadLock.Dispose() }
    }

    [ordered]@{
      phase = 'completed'
      host = 'system-task'
      variant = [string]$validated.variant
      stoppedSystemWrapperPid = [int]$systemHost.WrapperProcess.ProcessId
      startedWrapperPid = $startedWrapperPid
    } | ConvertTo-Json -Compress | Write-Output
    return
  }

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
