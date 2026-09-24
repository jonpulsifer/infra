#Requires -Version 7.0
# $PROFILE.CurrentUserAllHosts. Loads profile.d in filename order, so 00-mise puts
# tools on PATH first. The path is fixed because $PSScriptRoot is the symlink's directory.

$fragmentDir = Join-Path $HOME '.config/powershell/profile.d'
if (Test-Path -LiteralPath $fragmentDir) {
    foreach ($fragment in Get-ChildItem -LiteralPath $fragmentDir -Filter '*.ps1' | Sort-Object Name) {
        . $fragment.FullName
    }
}
