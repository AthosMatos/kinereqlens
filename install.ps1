# kineReqLens installer for Windows (Windows PowerShell 5.1 or PowerShell 7). From the root of a clone:
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 [-Yes] [-WithClaude | -NoClaude]
#       [-Browser edge|chrome|chromium|brave|all] [-Update] [-NoOpen] [-DryRun] [-Help]
#
# GNU spellings work too (--yes, --with-claude, --browser chrome, ...). This script makes sure Node.js >= 20 and npm
# are there (it prints how to install them, and offers winget when run in a console), then hands over to
# scripts\installer.mjs, which installs the dependencies, builds the extension and the Claude Code bridge, sets the
# bridge up (optional; HKCU registry keys, no administrator rights) and shows how to load dist\ in the browser.
# Safe to run again. Details: INSTALL.md
#
# Keep this file ASCII and Windows PowerShell 5.1 compatible: no ternaries, no ??, no && / ||.

$ErrorActionPreference = 'Continue'
$MinNodeMajor = 20
$Root = $PSScriptRoot
if (-not $Root) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }

$UseColor = $true
try {
    if ([Console]::IsOutputRedirected) { $UseColor = $false }
} catch {
    $UseColor = $false
}
if ($null -ne $env:NO_COLOR) { $UseColor = $false }

function Write-Problem([string]$Text) {
    if ($UseColor) { Write-Host $Text -ForegroundColor Red } else { Write-Host $Text }
}

function Write-Hint([string]$Text) {
    Write-Host ('  ' + $Text)
}

# Arguments as plain strings: "-Browser edge,chrome" arrives as an array.
$PassArgs = @()
foreach ($arg in $args) {
    if ($arg -is [System.Array]) { $PassArgs += ($arg -join ',') } else { $PassArgs += [string]$arg }
}
$Yes = $false
foreach ($arg in $PassArgs) {
    $flag = (($arg -replace '^-+', '') -replace '-', '').ToLowerInvariant()
    if ($flag -eq 'yes' -or $flag -eq 'y') { $Yes = $true }
}

function Get-NodeVersion {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return '' }
    $version = & node --version 2>$null
    return ([string]$version).Trim()
}

function Test-NodeReady {
    $version = Get-NodeVersion
    if ($version -notmatch '^v(\d+)\.') { return $false }
    if ([int]$Matches[1] -lt $MinNodeMajor) { return $false }
    return [bool](Get-Command npm -ErrorAction SilentlyContinue)
}

function Test-Interactive {
    try {
        return ([Environment]::UserInteractive -and -not ([Console]::IsInputRedirected) -and -not ([Console]::IsOutputRedirected))
    } catch {
        return $false
    }
}

function Show-NodeHelp {
    $found = Get-NodeVersion
    if (-not $found) {
        Write-Problem "kineReqLens needs Node.js $MinNodeMajor or newer and npm: Node.js was not found."
    } elseif (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Problem "kineReqLens needs npm, which was not found (Node.js $found is installed)."
    } else {
        Write-Problem "kineReqLens needs Node.js $MinNodeMajor or newer (found $found)."
    }
    Write-Host 'Install it, open a new PowerShell window, then run the installer again:'
    Write-Hint 'winget:    winget install OpenJS.NodeJS.LTS'
    Write-Hint 'Installer: https://nodejs.org/en/download'
    Write-Hint '(nvm-windows, fnm and Volta work too)'
}

if (-not (Test-NodeReady)) {
    Show-NodeHelp
    # winget only after an explicit yes (never with -Yes, never without a console).
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget -and -not $Yes -and (Test-Interactive)) {
        $answer = Read-Host 'Install Node.js LTS with winget now (winget install OpenJS.NodeJS.LTS; Windows may ask for permission)? [y/N]'
        if ($answer -match '^(y|yes)$') {
            & winget install --id OpenJS.NodeJS.LTS --exact --source winget
            # winget updates PATH for new windows only: reload it for this one.
            $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
            $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
            $env:Path = $machinePath + ';' + $userPath
        }
    }
    if (-not (Test-NodeReady)) { exit 1 }
}

& node (Join-Path $Root 'scripts\installer.mjs') install @PassArgs
exit $LASTEXITCODE
