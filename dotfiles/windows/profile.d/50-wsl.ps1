# WSL helpers. DOTFILES_WSL_DISTRO picks a distro other than the default.

function script:Get-WslArgs {
    if ($env:DOTFILES_WSL_DISTRO) { return @('-d', $env:DOTFILES_WSL_DISTRO) }
    return @()
}

# wsl --cd translates a Windows path itself.
function wsl-here {
    wsl.exe @(script:Get-WslArgs) --cd "$($PWD.ProviderPath)" @args
}

function wsl-run {
    wsl.exe @(script:Get-WslArgs) --cd "$($PWD.ProviderPath)" -- @args
}

function wsl-list { wsl.exe -l -v }

# --shutdown stops every distro and the VM.
function wsl-restart {
    Write-Host 'Shutting down all WSL distros...'
    wsl.exe --shutdown
    Write-Host 'Starting the default distro...'
    wsl.exe @(script:Get-WslArgs) -- true
    wsl.exe -l -v
}

# Under mirrored networking this returns the host's addresses.
function wsl-ip {
    wsl.exe @(script:Get-WslArgs) -- hostname -I
}

function towsl {
    param([Parameter(ValueFromPipeline)] [string] $Path = $PWD.ProviderPath)
    process { wsl.exe @(script:Get-WslArgs) -- wslpath -a "$Path" }
}

function towin {
    param([Parameter(Mandatory, ValueFromPipeline)] [string] $Path)
    process { wsl.exe @(script:Get-WslArgs) -- wslpath -w "$Path" }
}

function wsl-explore {
    param([string] $Path = '.')
    wsl.exe @(script:Get-WslArgs) --cd "$($PWD.ProviderPath)" -- explorer.exe "$Path"
}
