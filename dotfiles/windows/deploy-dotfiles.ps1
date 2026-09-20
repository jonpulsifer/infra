#Requires -Version 7.0
<#
.SYNOPSIS
    Symlinks the Windows dotfiles into place. The Windows half of
    scripts/deploy-dotfiles.sh.

.DESCRIPTION
    Every link created here stays on the Windows side of the WSL boundary. The
    distro keeps its own clone and runs the bash deployer; git is what keeps the
    two in sync. Symlinking across \\wsl.localhost would mean the profile could
    not load until the VM woke up, so we do not do it.

    Safe to run repeatedly: an existing link pointing at the right place is left
    alone, and a real file in the way is moved aside before it is replaced.

.PARAMETER DryRun
    Resolve and report every link without touching the filesystem. Exits
    non-zero if any source is missing, which is what CI checks.

.PARAMETER SkipModules
    Skip the PSGallery module install.
#>
[CmdletBinding()]
param(
    [switch] $DryRun,
    [switch] $SkipModules
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$DotfilesDir = Split-Path -Parent $PSScriptRoot
$WindowsDir = $PSScriptRoot
$script:Problems = 0

function Write-Step { param([string] $Message) Write-Host "  $Message" }
function Write-Problem {
    param([string] $Message)
    $script:Problems++
    Write-Warning $Message
}

function Test-DeveloperMode {
    $key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
    $value = Get-ItemProperty -Path $key -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue
    return $null -ne $value -and $value.AllowDevelopmentWithoutDevLicense -eq 1
}

function Test-Elevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# -DryRun is this script's ShouldProcess: it covers the whole run rather than
# each link, because the useful question is "does every source still resolve",
# and the answer has to be an exit code CI can read.
function New-Link {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '')]
    param(
        [Parameter(Mandatory)] [string] $Source,
        [Parameter(Mandatory)] [string] $Target
    )

    if (-not (Test-Path -LiteralPath $Source)) {
        Write-Problem "source missing, skipping: $Source"
        return
    }

    $existing = Get-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue
    if ($existing -and $existing.LinkType -eq 'SymbolicLink') {
        # ResolveLinkTarget follows the chain; compare the real paths so a link
        # that already points at this repo is left untouched.
        $current = $existing.ResolveLinkTarget($true)
        if ($current -and $current.FullName -eq (Resolve-Path -LiteralPath $Source).Path) {
            Write-Step "ok       $Target"
            return
        }
    }

    if ($DryRun) {
        Write-Step "would link $Target -> $Source"
        return
    }

    $parent = Split-Path -Parent $Target
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    # A real file or directory in the way is somebody's hand-made config. Move
    # it aside rather than deleting it -- Windows Terminal in particular can
    # replace its own settings.json on update, and that content is worth
    # keeping around until it has been looked at.
    if ($existing) {
        if ($existing.LinkType -eq 'SymbolicLink') {
            $existing.Delete()
        }
        else {
            $backup = "$Target.bak-$(Get-Date -Format yyyyMMddHHmmss)"
            Move-Item -LiteralPath $Target -Destination $backup -Force
            Write-Step "backed up existing file to $backup"
        }
    }

    New-Item -ItemType SymbolicLink -Path $Target -Target $Source -Force | Out-Null
    Write-Step "linked   $Target -> $Source"
}

function Get-WindowsTerminalSettingsPath {
    # The package family name carries a publisher hash, so it has to be
    # discovered rather than hardcoded. Preview and stable install side by side;
    # prefer stable.
    $packages = Get-ChildItem -Path "$env:LOCALAPPDATA\Packages" -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'Microsoft.WindowsTerminal_*' } |
        Sort-Object Name
    if (-not $packages) { return $null }
    return Join-Path $packages[0].FullName 'LocalState\settings.json'
}

Write-Host "Deploying Windows dotfiles from $DotfilesDir..."

if (-not $DryRun) {
    if (-not (Test-DeveloperMode) -and -not (Test-Elevated)) {
        throw @'
Developer Mode is off and this shell is not elevated, so creating symlinks will
fail. Run `winget configure --file windows/configuration.winget` first -- its
DeveloperMode resource is there precisely so this deploy does not need admin.
'@
    }
}

# --- Shell ------------------------------------------------------------------

New-Link -Source (Join-Path $WindowsDir 'profile.ps1') -Target $PROFILE.CurrentUserAllHosts
New-Link -Source (Join-Path $WindowsDir 'profile.d') -Target "$HOME\.config\powershell\profile.d"

# --- Git --------------------------------------------------------------------

# The shared config is reused, not forked: git on Windows reads
# ~/.config/git/config just as it does on Unix. windows/gitconfig lands at
# ~/.gitconfig, includes that file, and overrides the handful of things that
# differ (autocrlf, Win32-OpenSSH, the native op-ssh-sign.exe and the public
# key literal it signs with).
New-Link -Source (Join-Path $DotfilesDir '.config\git') -Target "$HOME\.config\git"
New-Link -Source (Join-Path $WindowsDir 'gitconfig') -Target "$HOME\.gitconfig"

# --- mise -------------------------------------------------------------------

New-Link -Source (Join-Path $DotfilesDir 'mise-global-config.toml') -Target "$HOME\.config\mise\config.toml"

# --- Editor -----------------------------------------------------------------

# The nvim config is pure Lua with no Unix path assumptions, so it crosses
# unchanged. Neovim reads %LOCALAPPDATA%\nvim on Windows.
New-Link -Source (Join-Path $DotfilesDir '.config\nvim') -Target "$env:LOCALAPPDATA\nvim"

# Deliberately not linked: .ssh/config. It carries ControlMaster and a
# `Match exec "test $(uname -s) = Darwin"` block that Win32-OpenSSH does not
# understand, and git -- the only thing here that ssh's -- needs nothing from
# it. The 1Password Windows agent serves keys over its named pipe.

# --- Terminal ---------------------------------------------------------------

$terminalSettings = Get-WindowsTerminalSettingsPath
if ($terminalSettings) {
    New-Link -Source (Join-Path $WindowsDir 'windows-terminal\settings.json') -Target $terminalSettings
}
else {
    Write-Step 'Windows Terminal not installed, skipping its settings'
}

# --- Agents -----------------------------------------------------------------

$agentInstructions = Join-Path $DotfilesDir '.agents\AGENTS.md'
foreach ($target in @(
        "$HOME\.agents\AGENTS.md"
        "$HOME\.claude\CLAUDE.md"
        "$HOME\.codex\AGENTS.md"
        "$HOME\.gemini\GEMINI.md"
    )) {
    New-Link -Source $agentInstructions -Target $target
}

$skills = Join-Path $DotfilesDir 'skills'
foreach ($target in @("$HOME\.agents\skills", "$HOME\.claude\skills")) {
    New-Link -Source $skills -Target $target
}

New-Link -Source (Join-Path $DotfilesDir '.claude\settings.json') -Target "$HOME\.claude\settings.json"

# --- PowerShell modules -----------------------------------------------------

if (-not $SkipModules -and -not $DryRun) {
    & (Join-Path $WindowsDir 'Install-Modules.ps1')
}

if ($script:Problems -gt 0) {
    Write-Error "$script:Problems problem(s) -- see warnings above."
    exit 1
}

Write-Host 'Windows dotfiles deployed.'
