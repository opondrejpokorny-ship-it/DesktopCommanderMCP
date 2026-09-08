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
$entry = 'C:\canonical\dist\index.js'
[IO.File]::WriteAllText($scriptPath, "`$bundle = '$entry'`r`nStart-Process node.exe -ArgumentList @(`$bundle,'remote','--persist-session')`r`n")
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
} finally { Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue }
