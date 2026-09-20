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

# Changes nothing outside this process: it re-reads PATH from the registry into
# the running shell, which is the opposite of a state change.
function Update-SessionPath {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '')]
    param()

    # winget installs land in the registry, not in this process. Without this,
    # the git and mise it just installed are invisible for the rest of the run.
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:PATH = "$machine;$user"
}

# --- Stage 0: get onto PowerShell 7 -----------------------------------------

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

    # Re-run the one-liner rather than this file: when invoked through
    # `irm | iex` there is no file on disk to hand to pwsh.
    $arguments = @('-NoProfile', '-Command', "irm $BootstrapUrl | iex")
    if ($WithWsl) {
        $arguments = @('-NoProfile', '-Command', "& ([scriptblock]::Create((irm $BootstrapUrl))) -WithWsl")
    }

    & pwsh @arguments
    return
}

# --- Stage 1: winget --------------------------------------------------------

if (-not (Test-Command 'winget')) {
    throw 'winget (App Installer) is missing. Install it from the Microsoft Store, then run this again.'
}

# --- Stage 2: desired state -------------------------------------------------

if (-not $SkipConfiguration) {
    Write-Stage 'Applying the winget configuration (applications and OS settings)'

    $localConfiguration = Join-Path $CheckoutPath 'dotfiles\windows\configuration.winget'
    $temporaryConfiguration = $null

    if (Test-Path -LiteralPath $localConfiguration) {
        $configuration = $localConfiguration
    }
    else {
        # First run: the repo is not cloned yet, and git is one of the things
        # this configuration installs. Fetch it on its own for this pass.
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

# --- Stage 3: the checkout --------------------------------------------------

Write-Stage "Checking out $RepoSlug to $CheckoutPath"

if (-not (Test-Command 'git')) {
    throw 'git is missing. Run without -SkipConfiguration so the configuration pass installs it.'
}

if (Test-Path -LiteralPath (Join-Path $CheckoutPath '.git')) {
    git -C $CheckoutPath pull --ff-only
}
else {
    New-Item -ItemType Directory -Path (Split-Path -Parent $CheckoutPath) -Force | Out-Null

    # Blobless and sparse: dotfiles/ is 624K, and nothing on this side of the
    # boundary needs the clusters, terraform or nix trees. autocrlf is forced
    # off here as well as pinned in .gitattributes -- the installer default is
    # true and it would rewrite the checkout.
    git clone --filter=blob:none --sparse -c core.autocrlf=false `
        "https://github.com/$RepoSlug.git" $CheckoutPath
    git -C $CheckoutPath sparse-checkout set dotfiles
}

# --- Stage 4: deploy --------------------------------------------------------

Write-Stage 'Running the dotfiles bootstrap'

if (-not (Test-Command 'mise')) {
    throw 'mise is missing. Run without -SkipConfiguration so the configuration pass installs it.'
}

$dotfiles = Join-Path $CheckoutPath 'dotfiles'
mise trust --yes (Join-Path $dotfiles 'mise.toml')
mise run --cd $dotfiles bootstrap

Write-Stage 'Installing the terminal font'
& (Join-Path $dotfiles 'windows\Install-NerdFont.ps1')

# Neither the winget catalogue nor the Store carries vibranceGUI, so it gets
# the same treatment as the font: pinned, hash-verified, per-user. -AutoStart
# is passed here rather than exposed as a flag -- a tray utility you install
# and do not launch is not a desired state anyone wants. Drop it from this line
# to keep the install without the login entry.
Write-Stage 'Installing vibranceGUI'
& (Join-Path $dotfiles 'windows\Install-VibranceGui.ps1') -AutoStart

# --- Stage 5: monitoring ----------------------------------------------------

# The only stage that installs machine-wide services, so the only one that
# needs elevation. It is asked for rather than assumed, and re-launched with a
# prompt rather than failing, because the rest of this bootstrap deliberately
# runs unelevated.
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

# --- Stage 6: WSL -----------------------------------------------------------

if ($WithWsl) {
    Write-Stage 'Installing WSL and handing off to the Linux bootstrap'
    & (Join-Path $dotfiles 'windows\Install-Wsl.ps1')
}

Write-Host ''
Write-Host 'Done. Open a new PowerShell 7 tab to pick up the profile.' -ForegroundColor Green
