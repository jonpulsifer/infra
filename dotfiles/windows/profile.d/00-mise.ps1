$env:PATH = "$HOME\.local\bin;$env:PATH"

if (Get-Command mise -ErrorAction SilentlyContinue) {
    mise activate pwsh | Out-String | Invoke-Expression
}
