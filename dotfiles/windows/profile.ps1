#Requires -Version 7.0
# $PROFILE.CurrentUserAllHosts. Everything real lives in the fragments, which
# deploy-dotfiles.ps1 symlinks to ~/.config/powershell/profile.d. The path is
# fixed rather than derived from $PSScriptRoot because $PSScriptRoot resolves to
# the symlink's directory, not the repo.
#
# Fragments load in filename order; the numeric prefixes are the load order and
# they matter -- mise has to be on PATH before anything looks for a tool.

$fragmentDir = Join-Path $HOME '.config/powershell/profile.d'
if (Test-Path -LiteralPath $fragmentDir) {
    foreach ($fragment in Get-ChildItem -LiteralPath $fragmentDir -Filter '*.ps1' | Sort-Object Name) {
        . $fragment.FullName
    }
}
