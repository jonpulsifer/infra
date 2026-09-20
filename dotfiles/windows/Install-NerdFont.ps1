<#
.SYNOPSIS
    Installs CaskaydiaCove Nerd Font for the current user.

.DESCRIPTION
    The font is not in the winget catalogue -- winget's font support does not
    cover the ryanoasis patched families -- so configuration.winget cannot
    declare it and this script handles it instead. Per-user, no elevation, and
    idempotent: an already-registered family is left alone.

    Keeping this font is the point: it is the same family the ghostty config
    uses on macOS and NixOS, so the terminal looks the same everywhere.
#>
[CmdletBinding()]
param(
    # Bump to move to a newer Nerd Fonts release.
    [string] $Version = 'v3.5.1',
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$familyPrefix = 'CaskaydiaCove'
$fontDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'
$registryKey = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Fonts'

if (-not $Force) {
    $existing = Get-Item -LiteralPath $registryKey -ErrorAction SilentlyContinue
    if ($existing -and ($existing.GetValueNames() | Where-Object { $_ -like "$familyPrefix*" })) {
        Write-Host "  ok       $familyPrefix Nerd Font already installed"
        return
    }
}

$url = "https://github.com/ryanoasis/nerd-fonts/releases/download/$Version/CascadiaCode.zip"
$work = Join-Path ([IO.Path]::GetTempPath()) "nerdfont-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
    Write-Host "  downloading CascadiaCode.zip ($Version)"
    $archive = Join-Path $work 'CascadiaCode.zip'
    Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing

    Expand-Archive -LiteralPath $archive -DestinationPath $work -Force

    # Only the proportional family; the Mono and Propo variants are extra
    # weight for a terminal that wants the default one.
    $fonts = Get-ChildItem -LiteralPath $work -Filter "$familyPrefix`NerdFont-*.ttf"
    if (-not $fonts) {
        throw "No $familyPrefix`NerdFont-*.ttf found in the archive -- did the release layout change?"
    }

    New-Item -ItemType Directory -Path $fontDir -Force | Out-Null
    New-Item -Path $registryKey -Force | Out-Null

    foreach ($font in $fonts) {
        $destination = Join-Path $fontDir $font.Name
        Copy-Item -LiteralPath $font.FullName -Destination $destination -Force

        # Windows reads the real family name out of the file's name table when
        # it loads the font; this registry entry only has to exist and point at
        # it, so a name derived from the filename is enough.
        $displayName = [IO.Path]::GetFileNameWithoutExtension($font.Name) -replace '-', ' '

        Set-ItemProperty -Path $registryKey -Name "$displayName (TrueType)" -Value $destination
        Write-Host "  installed $displayName"
    }

    Write-Host '  font installed; already-open terminals need a restart to see it'
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
