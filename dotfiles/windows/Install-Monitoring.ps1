#Requires -Version 7.0
<#
.SYNOPSIS
    Installs the three monitoring agents folly's Prometheus and VictoriaLogs
    expect on a Windows desk.

.DESCRIPTION
    None of the three can come from configuration.winget, for a different
    reason each:

      windows_exporter is in the catalogue, but its manifest offers a portable
      build ahead of the MSI and carries no installer switches. Only the MSI
      registers the service and opens the firewall, and the collector list has
      to be an installer property -- the MSI writes --collectors.enabled onto
      the service command line, and a CLI flag always beats config.yaml, so a
      default install can never be widened by editing that file afterwards.

      OhmGraphite is in neither the catalogue nor the Store.

      Vector's MSI ships no Windows service at all -- it installs a console
      binary and a config path and leaves running it to you.

    So all three are handled here the way the Nerd Font and vibranceGUI are:
    pinned by URL and SHA256, verified before anything is executed, and
    idempotent.

    The cluster half of this is declared in git and needs no action here:
    clusters/folly/monitoring/windows-exporters.yaml is the scrape and the
    alerts, and the UniFi reservations and firewall policies live in
    terraform/network/unifi/folly/. See
    docs/runbooks/install-windows-monitoring.md.

.PARAMETER SkipVector
    Leave Event Log shipping out. The metrics half still installs.

.PARAMETER LogEndpoint
    Where Vector pushes. Overrides the endpoint in the committed config.
#>
[CmdletBinding()]
param(
    [switch] $SkipVector,

    [string] $LogEndpoint,

    [string] $ExporterVersion = '0.31.8',
    [string] $ExporterUrl = 'https://github.com/prometheus-community/windows_exporter/releases/download/v0.31.8/windows_exporter-0.31.8-amd64.msi',
    [string] $ExporterSha256 = '0AADCE6AFB20182B678BFCA9E8F2E8464EF48C469B28B4CF02E99D82158F5D40',

    # [defaults] is cpu, logical_disk, memory, net, os, physical_disk, service
    # and system. gpu adds engine utilisation and VRAM, cpu_info the model,
    # diskdrive per-drive health. thermalzone is deliberately absent: on a
    # desktop board it is one ACPI number that tracks nothing, and the real
    # sensors come from OhmGraphite.
    [string] $EnabledCollectors = '[defaults],gpu,cpu_info,diskdrive',

    [string] $OhmVersion = '0.38.0',
    [string] $OhmUrl = 'https://github.com/nickbabcock/OhmGraphite/releases/download/v0.38.0/OhmGraphite-0.38.0.zip',
    [string] $OhmSha256 = '35dc1fea76f3f2f766ea0d416a1ac01ce61e3e6c239e13aad97b29d7ec9de418',
    [int] $SensorPort = 4445,

    [string] $VectorVersion = '0.58.0',
    [string] $VectorUrl = 'https://packages.timber.io/vector/0.58.0/vector-x64.msi',
    [string] $VectorSha256 = '53b783bf5f39ed317cd9d19da0d654de8a963c5971852b0e87bed1b931af9b29'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Install-Monitoring.ps1 registers machine-wide services and firewall rules. Re-run it from an elevated PowerShell 7.'
}

$here = Split-Path -Parent $PSCommandPath
$configSource = Join-Path $here 'monitoring'

function Get-PinnedFile {
    <#
        Downloads to a temp path, checks the hash, and returns the path. The
        caller deletes it. Nothing is executed before the hash matches.
    #>
    param(
        [Parameter(Mandatory)] [string] $Url,
        [Parameter(Mandatory)] [string] $Sha256,
        [Parameter(Mandatory)] [string] $Extension
    )

    $staging = Join-Path ([IO.Path]::GetTempPath()) "monitoring-$([guid]::NewGuid())$Extension"
    Write-Host "  downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $staging -UseBasicParsing

    $actual = (Get-FileHash -LiteralPath $staging -Algorithm SHA256).Hash
    if ($actual -ne $Sha256.ToUpperInvariant()) {
        Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue
        throw "Hash mismatch for $Url`n  expected $($Sha256.ToUpperInvariant())`n  got      $actual"
    }
    return $staging
}

function Get-InstalledVersion {
    param([Parameter(Mandatory)] [string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-Item -LiteralPath $Path).VersionInfo.ProductVersion
}

function Install-Msi {
    # Runs one msiexec and checks its exit code. The callers above decide
    # whether an install is needed; a -WhatIf here would only duplicate that.
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '')]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [string[]] $Properties = @()
    )

    $msiArgs = @('/i', "`"$Path`"", '/qn', '/norestart') + $Properties
    $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArgs -Wait -PassThru -NoNewWindow
    # 3010 is "success, reboot queued"; nothing here needs the reboot.
    if ($proc.ExitCode -notin 0, 3010) {
        throw "msiexec exited $($proc.ExitCode) for $Path"
    }
}

function Set-FirewallRule {
    # Creates one inbound rule if it is missing. Idempotent by the name check,
    # which is what -WhatIf would buy on a helper this small.
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '')]
    param(
        [Parameter(Mandatory)] [string] $DisplayName,
        [Parameter(Mandatory)] [int] $Port
    )

    if (Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue) {
        Write-Host "  ok       firewall rule '$DisplayName' already in place"
        return
    }
    New-NetFirewallRule -DisplayName $DisplayName -Direction Inbound -Protocol TCP `
        -LocalPort $Port -Action Allow -Profile Any | Out-Null
    Write-Host "  opened   inbound TCP $Port"
}

