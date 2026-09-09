$source = Join-Path $PSScriptRoot '..\..\scripts\benchmark\rdc-ab\Activate-RdcAbLauncher.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Activation script has parser errors' }
$wanted = @('Get-HostOrchestratorInventory','Assert-NoCompetingHostOrchestrator')
foreach ($name in $wanted) {
  $node = $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $false) | Select-Object -First 1
  if ($null -eq $node) { throw "Missing orchestrator preflight function: $name" }
  . ([scriptblock]::Create($node.Extent.Text))
}
$scriptPath = Join-Path ([IO.Path]::GetTempPath()) 'rdc-ab-external-host-test.ps1'
$safeScriptPath = Join-Path ([IO.Path]::GetTempPath()) 'rdc-ab-unrelated-host-test.ps1'
$missingScriptPath = Join-Path ([IO.Path]::GetTempPath()) 'rdc-ab-missing-host-test.ps1'
$directoryScriptPath = Join-Path ([IO.Path]::GetTempPath()) 'rdc-ab-directory-host-test'
$entry = 'C:\canonical\dist\index.js'
[IO.File]::WriteAllText($scriptPath, "`$bundle = '$entry'`r`nStart-Process node.exe -ArgumentList @(`$bundle,'remote','--persist-session')`r`n")
[IO.File]::WriteAllText($safeScriptPath, "Write-Output 'unrelated scheduled maintenance'`r`n")
[IO.Directory]::CreateDirectory($directoryScriptPath) | Out-Null
try {
  function Get-HostOrchestratorInventory { @([pscustomobject]@{ TaskName='Synthetic RDC watchdog'; Enabled=$true; State='Ready'; Actions=@([pscustomobject]@{ Execute='powershell.exe'; Arguments=(' -File "' + $scriptPath + '"') }) }) }
  $contract = [pscustomobject]@{ Entrypoint=$entry }
  $threw = $false
  try { Assert-NoCompetingHostOrchestrator $contract } catch { $threw=$true; $message=$_.Exception.Message }
  if (-not $threw) { throw 'Enabled competing orchestrator was accepted' }
  if ($message -notmatch 'competing.+host.+orchestrator|enabled.+orchestrator') { throw "Unexpected rejection: $message" }
  Write-Output 'PASS RDC A/B orchestrator preflight rejects enabled external launcher'
  function Get-HostOrchestratorInventory { @([pscustomobject]@{ TaskName='Synthetic disabled-but-running RDC watchdog'; Enabled=$false; State='Running'; Actions=@([pscustomobject]@{ Execute='powershell.exe'; Arguments=(' -File "' + $scriptPath + '"') }) }) }
  $threw = $false; $message = ''
  try { Assert-NoCompetingHostOrchestrator $contract } catch { $threw=$true; $message=$_.Exception.Message }
  if (-not $threw) { throw 'Disabled but still-running competing orchestrator was accepted' }
  Write-Output 'PASS RDC A/B orchestrator preflight rejects disabled but running external launcher'

  foreach ($case in @(
    @{ Name='missing'; Path=$missingScriptPath },
    @{ Name='non-file'; Path=$directoryScriptPath }
  )) {
    function Get-HostOrchestratorInventory { @([pscustomobject]@{ TaskName="Synthetic $($case.Name) PowerShell host"; Enabled=$true; State='Ready'; Actions=@([pscustomobject]@{ Execute='powershell.exe'; Arguments=(' -File "' + $case.Path + '"') }) }) }
    $threw = $false; $message = ''
    try { Assert-NoCompetingHostOrchestrator $contract } catch { $threw=$true; $message=$_.Exception.Message }
    if (-not $threw) { throw "Enabled PowerShell orchestrator with $($case.Name) script target was accepted" }
    if ($message -notmatch 'unverifiable|inspect|script') { throw "Unexpected unverifiable-script rejection: $message" }
  }
  Write-Output 'PASS RDC A/B orchestrator preflight rejects unverifiable PowerShell scripts'

  function Get-HostOrchestratorInventory { @([pscustomobject]@{ TaskName='Synthetic unrelated PowerShell task'; Enabled=$true; State='Ready'; Actions=@([pscustomobject]@{ Execute='powershell.exe'; Arguments=(' -File "' + $safeScriptPath + '"') }) }) }
  Assert-NoCompetingHostOrchestrator $contract
  Write-Output 'PASS RDC A/B orchestrator preflight allows a readable unrelated PowerShell script'
} finally {
  Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $safeScriptPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $directoryScriptPath -Recurse -Force -ErrorAction SilentlyContinue
}
