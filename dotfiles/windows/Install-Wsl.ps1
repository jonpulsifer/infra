#Requires -Version 7.0
<#
.SYNOPSIS
    Installs WSL and imports a NixOS distro, then hands off.

.DESCRIPTION
    The last stage of bootstrap.ps1 -WithWsl, and the reason the Windows config
    is the outer ring rather than an afterthought.

    Windows cannot build this repo's own WSL image -- `nix build .#wsl` needs
    Nix, which needs a Linux box -- so the chain is: import an upstream
    NixOS-WSL image, clone this repo inside it, and let the distro rebuild
    itself from nix/images/wsl.nix. Pass -TarballPath to import an image built
    here instead, which skips the upstream hop.

    This script stops at the handoff. It does not run nixos-rebuild: that wants
    the sops age key in place and a human watching, and what happens inside the
    distro is nix/'s business, not Windows'.

.PARAMETER Name
    Distro name to import as.

.PARAMETER TarballPath
    A locally built image (`nix build .#wsl`). Without it, the latest upstream
    NixOS-WSL release is downloaded.

.PARAMETER Location
    Where the distro's virtual disk lives.
#>
[CmdletBinding()]
param(
    [string] $Name = 'NixOS',
    [string] $TarballPath,
    [string] $Location = (Join-Path $env:LOCALAPPDATA 'WSL')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$existing = wsl.exe --list --quiet 2>$null | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($existing -contains $Name) {
    Write-Host "  ok       distro '$Name' already exists; leaving it alone"
    Write-Host '  (a distro is somebody'' s running machine -- this script will not replace one)'
    return
}

# --no-distribution turns on the WSL components without dragging in Ubuntu.
Write-Host '  enabling WSL components'
wsl.exe --install --no-distribution

$downloaded = $null
try {
    if (-not $TarballPath) {
        Write-Host '  fetching the latest NixOS-WSL release'
        $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/nix-community/NixOS-WSL/releases/latest' -UseBasicParsing
        $asset = $release.assets | Where-Object { $_.name -eq 'nixos.wsl' } | Select-Object -First 1
        if (-not $asset) {
            throw 'No nixos.wsl asset in the latest NixOS-WSL release.'
        }

        $downloaded = Join-Path ([IO.Path]::GetTempPath()) 'nixos.wsl'
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $downloaded -UseBasicParsing
        $TarballPath = $downloaded

        Write-Host "  got $($release.tag_name)"
    }

    New-Item -ItemType Directory -Path $Location -Force | Out-Null

    Write-Host "  importing '$Name' into $Location"
    wsl.exe --install --from-file $TarballPath --name $Name --location (Join-Path $Location $Name)
    wsl.exe --set-default $Name
}
finally {
    if ($downloaded) {
        Remove-Item -LiteralPath $downloaded -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host "Distro '$Name' is up. Finish inside it:" -ForegroundColor Green
Write-Host @"
  wsl -d $Name

  # the distro's own clone -- nothing is shared across the boundary
  git clone https://github.com/jonpulsifer/infra ~/src/github.com/jonpulsifer/infra
  cd ~/src/github.com/jonpulsifer/infra

  # the sops operator age key goes to ~/.config/age/keys.txt first;
  # see docs/pages/Runbooks___SOPS Secrets and Age Keys.md
  sudo nixos-rebuild switch --flake .#wsl
"@
