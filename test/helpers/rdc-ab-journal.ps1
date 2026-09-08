$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '..\..\scripts\benchmark\rdc-ab\Run-RdcAbSupervisor.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Supervisor has parser errors' }
# Load the actual recovery functions without starting a supervisor or Remote.
foreach ($function in $ast.FindAll({ param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
  $node.Name -match '^(Get-RdcAbNamespaceSealJournal|Set-RdcAbNamespaceSealJournal|Test-RdcAbJournalRemoteChildAlive|Assert-RdcAbNamespaceSealJournal|Complete-RdcAbRuntimeSeal|Recover-RdcAbRuntimeNamespaceSeal)$'
}, $false)) {
  . ([scriptblock]::Create($function.Extent.Text))
}
function Assert-Throws($Action, [string]$Label) {
  $threw = $false
  try { & $Action | Out-Null } catch { $threw = $true }
  if (-not $threw) { throw $Label }
}
$journal = [pscustomobject]@{
  Entrypoint = 'C:\synthetic-runtime\dist\index.js'
  ChildPid = 42
  ChildStartUtc = '2026-09-08T00:00:00.0000000Z'
  SupervisorPid = 21
}
# Simulate an unavailable OS identity read; no real process is targeted.
function Get-CimInstance { @([pscustomobject]@{
  ProcessId = 42; ParentProcessId = 21
  CommandLine = 'node "C:\synthetic-runtime\dist\index.js" remote'
}) }
function Get-Process { throw 'Synthetic identity inspection unavailable' }
Assert-Throws { Test-RdcAbJournalRemoteChildAlive $journal } 'Unknown child identity must block recovery'
function Get-CimInstance { @([pscustomobject]@{
  ProcessId = 42; ParentProcessId = 21; CommandLine = $null
}) }
Assert-Throws { Test-RdcAbJournalRemoteChildAlive $journal } 'Unavailable command line must block recovery'
Write-Output 'PASS RDC A/B journal recovery refuses uncertain process identity'

# A lost second journal publication leaves ChildPid zero. Parent identity may
# no longer be observable; recovery must still recognize this runtime in use.
$journal.ChildPid = 0
$journal.ChildStartUtc = ''
function Get-CimInstance { @([pscustomobject]@{
  ProcessId = 42; ParentProcessId = 999
  CommandLine = 'node "C:/synthetic-runtime/dist/index.js" remote'
}) }
if (-not (Test-RdcAbJournalRemoteChildAlive $journal)) { throw 'Unpublished child identity must preserve an in-use runtime' }
function Get-CimInstance { @() }
if (Test-RdcAbJournalRemoteChildAlive $journal) { throw 'Empty successful process inventory should permit recovery' }
Write-Output 'PASS RDC A/B journal recovery checks runtime use without parent identity'

# Test cleanup against a synthetic child handle and synthetic ACL operations.
# The real cleanup function must positively establish child exit first.
$script:cleanup = @()
function Close-SealedRuntime { $script:cleanup += 'close' }
function Remove-RdcAbRuntimeNamespaceSeal { $script:cleanup += 'unseal' }
function Assert-RdcAbRuntimeTreeAcl { $script:cleanup += 'baseline' }
function Remove-Item { $script:cleanup += 'delete' }
function Test-Path { $true }
$root = 'C:\synthetic-runtime'
$namespaceSealJournal = 'C:\synthetic-runtime\journal.json'
$journal | Add-Member Repository $root
$journal | Add-Member OwnerSid 'S-1-5-21-1-2-3-1001'
Assert-Throws {
  Complete-RdcAbRuntimeSeal -Journal $journal -SealedRuntime @{} -Child ([pscustomobject]@{ HasExited = $false })
} 'A live child must prevent cleanup'
if ($script:cleanup.Count) { throw 'Cleanup mutated protection while child was alive' }
Complete-RdcAbRuntimeSeal -Journal $journal -SealedRuntime @{} -Child ([pscustomobject]@{ HasExited = $true })
if (($script:cleanup -join ',') -ne 'close,unseal,baseline,delete') { throw 'Cleanup requires baseline verification before journal deletion' }
$script:cleanup = @()
function Remove-RdcAbRuntimeNamespaceSeal { throw 'Synthetic partially applied ACL' }
function Assert-RdcAbRuntimeTreeAcl { throw 'Synthetic baseline verification failure' }
Assert-Throws { Complete-RdcAbRuntimeSeal -Journal $journal -SealedRuntime @{} -Child $null } 'Uncertain ACL state must preserve the journal'
if ($script:cleanup -contains 'delete') { throw 'Journal was deleted with an uncertain ACL state' }
Write-Output 'PASS RDC A/B journal cleanup requires confirmed exit and restored ACL baseline'

