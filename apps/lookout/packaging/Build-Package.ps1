#Requires -Version 7.0
<#
.SYNOPSIS
    Publishes the agent and the tray and builds Lookout.msi.

.DESCRIPTION
    Needs the .NET SDK and the wix dotnet tool (`dotnet tool install --global wix`).
    The MSI is unsigned: msiexec installs it, and SmartScreen asks once on a
    downloaded copy. Each build replaces the last through the fixed UpgradeCode
    in Lookout.wxs, which is how the agent upgrades itself.

.PARAMETER Version
    The package version, three parts. Defaults to Version in Directory.Build.props.

.PARAMETER OutputDirectory
    Where Lookout.msi lands.
#>
[CmdletBinding()]
param(
    [string] $Version,
    [string] $OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root 'out' }
if (-not $Version) {
    $props = [xml](Get-Content -LiteralPath (Join-Path $root 'Directory.Build.props') -Raw)
    $Version = $props.Project.PropertyGroup.Version
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version '$Version' is not major.minor.patch" }

$publish = Join-Path $OutputDirectory 'publish'
if (Test-Path -LiteralPath $publish) { Remove-Item -LiteralPath $publish -Recurse -Force }

Write-Host "==> Publishing $Version" -ForegroundColor Cyan
foreach ($project in 'Agent', 'Tray') {
    dotnet publish (Join-Path $root "src\Lookout.$project") --configuration Release --nologo `
        -p:Version=$Version --output (Join-Path $publish $project)
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish exited $LASTEXITCODE for Lookout.$project" }
}

Write-Host '==> Building the MSI' -ForegroundColor Cyan
$msi = Join-Path $OutputDirectory 'Lookout.msi'
wix build (Join-Path $PSScriptRoot 'Lookout.wxs') -arch x64 -out $msi `
    -d "Version=$Version" `
    -d "AgentDir=$(Join-Path $publish 'Agent')" `
    -d "TrayDir=$(Join-Path $publish 'Tray')"
if ($LASTEXITCODE -ne 0) { throw "wix exited $LASTEXITCODE" }

$hash = (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash
Write-Host "Built $msi" -ForegroundColor Green
Write-Host "SHA256 $hash"
