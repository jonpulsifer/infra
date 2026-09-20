# mise owns every CLI tool on this box, the same way it does on macOS and
# NixOS. Nothing here should duplicate what mise-global-config.toml declares.

$env:PATH = "$HOME\.local\bin;$env:PATH"

if (Get-Command mise -ErrorAction SilentlyContinue) {
    mise activate pwsh | Out-String | Invoke-Expression
}
