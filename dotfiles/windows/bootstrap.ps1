<#
.SYNOPSIS
    Takes a bare Windows box to a working desk.

.DESCRIPTION
    Run it with:

        irm https://raw.githubusercontent.com/jonpulsifer/infra/main/dotfiles/windows/bootstrap.ps1 | iex

    Stages, each idempotent and safe to re-run:

      0. Re-exec under PowerShell 7 -- the one-liner above may well land in
         Windows PowerShell 5.1, so everything in this file has to parse there.
         No ternaries, no ?? and no && in this script for that reason.
      1. Check winget is present.
      2. winget configure the DSC file: applications and OS settings, including
         the Developer Mode that lets the deploy create symlinks unelevated.
      3. Clone the repo, sparse, just dotfiles/.
      4. mise run bootstrap, which routes to bootstrap:windows.
      5. Optionally install the monitoring agents, so the box reports to the
         folly cluster's Grafana.
      6. Optionally install WSL and hand off to the Linux bootstrap inside it.

    Windows is the outer ring here: it installs WSL, not the other way round.
    Nothing in this bootstrap reads anything from inside the distro.

.PARAMETER WithWsl
    Also install WSL and run the Linux dotfiles bootstrap inside the default
    distro. Left out of a routine re-run so that reshaping the shell config
    never touches the distro.

.PARAMETER WithMonitoring
    Also install windows_exporter, OhmGraphite and Vector, so folly's
    Prometheus and VictoriaLogs can see this box. Left out of a routine re-run
    because it is the only stage that needs an elevated process; this one
    prompts for it.

.PARAMETER SkipConfiguration
    Skip the winget configure pass. Useful when only the dotfiles changed.
#>
[CmdletBinding()]
param(
    [switch] $WithWsl,
    [switch] $WithMonitoring,
    [switch] $SkipConfiguration
)

$ErrorActionPreference = 'Stop'

$RepoSlug = 'jonpulsifer/infra'
$RawBase = "https://raw.githubusercontent.com/$RepoSlug/main/dotfiles/windows"
$BootstrapUrl = "$RawBase/bootstrap.ps1"
$CheckoutPath = Join-Path $env:USERPROFILE 'src\github.com\jonpulsifer\infra'

function Write-Stage {
    param([string] $Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Test-Command {
    param([string] $Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    return $null -ne $command
}

# Only reloads this process's PATH, so ShouldProcess does not apply.
function Update-SessionPath {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '')]
    param()

    # winget writes PATH to the registry only, so tools it just installed need this.
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:PATH = "$machine;$user"
}

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Stage 'Windows PowerShell 5.1 detected, moving to PowerShell 7'

    if (-not (Test-Command 'winget')) {
        throw 'winget (App Installer) is missing. Install it from the Microsoft Store, then run this again.'
    }

    if (-not (Test-Command 'pwsh')) {
        winget install --id Microsoft.PowerShell --source winget `
            --accept-package-agreements --accept-source-agreements
        Update-SessionPath
    }

    if (-not (Test-Command 'pwsh')) {
        throw 'PowerShell 7 still is not on PATH. Open a new terminal and run this again.'
    }

    # Under `irm | iex` there is no file on disk to hand to pwsh.
    $arguments = @('-NoProfile', '-Command', "irm $BootstrapUrl | iex")
    if ($WithWsl) {
        $arguments = @('-NoProfile', '-Command', "& ([scriptblock]::Create((irm $BootstrapUrl))) -WithWsl")
    }

    & pwsh @arguments
    return
}

if (-not (Test-Command 'winget')) {
    throw 'winget (App Installer) is missing. Install it from the Microsoft Store, then run this again.'
}

if (-not $SkipConfiguration) {
    Write-Stage 'Applying the winget configuration (applications and OS settings)'

    $localConfiguration = Join-Path $CheckoutPath 'dotfiles\windows\configuration.winget'
    $temporaryConfiguration = $null

    if (Test-Path -LiteralPath $localConfiguration) {
        $configuration = $localConfiguration
    }
    else {
        # First run: there is no checkout yet, and this configuration installs git.
        $temporaryConfiguration = Join-Path ([IO.Path]::GetTempPath()) 'configuration.winget'
        Invoke-WebRequest -Uri "$RawBase/configuration.winget" -OutFile $temporaryConfiguration -UseBasicParsing
        $configuration = $temporaryConfiguration
    }

    winget configure --file $configuration `
        --accept-configuration-agreements --disable-interactivity

    if ($temporaryConfiguration) {
        Remove-Item -LiteralPath $temporaryConfiguration -Force -ErrorAction SilentlyContinue
    }

    Update-SessionPath
}

Write-Stage "Checking out $RepoSlug to $CheckoutPath"

if (-not (Test-Command 'git')) {
    throw 'git is missing. Run without -SkipConfiguration so the configuration pass installs it.'
}

if (Test-Path -LiteralPath (Join-Path $CheckoutPath '.git')) {
    git -C $CheckoutPath pull --ff-only
}
else {
    New-Item -ItemType Directory -Path (Split-Path -Parent $CheckoutPath) -Force | Out-Null

    # Only dotfiles/ is needed. Git for Windows defaults core.autocrlf to true,
    # which rewrites the checkout.
    git clone --filter=blob:none --sparse -c core.autocrlf=false `
        "https://github.com/$RepoSlug.git" $CheckoutPath
    git -C $CheckoutPath sparse-checkout set dotfiles
}

Write-Stage 'Running the dotfiles bootstrap'

if (-not (Test-Command 'mise')) {
    throw 'mise is missing. Run without -SkipConfiguration so the configuration pass installs it.'
}

$dotfiles = Join-Path $CheckoutPath 'dotfiles'
mise trust --yes (Join-Path $dotfiles 'mise.toml')
mise run --cd $dotfiles bootstrap

Write-Stage 'Installing the terminal font'
& (Join-Path $dotfiles 'windows\Install-NerdFont.ps1')

# -AutoStart adds the login entry. The tray app does nothing until it runs.
Write-Stage 'Installing vibranceGUI'
& (Join-Path $dotfiles 'windows\Install-VibranceGui.ps1') -AutoStart

# The only stage that needs elevation. The rest of the bootstrap runs unelevated.
if ($WithMonitoring) {
    Write-Stage 'Installing the monitoring agents'
    $installMonitoring = Join-Path $dotfiles 'windows\Install-Monitoring.ps1'
    $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()

    if ($identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        & $installMonitoring
    }
    else {
        Write-Host 'Elevating -- the agents run as machine-wide services.'
        $elevated = Start-Process -FilePath (Get-Process -Id $PID).Path `
            -ArgumentList @('-NoProfile', '-File', "`"$installMonitoring`"") `
            -Verb RunAs -Wait -PassThru
        if ($elevated.ExitCode -ne 0) {
            throw "Install-Monitoring.ps1 exited $($elevated.ExitCode)"
        }
    }
}

if ($WithWsl) {
    Write-Stage 'Installing WSL and handing off to the Linux bootstrap'
    & (Join-Path $dotfiles 'windows\Install-Wsl.ps1')
}

Write-Host ''
Write-Host 'Done. Open a new PowerShell 7 tab to pick up the profile.' -ForegroundColor Green
