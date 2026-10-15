#Requires -Version 7.0
<#
.SYNOPSIS
    Publishes the agent and the tray and packs them into one MSIX.

.DESCRIPTION
    Runs on Windows with the .NET SDK and the Windows SDK (makeappx, signtool).
    The package is unsigned unless -CertificatePath is given, and Windows
    installs only a signed package, so a local build without the certificate
    is a build check, not an installer.

.PARAMETER Version
    The package version, three parts. Defaults to Version in Directory.Build.props.

.PARAMETER OutputDirectory
    Where Lookout.msix and Lookout.appinstaller land.

.PARAMETER CertificatePath
    A PFX whose subject is the Publisher in AppxManifest.xml.

.PARAMETER CertificatePassword
    The PFX password.

.PARAMETER InstallerBaseUrl
    When set, writes Lookout.appinstaller pointing at <url>/Lookout.msix.
#>
[CmdletBinding()]
param(
    [string] $Version,
    [string] $OutputDirectory,
    [string] $CertificatePath,
    [securestring] $CertificatePassword,
    [string] $InstallerBaseUrl
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

function Find-SdkTool {
    param([Parameter(Mandatory)] [string] $Name)
    $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $tool = Get-ChildItem -Path $kits -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^10\.' } |
        Sort-Object { [version] $_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName "x64\$Name" } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if (-not $tool) { throw "$Name is missing. Install the Windows SDK." }
    return $tool
}

$layout = Join-Path $OutputDirectory 'layout'
if (Test-Path -LiteralPath $layout) { Remove-Item -LiteralPath $layout -Recurse -Force }
New-Item -ItemType Directory -Path $layout -Force | Out-Null

Write-Host "==> Publishing $Version" -ForegroundColor Cyan
foreach ($project in 'Agent', 'Tray') {
    dotnet publish (Join-Path $root "src\Lookout.$project") --configuration Release --nologo `
        -p:Version=$Version --output (Join-Path $layout $project)
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish exited $LASTEXITCODE for Lookout.$project" }
}

Copy-Item -Path (Join-Path $PSScriptRoot 'Assets') -Destination (Join-Path $layout 'Assets') -Recurse
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'AppxManifest.xml') -Raw
Set-Content -LiteralPath (Join-Path $layout 'AppxManifest.xml') -Value ($manifest -replace '__VERSION__', "$Version.0") -Encoding utf8NoBOM

Write-Host '==> Packing' -ForegroundColor Cyan
$msix = Join-Path $OutputDirectory 'Lookout.msix'
& (Find-SdkTool 'makeappx.exe') pack /d $layout /p $msix /o
if ($LASTEXITCODE -ne 0) { throw "makeappx exited $LASTEXITCODE" }

if ($CertificatePath) {
    Write-Host '==> Signing' -ForegroundColor Cyan
    $password = if ($CertificatePassword) { ConvertFrom-SecureString -SecureString $CertificatePassword -AsPlainText } else { '' }
    & (Find-SdkTool 'signtool.exe') sign /fd SHA256 /f $CertificatePath /p $password $msix
    if ($LASTEXITCODE -ne 0) { throw "signtool exited $LASTEXITCODE" }
}
else {
    Write-Warning 'Unsigned: Windows will not install this package.'
}

if ($InstallerBaseUrl) {
    $template = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Lookout.appinstaller.template') -Raw
    $installer = $template -replace '__VERSION__', "$Version.0" -replace '__BASE__', $InstallerBaseUrl.TrimEnd('/')
    Set-Content -LiteralPath (Join-Path $OutputDirectory 'Lookout.appinstaller') -Value $installer -Encoding utf8NoBOM
}

Write-Host "Built $msix" -ForegroundColor Green
