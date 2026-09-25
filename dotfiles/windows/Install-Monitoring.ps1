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

    # No thermalzone: on a desktop board it is one ACPI value that tracks nothing.
    # OhmGraphite reads the real sensors.
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
    # The caller deletes the returned file.
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
    # Callers decide whether to install, so ShouldProcess would only repeat that.
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '')]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [string[]] $Properties = @()
    )

    $msiArgs = @('/i', "`"$Path`"", '/qn', '/norestart') + $Properties
    $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArgs -Wait -PassThru -NoNewWindow
    # 3010 is success with a reboot pending.
    if ($proc.ExitCode -notin 0, 3010) {
        throw "msiexec exited $($proc.ExitCode) for $Path"
    }
}

function Uninstall-Msi {
    param([Parameter(Mandatory)] [string] $ProductCode)

    $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/x', $ProductCode, '/qn', '/norestart') `
        -Wait -PassThru -NoNewWindow
    # 1605 is a product this account never installed. 3010 is success with a reboot pending.
    if ($proc.ExitCode -notin 0, 1605, 3010) {
        throw "msiexec exited $($proc.ExitCode) removing $ProductCode"
    }
}

function Set-FirewallRule {
    # The name check makes it idempotent, so ShouldProcess adds nothing.
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

Write-Host ''
Write-Host "==> windows_exporter $ExporterVersion" -ForegroundColor Cyan

$exporterExe = Join-Path $env:ProgramFiles 'windows_exporter\windows_exporter.exe'
$exporterService = Get-CimInstance Win32_Service -Filter "Name='windows_exporter'" -ErrorAction SilentlyContinue

# Also reinstall when the service runs other collectors. The MSI puts them on the
# service command line, where config.yaml cannot override them.
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

# Copied every run: it sets Prometheus mode, and an unpack restores the Graphite default.
$ohmConfig = Join-Path $ohmDir 'OhmGraphite.exe.config'
Copy-Item -LiteralPath (Join-Path $configSource 'OhmGraphite.exe.config') -Destination $ohmConfig -Force

if (-not (Get-Service -Name 'OhmGraphite' -ErrorAction SilentlyContinue)) {
    # Installs as LocalSystem, which LibreHardwareMonitor needs to load its kernel driver.
    & $ohmExe install
}
Restart-Service -Name 'OhmGraphite' -Force
Set-FirewallRule -DisplayName 'OhmGraphite' -Port $SensorPort
Write-Host "  running  sensors on $SensorPort"

if ($SkipVector) {
    Write-Host ''
    Write-Host '==> Vector skipped' -ForegroundColor Yellow
    return
}

Write-Host ''
Write-Host "==> Vector $VectorVersion" -ForegroundColor Cyan

$vectorExe = Join-Path $env:ProgramFiles 'Vector\bin\vector.exe'
$vectorConfig = Join-Path $env:ProgramFiles 'Vector\config\vector.yaml'
$taskName = 'Vector'

# vector.exe has no version resource, so its ProductVersion is empty. The binary reports its own.
$vectorInstalled = $null
if ((Test-Path -LiteralPath $vectorExe) -and ("$(& $vectorExe --version)" -match '^vector (\S+)')) {
    $vectorInstalled = $Matches[1]
}

if ($vectorInstalled -eq $VectorVersion) {
    Write-Host '  ok       already installed'
}
else {
    $msi = Get-PinnedFile -Url $VectorUrl -Sha256 $VectorSha256 -Extension '.msi'
    try {
        # The task holds vector.exe open.
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $vectorExe) {
            # Every Vector MSI has this ProductCode and no upgrade table, so msiexec
            # refuses a new version (1638) until the old one is removed.
            Uninstall-Msi -ProductCode '{7FAD6F97-D84E-42CC-A600-5F4EC3460FF5}'
            Write-Host "  removed  Vector $vectorInstalled"
        }
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

# vector.exe is a console binary: as an sc.exe service the SCM kills it with error
# 1053. A SYSTEM task at startup keeps it running.
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
