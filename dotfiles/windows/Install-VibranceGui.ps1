#Requires -Version 7.0
<#
.SYNOPSIS
    Installs vibranceGUI for the current user.

.DESCRIPTION
    Digital vibrance control that raises saturation while a game is in the
    foreground and restores the desktop level on alt-tab. It is in neither the
    winget catalogue nor the Store, so configuration.winget cannot declare it
    and this handles it the same way the Nerd Font does: pinned, verified,
    per-user, idempotent.

    Upstream is juv/vibranceGUI. Its only published release is v2.5.0, which
    carries GitHub's prerelease flag but is what the project ships. There is a
    much newer v3.0.0 from a fork -- days old, zero stars, no established
    provenance -- and this does not use it. For something that loads at login
    and drives the GPU driver, an unreviewed fork is a poor trade for a version
    bump. Point -Url and -Sha256 at it deliberately if that changes.

    The download is checked against a pinned SHA256 before anything is run.

.PARAMETER AutoStart
    Also place a shortcut in the Startup folder so it loads at login.

.PARAMETER Url
    Release asset to install.

.PARAMETER Sha256
    Expected hash of that asset.
#>
[CmdletBinding()]
param(
    [switch] $AutoStart,
    [string] $Url = 'https://github.com/juv/vibranceGUI/releases/download/v2.5.0/vibranceGUI.exe',
    [string] $Sha256 = '28d74ac1fed2704a6b974e9aaeac0274b089ff8930db81cf9aa430e820b1a1fb'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\vibranceGUI'
$target = Join-Path $installDir 'vibranceGUI.exe'

function Test-Installed {
    if (-not (Test-Path -LiteralPath $target)) { return $false }
    return (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -eq $Sha256.ToUpperInvariant()
}

function New-Shortcut {
    # Overwrites one known .lnk, so ShouldProcess adds nothing.
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '')]
    param([string] $Path, [string] $TargetPath)

    $shell = New-Object -ComObject WScript.Shell
    try {
        $shortcut = $shell.CreateShortcut($Path)
        $shortcut.TargetPath = $TargetPath
        $shortcut.WorkingDirectory = Split-Path -Parent $TargetPath
        $shortcut.Save()
    }
    finally {
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
    }
}

if (Test-Installed) {
    Write-Host '  ok       vibranceGUI already installed at the pinned version'
}
else {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null

    $staging = Join-Path ([IO.Path]::GetTempPath()) "vibranceGUI-$([guid]::NewGuid()).exe"
    try {
        Write-Host '  downloading vibranceGUI'
        Invoke-WebRequest -Uri $Url -OutFile $staging -UseBasicParsing

        $actual = (Get-FileHash -LiteralPath $staging -Algorithm SHA256).Hash
        if ($actual -ne $Sha256.ToUpperInvariant()) {
            throw "Hash mismatch for $Url`n  expected $($Sha256.ToUpperInvariant())`n  got      $actual"
        }

        Move-Item -LiteralPath $staging -Destination $target -Force
        Write-Host "  installed $target"
    }
    finally {
        Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue
    }
}

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\vibranceGUI.lnk'
New-Shortcut -Path $startMenu -TargetPath $target

$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\vibranceGUI.lnk'
if ($AutoStart) {
    New-Shortcut -Path $startup -TargetPath $target
    Write-Host '  loads at login'
}
elseif (Test-Path -LiteralPath $startup) {
    Write-Host '  note: a Startup shortcut is already in place, leaving it'
}