Microsoft.PowerShell.Management\Remove-Item Function:\Remove-Item
# Remove the test doubles before exercising real file publication.
Microsoft.PowerShell.Management\Remove-Item Function:\Test-Path
$journal = [pscustomobject]@{
  SchemaVersion = 1
  Repository = 'C:\synthetic-runtime'
  CanonicalRepository = 'C:\synthetic-runtime'
  Entrypoint = 'C:\synthetic-runtime\dist\index.js'
  CanonicalEntrypoint = 'C:\synthetic-runtime\dist\index.js'
  OwnerSid = 'S-1-5-21-1-2-3-1001'
  Rights = 123
  SupervisorPid = 21
  SupervisorStartUtc = '2026-09-08T00:00:00.0000000Z'
  ChildPid = 0
  ChildStartUtc = ''
}
Assert-RdcAbNamespaceSealJournal $journal
foreach ($invalid in @($null, @{}, @{ SchemaVersion = 1 }, @($journal, $journal))) {
  Assert-Throws { Assert-RdcAbNamespaceSealJournal $invalid } 'Malformed journal must be rejected'
}
Write-Output 'PASS RDC A/B journal schema rejects incomplete recovery records'

. (Join-Path $PSScriptRoot '..\..\scripts\benchmark\rdc-ab\RdcAbAcl.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('rdc-ab-journal-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$namespaceSealJournal = Join-Path $root 'journal.json'
try {
  Set-RdcAbProtectedRootAcl $root
  Set-RdcAbNamespaceSealJournal $journal
  if ((Get-RdcAbNamespaceSealJournal).ChildPid -ne 0) { throw 'Initial journal publication is invalid' }
  $before = [IO.File]::ReadAllText($namespaceSealJournal)
  $journal.ChildPid = 42
  $journal.ChildStartUtc = '2026-09-08T00:00:01.0000000Z'
  $readLock = [IO.File]::Open($namespaceSealJournal, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    Assert-Throws { Set-RdcAbNamespaceSealJournal $journal } 'Locked target must refuse journal replacement'
    if ([IO.File]::ReadAllText($namespaceSealJournal) -cne $before) { throw 'Failed publication damaged the last valid journal' }
  } finally { $readLock.Dispose() }
  Set-RdcAbNamespaceSealJournal $journal
  if ((Get-RdcAbNamespaceSealJournal).ChildPid -ne 42) { throw 'Updated journal publication is invalid' }
  if (@(Get-ChildItem -LiteralPath $root -Filter '*.tmp').Count -ne 0) { throw 'Publication left temporary files' }
  [IO.File]::WriteAllText($namespaceSealJournal, '{')
  Assert-Throws { Get-RdcAbNamespaceSealJournal } 'Truncated journal must block recovery'
  if ([IO.File]::ReadAllText($namespaceSealJournal) -cne '{') { throw 'Malformed journal was changed during read' }
} finally {
  # This directory is created exclusively by this fixture beneath OS temp.
  [IO.Directory]::Delete($root, $true)
}
Write-Output 'PASS RDC A/B journal atomic publication preserves the last complete record'

# Exercise the real recovery entry point with synthetic OS/ACL states at each
# journal boundary. No runtime is started and no live process is manipulated.
$root = 'C:\synthetic-runtime'
$script:operations = @()
$script:inventory = @()
$script:sealPresent = $false
$script:baselineValid = $true
function Get-RdcAbNamespaceSealJournal { $journal }
function Get-RdcAbRuntimeNamespaceSealRights { 123 }
function Get-CimInstance { $script:inventory }
function Get-Process { throw 'Synthetic process inspection unavailable' }
function Assert-LexicallyWithinRoot { param($Path) $Path }
function ConvertTo-CanonicalExistingPath { param($Path) $Path }
function Test-Path { $true }
function Remove-RdcAbRuntimeNamespaceSeal {
  $script:operations += 'unseal'
  if (-not $script:sealPresent) { throw 'Synthetic seal absent' }
  $script:sealPresent = $false
}
function Assert-RdcAbRuntimeTreeAcl {
  $script:operations += 'baseline'
  if (-not $script:baselineValid) { throw 'Synthetic baseline invalid' }
}
function Remove-Item { $script:operations += 'delete' }
foreach ($sealPresent in @($false, $true)) {
  $script:operations = @()
  $script:sealPresent = $sealPresent
  Recover-RdcAbRuntimeNamespaceSeal
  if ($script:operations[-1] -ne 'delete' -or $script:operations[-2] -ne 'baseline') {
    throw 'Recovery must verify the restored baseline before deleting its journal'
  }
}
foreach ($childPid in @(0, 42)) {
  $script:operations = @()
  $journal.ChildPid = $childPid
  $script:inventory = @([pscustomobject]@{
    ProcessId = 42; ParentProcessId = 999
    CommandLine = 'node "C:\synthetic-runtime\dist\index.js" remote'
  })
  Assert-Throws { Recover-RdcAbRuntimeNamespaceSeal } 'Live or uncertain child must block the recovery entry point'
  if ($script:operations.Count) { throw 'Recovery mutated a runtime with live or uncertain process identity' }
}
$script:inventory = @()
$script:operations = @()
$script:sealPresent = $false
$script:baselineValid = $false
Assert-Throws { Recover-RdcAbRuntimeNamespaceSeal } 'Failed ACL recovery must preserve the journal'
if ($script:operations -contains 'delete') { throw 'Recovery deleted journal after failed ACL verification' }
Write-Output 'PASS RDC A/B recovery handles synthetic crash-boundary states without unsafe mutation'
