#Requires -Version 7.0
<#
.SYNOPSIS
    PSScriptAnalyzer over the Windows dotfiles.

.DESCRIPTION
    Runs on the Linux CI runner as well as on Windows -- pwsh comes from mise
    (aqua:PowerShell/PowerShell), so the .ps1 files here get the same treatment
    the bash scripts get from shellcheck.
#>
[CmdletBinding()]
param(
    [string] $Path = $PSScriptRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Module -ListAvailable -Name PSScriptAnalyzer)) {
    Write-Host 'Installing PSScriptAnalyzer...'
    Install-PSResource -Name PSScriptAnalyzer -Scope CurrentUser -TrustRepository -AcceptLicense
}

Import-Module PSScriptAnalyzer

$settings = Join-Path $PSScriptRoot 'PSScriptAnalyzerSettings.psd1'
# @() keeps a single finding a collection. Under StrictMode, .Count on a lone record throws.
$results = @(Invoke-ScriptAnalyzer -Path $Path -Recurse -Severity Error, Warning -Settings $settings)

if ($results) {
    $results | Format-Table -AutoSize -Property Severity, ScriptName, Line, RuleName, Message
    Write-Error "$($results.Count) PSScriptAnalyzer finding(s)."
    exit 1
}

Write-Host 'PSScriptAnalyzer: clean.'
