#Requires -Version 7.0
<#
.SYNOPSIS
    Installs the pinned PowerShell Gallery modules listed in modules.psd1.

.DESCRIPTION
    Uses Install-PSResource, which is in-box from PowerShell 7.4 onward -- no
    PowerShellGet v2 bootstrap. Idempotent: a module already at the pinned
    version is left alone.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$modules = Import-PowerShellDataFile -Path (Join-Path $PSScriptRoot 'modules.psd1')

foreach ($name in $modules.Keys) {
    $version = $modules[$name]
    $installed = Get-Module -ListAvailable -Name $name |
        Where-Object { $_.Version.ToString() -eq $version }

    if ($installed) {
        Write-Host "  ok       $name $version"
        continue
    }

    Write-Host "  installing $name $version"
    Install-PSResource -Name $name -Version $version -Scope CurrentUser `
        -TrustRepository -AcceptLicense -Reinstall:$false
}
