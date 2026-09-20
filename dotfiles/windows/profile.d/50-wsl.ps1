# Driving WSL from PowerShell. These replace the tmux- and ssh-shaped helpers in
# .local/bin that do not cross the boundary -- on this box the shell's main job
# is getting into the distro and back out again.
#
# Set DOTFILES_WSL_DISTRO to target something other than the default distro.

function script:Get-WslArgs {
    if ($env:DOTFILES_WSL_DISTRO) { return @('-d', $env:DOTFILES_WSL_DISTRO) }
    return @()
}

# Drop into the distro at the Windows directory you are standing in. `wsl --cd`
# takes a Windows path and translates it, so no wslpath dance is needed.
function wsl-here {
    wsl.exe @(script:Get-WslArgs) --cd "$($PWD.ProviderPath)" @args
}

# Run one command in the distro without leaving PowerShell.
function wsl-run {
    wsl.exe @(script:Get-WslArgs) --cd "$($PWD.ProviderPath)" -- @args
}

function wsl-list { wsl.exe -l -v }

# --shutdown stops every distro and the VM, not just one. That is the point --
# it is the fix for a wedged mount or a stuck vmmem -- but it is worth knowing
# before running it with something open elsewhere.
function wsl-restart {
    Write-Host 'Shutting down all WSL distros...'
    wsl.exe --shutdown
    Write-Host 'Starting the default distro...'
    wsl.exe @(script:Get-WslArgs) -- true
    wsl.exe -l -v
}

# The distro's address on the NAT network. Under mirrored networking this
# returns the host's addresses instead, which is correct but less interesting.
function wsl-ip {
    wsl.exe @(script:Get-WslArgs) -- hostname -I
}

# Path translation both ways.
function towsl {
    param([Parameter(ValueFromPipeline)] [string] $Path = $PWD.ProviderPath)
    process { wsl.exe @(script:Get-WslArgs) -- wslpath -a "$Path" }
}

function towin {
    param([Parameter(Mandatory, ValueFromPipeline)] [string] $Path)
    process { wsl.exe @(script:Get-WslArgs) -- wslpath -w "$Path" }
}

# Open a path inside the distro in Explorer.
function wsl-explore {
    param([string] $Path = '.')
    wsl.exe @(script:Get-WslArgs) --cd "$($PWD.ProviderPath)" -- explorer.exe "$Path"
}
