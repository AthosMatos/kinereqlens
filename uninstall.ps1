# kineReqLens uninstaller for Windows (Windows PowerShell 5.1 or PowerShell 7). From the root of the clone:
#
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 [-Yes] [-NoClaude] [-Browser <name>] [-DryRun] [-Help]
#
# Removes the native messaging host (HKCU registry keys, manifest, launcher) and, after asking, the "reqlens" MCP
# server from Claude Code (scripts\installer.mjs uninstall), then shows how to remove the extension from the browser.
# Never deletes this folder or $REQLENS_HOME. Without Node.js it removes the registry keys and files directly
# (-DryRun / -WhatIf only prints what it would remove).
#
# Keep this file ASCII and Windows PowerShell 5.1 compatible: no ternaries, no ??, no && / ||.

$ErrorActionPreference = 'Continue'
$MinNodeMajor = 20
$Root = $PSScriptRoot
if (-not $Root) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }

# Arguments as plain strings: "-Browser edge,chrome" arrives as an array.
$PassArgs = @()
foreach ($arg in $args) {
    if ($arg -is [System.Array]) { $PassArgs += ($arg -join ',') } else { $PassArgs += [string]$arg }
}
$DryRun = $false
$Help = $false
foreach ($arg in $PassArgs) {
    $flag = (($arg -replace '^-+', '') -replace '-', '').ToLowerInvariant()
    if ($flag -eq 'dryrun' -or $flag -eq 'whatif') { $DryRun = $true }
    if ($flag -eq 'help' -or $flag -eq 'h' -or $flag -eq '?') { $Help = $true }
}

function Test-NodeReady {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
    $version = ([string](& node --version 2>$null)).Trim()
    if ($version -notmatch '^v(\d+)\.') { return $false }
    return ([int]$Matches[1] -ge $MinNodeMajor)
}

if (Test-NodeReady) {
    & node (Join-Path $Root 'scripts\installer.mjs') uninstall @PassArgs
    exit $LASTEXITCODE
}

if ($Help) {
    Write-Host 'Usage: uninstall.ps1 [-Yes] [-NoClaude] [-Browser <name>] [-DryRun]  (Node.js 20+ not found: registry keys and files only)'
    exit 0
}

# Windows PowerShell 5.1 has no $IsWindows (and only runs on Windows).
$IsWin = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
if (-not $IsWin) {
    Write-Host 'Node.js 20+ not found. On macOS / Linux run ./uninstall.sh instead.'
    exit 1
}

Write-Host 'Node.js 20+ not found: removing the native messaging host registry keys and files directly.'

function Remove-Entry([string]$Target, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Target)) { return }
    if ($DryRun) {
        Write-Host ('  would remove ' + $Label)
        return
    }
    try {
        Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction Stop
        Write-Host ('  Removed ' + $Label)
    } catch {
        Write-Host ('  Could not remove ' + $Label + ': ' + $_.Exception.Message)
    }
}

$keys = @(
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.reqlens.bridge',
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.reqlens.bridge',
    'HKCU:\Software\Chromium\NativeMessagingHosts\com.reqlens.bridge',
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.reqlens.bridge'
)
foreach ($key in $keys) { Remove-Entry $key ($key -replace '^HKCU:', 'HKCU') }

$ReqlensHome = $env:REQLENS_HOME
if (-not $ReqlensHome) { $ReqlensHome = Join-Path $env:USERPROFILE '.reqlens' }
foreach ($name in @('com.reqlens.bridge.json', 'native-host.cmd')) {
    $file = Join-Path $ReqlensHome $name
    Remove-Entry $file $file
}

Write-Host 'Claude Code: if you registered the MCP server, run:  claude mcp remove reqlens -s user'
Write-Host 'Browser: open edge://extensions (chrome://extensions, brave://extensions) -> kineReqLens -> Remove'
Write-Host ('Left in place: this folder (' + $Root + ') and ' + $ReqlensHome + '.')
