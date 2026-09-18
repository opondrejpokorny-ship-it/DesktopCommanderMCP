param(
    [string]$InstallRoot = '',
    [string]$StartupDir = '',
    [switch]$NoLaunch,
    [switch]$NoStartup,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    if ($env:DC_INSTALL_ROOT) {
        $InstallRoot = $env:DC_INSTALL_ROOT
    } else {
        $InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\DesktopCommanderFree'
    }
}
if ([string]::IsNullOrWhiteSpace($StartupDir)) {
    if ($env:DC_STARTUP_DIR) {
        $StartupDir = $env:DC_STARTUP_DIR
    } else {
        $StartupDir = [Environment]::GetFolderPath('Startup')
    }
}
if ($env:DC_INSTALL_NO_LAUNCH -eq '1') { $NoLaunch = $true }
if ($env:DC_INSTALL_NO_STARTUP -eq '1') { $NoStartup = $true }
if ($env:DC_INSTALL_QUIET -eq '1') { $Quiet = $true }

function Get-NormalizedPath([string]$Value) {
    return [IO.Path]::GetFullPath($Value).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Assert-SafeInstallRoot([string]$Value) {
    $full = Get-NormalizedPath $Value
    $forbidden = @(
        (Get-NormalizedPath ([IO.Path]::GetPathRoot($full))),
        (Get-NormalizedPath $env:USERPROFILE),
        (Get-NormalizedPath $env:LOCALAPPDATA),
        (Get-NormalizedPath $env:TEMP)
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    if ($full.Length -lt 12 -or $forbidden -contains $full) {
        throw "Refusing unsafe install root: $full"
    }
    return $full
}

function Assert-ContainedPath([string]$Root, [string]$RelativePath) {
    if ([IO.Path]::IsPathRooted($RelativePath)) {
        throw "Runtime manifest contains rooted path: $RelativePath"
    }
    $normalizedRoot = (Get-NormalizedPath $Root) + [IO.Path]::DirectorySeparatorChar
    $candidate = [IO.Path]::GetFullPath((Join-Path $Root $RelativePath))
    if (-not $candidate.StartsWith($normalizedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Runtime manifest escapes install staging root: $RelativePath"
    }
    return $candidate
}

function Expand-VerifiedRuntimeArchive([string]$Archive, [string]$Destination) {
    $tarPath = Join-Path $env:WINDIR 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $tarPath -PathType Leaf)) {
        throw 'Windows tar.exe is required to install Desktop Commander Free.'
    }

    $entries = & $tarPath -tf $Archive 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to inspect Desktop Commander runtime archive.'
    }
    foreach ($entry in $entries) {
        $value = ([string]$entry).Trim()
        if ([string]::IsNullOrWhiteSpace($value)) { continue }
        $normalized = $value.Replace('\', '/')
        if ($normalized.StartsWith('/') -or $normalized -match '^[A-Za-z]:') {
            throw "Runtime archive contains rooted path: $value"
        }
        $segments = $normalized.Split('/') | Where-Object { $_ -ne '' -and $_ -ne '.' }
        if ($segments -contains '..') {
            throw "Runtime archive contains traversal path: $value"
        }
    }

    & $tarPath -xf $Archive -C $Destination
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to extract Desktop Commander runtime archive.'
    }
}

