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

    The download is checked against a pinned SHA256 before it is unpacked.

.PARAMETER Url
    Release asset to install.

.PARAMETER Sha256
    Expected hash of that asset.

.PARAMETER Force
    Install even when the family is already registered.
#>
[CmdletBinding()]
param(
    [string] $Url = 'https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/CascadiaCode.zip',
    [string] $Sha256 = '1298bf92698afa06185cf1d05e6ae05f2d8a1e8c3cb45ddf4c3035168ab342a1',
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

$work = Join-Path ([IO.Path]::GetTempPath()) "nerdfont-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
    Write-Host "  downloading $Url"
    $archive = Join-Path $work 'CascadiaCode.zip'
    Invoke-WebRequest -Uri $Url -OutFile $archive -UseBasicParsing

    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if ($actual -ne $Sha256.ToUpperInvariant()) {
        throw "Hash mismatch for $Url`n  expected $($Sha256.ToUpperInvariant())`n  got      $actual"
    }

    Expand-Archive -LiteralPath $archive -DestinationPath $work -Force

    # The filter skips the Mono and Propo variants.
    $fonts = Get-ChildItem -LiteralPath $work -Filter "$familyPrefix`NerdFont-*.ttf"
    if (-not $fonts) {
        throw "No $familyPrefix`NerdFont-*.ttf found in the archive -- did the release layout change?"
    }

    New-Item -ItemType Directory -Path $fontDir -Force | Out-Null
    New-Item -Path $registryKey -Force | Out-Null

    foreach ($font in $fonts) {
        $destination = Join-Path $fontDir $font.Name
        Copy-Item -LiteralPath $font.FullName -Destination $destination -Force

        # Windows reads the family name from the font file. The registry name only has to exist.
        $displayName = [IO.Path]::GetFileNameWithoutExtension($font.Name) -replace '-', ' '

        Set-ItemProperty -Path $registryKey -Name "$displayName (TrueType)" -Value $destination
        Write-Host "  installed $displayName"
    }

    Write-Host '  font installed; already-open terminals need a restart to see it'
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
