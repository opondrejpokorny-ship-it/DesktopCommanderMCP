# Permanent, synthetic-only contract for the explicit SYSTEM scheduled-task
# host mode. This deliberately does not read or mutate Task Scheduler.
$source = Join-Path $PSScriptRoot '..\..\scripts\benchmark\rdc-ab\Activate-RdcAbLauncher.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Activation script has parser errors' }

function Get-FunctionAst([string]$Name) {
  $node = $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name }, $false) |
    Select-Object -First 1
  if ($null -eq $node) { throw "Missing explicit SYSTEM task-host function: $Name" }
  return $node
}

# Load only the pure identity helpers under test; no top-level activation code runs.
foreach ($name in @('ConvertTo-ProcessCreationUtc', 'Get-TrustedWindowsPowerShellPath', 'Assert-ExactSystemTaskDefinition', 'Assert-ExactSystemTaskHostIdentity')) {
  . ([scriptblock]::Create((Get-FunctionAst $name).Extent.Text))
}

$handoff = Get-FunctionAst 'Invoke-SystemTaskHostGracefulHandoff'
$handoffText = $handoff.Extent.Text
if ($handoffText -match '(?i)\b(Set|Register|Unregister|Start|Stop)-ScheduledTask\b') {
  throw 'SYSTEM host handoff must never mutate or directly start/stop the Scheduled Task'
}
if ($handoffText -match '(?i)\.(Kill|CloseMainWindow)\(') {
  throw 'SYSTEM host handoff must not terminate the wrapper, Remote, or local MCP process'
}
if ($handoffText -notmatch '(?i)wrapperProcess\.ExitCode\s*-ne\s*0') {
  throw 'SYSTEM host handoff must fail closed unless the wrapper exits with code 0'
}
foreach ($required in @('awaiting-authenticated-shutdown', 'remoteProcess.WaitForExit', 'localProcess.WaitForExit', 'wrapperProcess.WaitForExit')) {
  if ($handoffText -notmatch [regex]::Escape($required)) {
    throw "SYSTEM host handoff is missing required graceful-handoff evidence: $required"
  }
}
$phaseMarker = $handoffText.IndexOf('awaiting-authenticated-shutdown')
$remoteExit = $handoffText.IndexOf('remoteProcess.WaitForExit')
$localMcpExit = $handoffText.IndexOf('localProcess.WaitForExit')
$wrapperExit = $handoffText.IndexOf('wrapperProcess.WaitForExit')
if ($phaseMarker -lt 0 -or $remoteExit -lt 0 -or $localMcpExit -lt 0 -or $wrapperExit -lt 0 -or
    $phaseMarker -gt $remoteExit -or $remoteExit -gt $localMcpExit -or $localMcpExit -gt $wrapperExit) {
  throw 'SYSTEM wrapper may complete only after authenticated Remote and local MCP exit'
}

