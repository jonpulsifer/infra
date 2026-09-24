# Aliases from .config/zsh/.zshrc. PowerShell resolves aliases before functions, so
# a function that shadows a built-in alias removes the alias first.
# rm, cat, cp and mv keep their PowerShell meanings.

function script:Remove-BuiltinAlias {
    param([string] $Name)
    if (Test-Path -LiteralPath "Alias:$Name") {
        Remove-Alias -Name $Name -Force -ErrorAction SilentlyContinue
    }
}

if (Get-Command eza -ErrorAction SilentlyContinue) {
    script:Remove-BuiltinAlias 'ls'
    function ls { eza @args }
    function ll { eza -l @args }
    function la { eza -la @args }
    function tree { eza --tree @args }
}

if (Get-Command delta -ErrorAction SilentlyContinue) {
    script:Remove-BuiltinAlias 'diff'
    function diff { delta @args }
}

if (Get-Command kubectl -ErrorAction SilentlyContinue) {
    if (Get-Command kubecolor -ErrorAction SilentlyContinue) {
        function kubectl { kubecolor @args }
    }
    function kube { kubectl @args }
    function k { kubectl @args }

    # Generating completion is the slowest step in the profile, so the output is
    # cached until the kubectl binary changes.
    $cacheDir = Join-Path $HOME '.cache/powershell'
    $completion = Join-Path $cacheDir 'kubectl-completion.ps1'
    $binary = (Get-Command kubectl).Source

    $stale = -not (Test-Path -LiteralPath $completion) -or
        (Get-Item -LiteralPath $completion).LastWriteTimeUtc -lt (Get-Item -LiteralPath $binary).LastWriteTimeUtc

    if ($stale) {
        New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
        kubectl completion powershell | Set-Content -LiteralPath $completion -Encoding utf8
    }
    . $completion
}

if (Get-Command kubectx -ErrorAction SilentlyContinue) {
    function chctx { kubectx @args }
}
if (Get-Command kubens -ErrorAction SilentlyContinue) {
    function chns { kubens @args }
}

function boop { git commit --allow-empty -m '🫵 boop' @args }

if (-not $env:KUBECONFIG) {
    $env:KUBECONFIG = Join-Path $HOME '.kube/config'
}