# --- windows_exporter -------------------------------------------------------

Write-Host ''
Write-Host "==> windows_exporter $ExporterVersion" -ForegroundColor Cyan

$exporterExe = Join-Path $env:ProgramFiles 'windows_exporter\windows_exporter.exe'
$exporterService = Get-CimInstance Win32_Service -Filter "Name='windows_exporter'" -ErrorAction SilentlyContinue

# Reinstall when the version is behind OR when the service is running a
# collector list that is not the one declared here. The second half is what
# catches a host installed with no properties at all, which pins [defaults]
# onto the command line where config.yaml cannot reach it.
$exporterCurrent = (Get-InstalledVersion -Path $exporterExe) -eq $ExporterVersion
$collectorsCurrent = $exporterService -and $exporterService.PathName -match [regex]::Escape($EnabledCollectors)

if ($exporterCurrent -and $collectorsCurrent) {
    Write-Host '  ok       already installed with the declared collectors'
}
else {
    if ($exporterService -and -not $collectorsCurrent) {
        Write-Host "  note     reinstalling: service runs '$($exporterService.PathName)'"
    }
    $msi = Get-PinnedFile -Url $ExporterUrl -Sha256 $ExporterSha256 -Extension '.msi'
    try {
        Install-Msi -Path $msi -Properties @(
            'ADDLOCAL=FirewallException',
            "ENABLED_COLLECTORS=`"$EnabledCollectors`""
        )
        Write-Host "  installed windows_exporter $ExporterVersion on 9182"
    }
    finally {
        Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
    }
}

# --- OhmGraphite ------------------------------------------------------------

Write-Host ''
Write-Host "==> OhmGraphite $OhmVersion" -ForegroundColor Cyan

$ohmDir = Join-Path $env:ProgramFiles 'OhmGraphite'
$ohmExe = Join-Path $ohmDir 'OhmGraphite.exe'
$ohmService = Get-Service -Name 'OhmGraphite' -ErrorAction SilentlyContinue

if ((Get-InstalledVersion -Path $ohmExe) -eq $OhmVersion -and $ohmService) {
    Write-Host '  ok       already installed'
}
else {
    $zip = Get-PinnedFile -Url $OhmUrl -Sha256 $OhmSha256 -Extension '.zip'
    try {
        # The service holds the exe open, so it has to stop before the unpack.
        if ($ohmService) { Stop-Service -Name 'OhmGraphite' -Force -ErrorAction SilentlyContinue }
        New-Item -ItemType Directory -Path $ohmDir -Force | Out-Null
        Expand-Archive -LiteralPath $zip -DestinationPath $ohmDir -Force
        Write-Host "  installed $ohmExe"
    }
    finally {
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    }
}

# Written every run: this is the file that puts it in Prometheus mode, and the
# unpack above overwrites it with the upstream Graphite default.
$ohmConfig = Join-Path $ohmDir 'OhmGraphite.exe.config'
Copy-Item -LiteralPath (Join-Path $configSource 'OhmGraphite.exe.config') -Destination $ohmConfig -Force

if (-not (Get-Service -Name 'OhmGraphite' -ErrorAction SilentlyContinue)) {
    # Registers itself as LocalSystem, which is what lets LibreHardwareMonitor
    # load its kernel driver. Anything less reads every sensor as zero or not
    # at all.
    & $ohmExe install
}
Restart-Service -Name 'OhmGraphite' -Force
Set-FirewallRule -DisplayName 'OhmGraphite' -Port $SensorPort
Write-Host "  running  sensors on $SensorPort"

# --- Vector -----------------------------------------------------------------

if ($SkipVector) {
    Write-Host ''
    Write-Host '==> Vector skipped' -ForegroundColor Yellow
    return
}

Write-Host ''
Write-Host "==> Vector $VectorVersion" -ForegroundColor Cyan

$vectorExe = Join-Path $env:ProgramFiles 'Vector\bin\vector.exe'
$vectorConfig = Join-Path $env:ProgramFiles 'Vector\config\vector.yaml'

if (Test-Path -LiteralPath $vectorExe) {
    Write-Host '  ok       already installed'
}
else {
    $msi = Get-PinnedFile -Url $VectorUrl -Sha256 $VectorSha256 -Extension '.msi'
    try {
        Install-Msi -Path $msi
        Write-Host "  installed $vectorExe"
    }
    finally {
        Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
    }
}

New-Item -ItemType Directory -Path (Split-Path -Parent $vectorConfig) -Force | Out-Null
$config = Get-Content -LiteralPath (Join-Path $configSource 'vector.yaml') -Raw
if ($LogEndpoint) {
    $config = $config -replace '(?m)^(\s*endpoint:\s*).*$', "`${1}$LogEndpoint"
}
Set-Content -LiteralPath $vectorConfig -Value $config -Encoding utf8NoBOM
New-Item -ItemType Directory -Path 'C:\ProgramData\vector' -Force | Out-Null

# The MSI installs a console binary and no service. vector.exe never calls
# StartServiceCtrlDispatcher, so sc.exe create produces a service the SCM
# kills with error 1053 -- a scheduled task at startup is the honest way to
# keep a console process running as SYSTEM, and it needs no wrapper binary.
$taskName = 'Vector'
$action = New-ScheduledTaskAction -Execute $vectorExe -Argument "--config `"$vectorConfig`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $taskName
Write-Host '  running  Event Log shipping to VictoriaLogs' 
