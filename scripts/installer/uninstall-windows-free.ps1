param(
    [string]$InstallRoot = '',
    [string]$StartupDir = '',
    [switch]$Synchronous
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($StartupDir)) {
    $StartupDir = [Environment]::GetFolderPath('Startup')
}

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
        throw "Refusing unsafe uninstall root: $full"
    }
    return $full
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

$InstallRoot = Assert-SafeInstallRoot $InstallRoot
$manifestPath = Join-Path $InstallRoot 'runtime-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Refusing uninstall because Desktop Commander runtime manifest is missing: $manifestPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.kind -ne 'desktop-commander-windows-free-runtime-v1') {
    throw 'Refusing uninstall because the runtime manifest kind is not recognized.'
}

Stop-OwnedRuntime $InstallRoot

$startupFile = Join-Path $StartupDir 'DesktopCommanderFree.vbs'
if (Test-Path -LiteralPath $startupFile) {
    $startupText = Get-Content -LiteralPath $startupFile -Raw -ErrorAction SilentlyContinue
    if ($startupText -and $startupText.IndexOf($InstallRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Remove-Item -LiteralPath $startupFile -Force
    }
}

if ($Synchronous) {
    Set-Location ([IO.Path]::GetTempPath())
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force
    Write-Output "Desktop Commander Free uninstalled from $InstallRoot"
    exit 0
}

$tempCmd = Join-Path ([IO.Path]::GetTempPath()) ("desktop-commander-free-uninstall-" + [Guid]::NewGuid().ToString('N') + '.cmd')
$escapedRoot = $InstallRoot.Replace('"', '""')
$cmd = @"
@echo off
ping 127.0.0.1 -n 3 >nul
rmdir /s /q "$escapedRoot"
del /f /q "%~f0"
"@
Set-Content -LiteralPath $tempCmd -Value $cmd -Encoding Ascii
Start-Process -FilePath $env:ComSpec -ArgumentList '/d', '/c', ('"' + $tempCmd + '"') -WindowStyle Hidden
Write-Output "Desktop Commander Free uninstall scheduled for $InstallRoot"
