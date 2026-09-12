$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$helper = Join-Path $repoRoot 'scripts\benchmark\rdc-ab\RdcAbEntrypointGuard.ps1'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw 'RDC A/B entrypoint guard helper is missing'
}
. $helper

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('rdc-ab-entrypoint-guard-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
$entrypoint = Join-Path $tempRoot 'index.js'
[IO.File]::WriteAllText($entrypoint, 'guard-fixture')

function Assert-ReopenBlocked([string]$Path) {
    $blocked = $false
    try {
        $probe = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $probe.Dispose()
    } catch [IO.IOException] {
        $blocked = $true
    }
    if (-not $blocked) { throw 'Canonical entrypoint reopened while guard should be exclusive' }
}

$guard = $null
$child = $null
try {
    $guard = Open-RdcAbEntrypointGuard -Path $entrypoint
    Assert-ReopenBlocked $entrypoint
    $cmd = Join-Path ([IO.Path]::GetFullPath($env:SystemRoot)) 'System32\cmd.exe'
    $child = Start-RdcAbGuardedProcess -FilePath $cmd -ArgumentLine '/d /c "ping -n 3 127.0.0.1 >nul"' -Guard $guard
    $guard.Dispose()
    $guard = $null

    Assert-ReopenBlocked $entrypoint
    if (-not $child.WaitForExit(10000)) { throw 'Synthetic guard owner did not exit' }

    $probe = [IO.File]::Open($entrypoint, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    $probe.Dispose()

    $crashReady = Join-Path $tempRoot 'crash-owner-ready'
    $crashScript = Join-Path $tempRoot 'crash-owner.ps1'
    $helperEscaped = $helper.Replace("'", "''")
    $entryEscaped = $entrypoint.Replace("'", "''")
    $readyEscaped = $crashReady.Replace("'", "''")
    $crashSource = @(
        "`$ErrorActionPreference = 'Stop'",
        ". '$helperEscaped'",
        "`$crashGuard = Open-RdcAbEntrypointGuard -Path '$entryEscaped'",
        "[IO.File]::WriteAllText('$readyEscaped', '')",
        "Start-Sleep -Milliseconds 400",
        "[Environment]::Exit(23)"
    ) -join "`r`n"
    [IO.File]::WriteAllText($crashScript, $crashSource)
    $crashOwner = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $crashScript
    ) -PassThru -WindowStyle Hidden
    $crashDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while (-not (Test-Path -LiteralPath $crashReady -PathType Leaf) -and [DateTime]::UtcNow -lt $crashDeadline) {
        Start-Sleep -Milliseconds 25
    }
    if (-not (Test-Path -LiteralPath $crashReady -PathType Leaf)) {
        throw 'Synthetic crashing guard owner did not acquire the canonical entrypoint guard'
    }
    Assert-ReopenBlocked $entrypoint
    if (-not $crashOwner.WaitForExit(5000)) { throw 'Synthetic crashing guard owner did not exit' }
    if ($crashOwner.ExitCode -ne 23) { throw "Synthetic crashing guard owner returned unexpected exit $($crashOwner.ExitCode)" }
    $probe = [IO.File]::Open($entrypoint, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    $probe.Dispose()

    $guard = Open-RdcAbEntrypointGuard -Path $entrypoint
    $guard.Dispose()
    $transferFailed = $false
    try {
        Start-RdcAbGuardedProcess -FilePath $cmd -ArgumentLine '/d /c "exit 0"' -Guard $guard | Out-Null
    } catch {
        $transferFailed = $true
    }
    if (-not $transferFailed) { throw 'Guarded launch with an invalid transfer handle unexpectedly succeeded' }
    $probe = [IO.File]::Open($entrypoint, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    $probe.Dispose()
    Write-Host 'PASS RDC A/B canonical entrypoint guard blocks reopen, transfers ownership, releases on exit, and fails closed on transfer error'
} finally {
    if ($null -ne $guard) { $guard.Dispose() }
    if ($null -ne $child -and -not $child.HasExited) { $child.WaitForExit(10000) | Out-Null }
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}