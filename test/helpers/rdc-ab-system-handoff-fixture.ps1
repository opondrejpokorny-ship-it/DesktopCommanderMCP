$ErrorActionPreference = 'Stop'
$nodePath = [Environment]::GetEnvironmentVariable('RDC_AB_FIXTURE_NODE')
$entrypoint = [Environment]::GetEnvironmentVariable('RDC_AB_FIXTURE_ENTRYPOINT')
$signals = [Environment]::GetEnvironmentVariable('RDC_AB_FIXTURE_SIGNALS')
if ([string]::IsNullOrWhiteSpace($nodePath) -or
    [string]::IsNullOrWhiteSpace($entrypoint) -or
    [string]::IsNullOrWhiteSpace($signals)) {
  throw 'SYSTEM handoff fixture environment is incomplete'
}

$remote = Start-Process -FilePath $nodePath -ArgumentList @(
  ('"' + $entrypoint + '"'), 'remote', '--persist-session'
) -WindowStyle Hidden -PassThru
[IO.File]::WriteAllText((Join-Path $signals 'system-wrapper-pid'), [string]$PID)
[IO.File]::WriteAllText((Join-Path $signals 'system-remote-pid'), [string]$remote.Id)
$remote.WaitForExit()
[IO.File]::WriteAllText((Join-Path $signals 'system-wrapper-exit'), '')
if (Test-Path -LiteralPath (Join-Path $signals 'system-wrapper-nonzero') -PathType Leaf) {
  exit 17
}
exit $remote.ExitCode