function Stop-OwnedRuntime([string]$Root) {
    $pidFile = Join-Path $Root 'runtime.pid'
    if (-not (Test-Path -LiteralPath $pidFile)) { return }
    $rawPid = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
    $runtimePid = 0
    if ([int]::TryParse($rawPid, [ref]$runtimePid) -and $runtimePid -gt 0) {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$runtimePid" -ErrorAction SilentlyContinue
        if ($processInfo) {
            $expectedNode = Get-NormalizedPath (Join-Path $Root 'node.exe')
            $actualNode = if ($processInfo.ExecutablePath) { Get-NormalizedPath $processInfo.ExecutablePath } else { '' }
            if ($actualNode -eq $expectedNode) {
                Stop-Process -Id $runtimePid -Force -ErrorAction SilentlyContinue
                try { Wait-Process -Id $runtimePid -Timeout 10 -ErrorAction SilentlyContinue } catch {}
            }
        }
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

function Write-StartVbs([string]$Root, [string]$Destination) {
    $nodePath = Join-Path $Root 'node.exe'
    $launcherPath = Join-Path $Root 'launcher.mjs'
    $command = '"' + $nodePath + '" "' + $launcherPath + '"'
    $escapedCommand = $command.Replace('"', '""')
    $vbs = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "$escapedCommand", 0, False
"@
    $parent = Split-Path -Parent $Destination
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Set-Content -LiteralPath $Destination -Value $vbs -Encoding Ascii
}

$InstallRoot = Assert-SafeInstallRoot $InstallRoot
$payloadRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeZip = Join-Path $payloadRoot 'runtime.zip'
$payloadManifestPath = Join-Path $payloadRoot 'payload-manifest.json'

if (-not (Test-Path -LiteralPath $runtimeZip)) { throw 'Installer payload runtime.zip is missing.' }
if (-not (Test-Path -LiteralPath $payloadManifestPath)) { throw 'Installer payload manifest is missing.' }

$payloadManifest = Get-Content -LiteralPath $payloadManifestPath -Raw | ConvertFrom-Json
if ($payloadManifest.kind -ne 'desktop-commander-windows-free-installer-payload-v1') {
    throw 'Installer payload manifest kind is invalid.'
}
$runtimeZipHash = (Get-FileHash -LiteralPath $runtimeZip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($runtimeZipHash -ne [string]$payloadManifest.runtimeZipSha256) {
    throw 'Installer runtime.zip SHA-256 does not match the payload manifest.'
}

$parentRoot = Split-Path -Parent $InstallRoot
New-Item -ItemType Directory -Force -Path $parentRoot | Out-Null
$staging = $InstallRoot + '.installing-' + $PID + '-' + [Guid]::NewGuid().ToString('N')
$backup = $InstallRoot + '.backup-' + $PID + '-' + [Guid]::NewGuid().ToString('N')
$hadExisting = Test-Path -LiteralPath $InstallRoot

try {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    Expand-VerifiedRuntimeArchive $runtimeZip $staging

    $runtimeManifestPath = Join-Path $staging 'runtime-manifest.json'
    if (-not (Test-Path -LiteralPath $runtimeManifestPath)) {
        throw 'Extracted runtime manifest is missing.'
    }
    $runtimeManifest = Get-Content -LiteralPath $runtimeManifestPath -Raw | ConvertFrom-Json
    if ($runtimeManifest.kind -ne 'desktop-commander-windows-free-runtime-v1') {
        throw 'Extracted runtime manifest kind is invalid.'
    }
    foreach ($critical in $runtimeManifest.criticalFiles) {
        $candidate = Assert-ContainedPath $staging ([string]$critical.path)
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "Critical runtime file is missing: $($critical.path)"
        }
        $actualHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne [string]$critical.sha256) {
            throw "Critical runtime file hash mismatch: $($critical.path)"
        }
    }

    if ($hadExisting) {
        Stop-OwnedRuntime $InstallRoot
        $oldLogs = Join-Path $InstallRoot 'logs'
        if (Test-Path -LiteralPath $oldLogs) {
            Copy-Item -LiteralPath $oldLogs -Destination (Join-Path $staging 'logs') -Recurse -Force -ErrorAction SilentlyContinue
        }
        Move-Item -LiteralPath $InstallRoot -Destination $backup
    }
    Move-Item -LiteralPath $staging -Destination $InstallRoot

    if ($hadExisting -and (Test-Path -LiteralPath $backup)) {
        Remove-Item -LiteralPath $backup -Recurse -Force
    }

    $startVbs = Join-Path $InstallRoot 'start-hidden.vbs'
    Write-StartVbs $InstallRoot $startVbs

    $openControlCenter = @"
@echo off
start "" "http://127.0.0.1:17831/"
"@
    Set-Content -LiteralPath (Join-Path $InstallRoot 'open-control-center.cmd') -Value $openControlCenter -Encoding Ascii

    if (-not $NoStartup) {
        $startupFile = Join-Path $StartupDir 'DesktopCommanderFree.vbs'
        Write-StartVbs $InstallRoot $startupFile
    }

    if (-not $NoLaunch) {
        Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $startVbs + '"')
        $controlCenterReady = $false
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            Start-Sleep -Milliseconds 250
            try {
                $response = Invoke-WebRequest -Uri 'http://127.0.0.1:17831/' -UseBasicParsing -TimeoutSec 1
                if ($response.StatusCode -eq 200) {
                    $controlCenterReady = $true
                    break
                }
            } catch {}
        }
        if ($controlCenterReady -and -not $Quiet) {
            Start-Process 'http://127.0.0.1:17831/'
        }
    }

    $mode = if ($hadExisting) { 'repaired' } else { 'installed' }
    Write-Output ("Desktop Commander Free {0}: {1}" -f $mode, $InstallRoot)
} catch {
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $InstallRoot)) {
        Move-Item -LiteralPath $backup -Destination $InstallRoot -ErrorAction SilentlyContinue
    }
    throw
} finally {
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}