$root = 'C:\RDC-System-Host-Test'
$wrapper = Join-Path $root 'Start-RemoteDesktopCommanderSystem.ps1'
$entry = Join-Path $root 'dist\index.js'
$trustedPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$contract = [pscustomobject]@{
  TaskPath = '\'
  TaskName = 'Codebase44 Remote Desktop Commander SYSTEM'
  WrapperPath = $wrapper
  NodePath = 'C:\Program Files\nodejs\node.exe'
  Entrypoint = $entry
}
$task = [pscustomobject]@{
  TaskPath = $contract.TaskPath
  TaskName = $contract.TaskName
  State = 'Running'
  Principal = [pscustomobject]@{ UserId = 'SYSTEM'; LogonType = 'ServiceAccount'; RunLevel = 'Highest' }
  Actions = @([pscustomobject]@{
    Execute = $trustedPowerShell
    Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$wrapper`""
  })
  Settings = [pscustomobject]@{ MultipleInstances='IgnoreNew'; RestartCount=999; RestartInterval='PT1M' }
  Triggers = @([pscustomobject]@{ Class='MSFT_TaskBootTrigger'; Enabled=$true })
}
$processes = @(
  [pscustomobject]@{ Name='svchost.exe'; ProcessId=40; ParentProcessId=4; CreationDate='2026-01-01T00:00:00.000Z'; CommandLine='C:\Windows\system32\svchost.exe -k netsvcs -p -s Schedule' },
  [pscustomobject]@{ Name='powershell.exe'; ProcessId=401; ParentProcessId=40; CreationDate='2026-01-01T00:01:00.000Z'; ExecutablePath=$trustedPowerShell; CommandLine="`"$trustedPowerShell`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$wrapper`"" },
  [pscustomobject]@{ Name='node.exe'; ProcessId=402; ParentProcessId=401; CreationDate='2026-01-01T00:02:00.000Z'; CommandLine="`"$($contract.NodePath)`" $entry remote --persist-session" },
  [pscustomobject]@{ Name='node.exe'; ProcessId=403; ParentProcessId=402; CreationDate='2026-01-01T00:03:00.000Z'; CommandLine="`"$($contract.NodePath)`" $entry" }
)

$hostInfo = Assert-ExactSystemTaskHostIdentity -TaskInventory @($task) -ProcessInventory $processes -Contract $contract
if ($hostInfo.WrapperProcess.ProcessId -ne 401 -or $hostInfo.RemoteProcess.ProcessId -ne 402 -or @($hostInfo.LocalMcpProcesses).Count -ne 1) {
  throw 'SYSTEM task-host matcher did not return the exact wrapper, Remote, and local MCP chain'
}

# Representative identity drift: every case must fail closed before any handoff.
$driftCases = @(
  @{ Name='non-SYSTEM principal'; Tasks=@([pscustomobject]@{ TaskPath=$task.TaskPath; TaskName=$task.TaskName; State='Running'; Principal=[pscustomobject]@{ UserId='S-1-5-21-evil'; LogonType='ServiceAccount'; RunLevel='Highest' }; Actions=$task.Actions; Settings=$task.Settings; Triggers=$task.Triggers }); Processes=$processes },
  @{ Name='untrusted task PowerShell image'; Tasks=@([pscustomobject]@{ TaskPath=$task.TaskPath; TaskName=$task.TaskName; State='Running'; Principal=$task.Principal; Actions=@([pscustomobject]@{ Execute='C:\NotSystem\powershell.exe'; Arguments=$task.Actions[0].Arguments }); Settings=$task.Settings; Triggers=$task.Triggers }); Processes=$processes },
  @{ Name='untrusted wrapper PowerShell image'; Tasks=@($task); Processes=@($processes | ForEach-Object { if ($_.ProcessId -eq 401) { [pscustomobject]@{ Name=$_.Name; ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; CreationDate=$_.CreationDate; ExecutablePath='C:\NotSystem\powershell.exe'; CommandLine="`"C:\NotSystem\powershell.exe`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$wrapper`"" } } else { $_ } }) },
  @{ Name='wrong task action'; Tasks=@([pscustomobject]@{ TaskPath=$task.TaskPath; TaskName=$task.TaskName; State='Running'; Principal=$task.Principal; Actions=@([pscustomobject]@{ Execute='cmd.exe'; Arguments='/c attacker.cmd' }); Settings=$task.Settings; Triggers=$task.Triggers }); Processes=$processes },
  @{ Name='wrong restart semantics'; Tasks=@([pscustomobject]@{ TaskPath=$task.TaskPath; TaskName=$task.TaskName; State='Running'; Principal=$task.Principal; Actions=$task.Actions; Settings=[pscustomobject]@{ MultipleInstances='Parallel'; RestartCount=999; RestartInterval='PT1M' }; Triggers=$task.Triggers }); Processes=$processes },
  @{ Name='wrong trigger'; Tasks=@([pscustomobject]@{ TaskPath=$task.TaskPath; TaskName=$task.TaskName; State='Running'; Principal=$task.Principal; Actions=$task.Actions; Settings=$task.Settings; Triggers=@([pscustomobject]@{ Class='MSFT_TaskLogonTrigger'; Enabled=$true }) }); Processes=$processes },
  @{ Name='wrapper command drift'; Tasks=@($task); Processes=@($processes | ForEach-Object { if ($_.ProcessId -eq 401) { [pscustomobject]@{ Name=$_.Name; ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; CreationDate=$_.CreationDate; CommandLine="$($_.CommandLine) -Command attacker" } } else { $_ } }) },
  @{ Name='wrong wrapper parent'; Tasks=@($task); Processes=@($processes | ForEach-Object { if ($_.ProcessId -eq 401) { [pscustomobject]@{ Name=$_.Name; ProcessId=$_.ProcessId; ParentProcessId=999; CreationDate=$_.CreationDate; CommandLine=$_.CommandLine } } else { $_ } }) },
  @{ Name='non-monotonic start time'; Tasks=@($task); Processes=@($processes | ForEach-Object { if ($_.ProcessId -eq 402) { [pscustomobject]@{ Name=$_.Name; ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; CreationDate='2025-01-01T00:00:00.000Z'; CommandLine=$_.CommandLine } } else { $_ } }) },
  @{ Name='Remote command drift'; Tasks=@($task); Processes=@($processes | ForEach-Object { if ($_.ProcessId -eq 402) { [pscustomobject]@{ Name=$_.Name; ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; CreationDate=$_.CreationDate; CommandLine="`"$($contract.NodePath)`" $entry remote" } } else { $_ } }) }
)
foreach ($case in $driftCases) {
  $rejected = $false
  try { [void](Assert-ExactSystemTaskHostIdentity -TaskInventory $case.Tasks -ProcessInventory $case.Processes -Contract $contract) }
  catch { $rejected = $true }
  if (-not $rejected) { throw "SYSTEM task-host identity drift was accepted: $($case.Name)" }
}
Write-Output 'PASS RDC A/B SYSTEM task-host contract'
