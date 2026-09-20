# fzf and zoxide. The FZF_* environment block is copied from
# .config/zsh/.zshrc unchanged -- environment variables port across shells with
# no translation, so the picker looks identical here.

$env:FZF_DEFAULT_OPTS = @(
    "--prompt='❯ ' --pointer='❯ ' --marker='❯ ' --layout=reverse"
    "--info=inline:'❮ ' --height=50% --margin=0,25,0,0"
    '--color=fg:-1,bg:-1,hl:#bd93f9'
    '--color=fg+:#f8f8f2,bg+:#282a36,hl+:#bd93f9'
    '--color=info:#ffb86c,prompt:#50fa7b,pointer:#ff79c6'
    '--color=marker:#ff79c6,spinner:#ffb86c,header:#6272a4'
) -join ' '

$env:FZF_CTRL_R_OPTS = '--layout=default --height=~40%'
# No `|| find .` fallback here: fd comes from mise, so if it is missing the
# right answer is to fix mise rather than to silently degrade.
$env:FZF_DEFAULT_COMMAND = 'fd --type f'
$env:FZF_CTRL_T_OPTS = "--preview 'bat --style=numbers --color=always --line-range=:200 {}' --bind 'ctrl-/:toggle-preview'"
$env:FZF_ALT_C_COMMAND = 'fd --type d --exclude .git'
$env:FZF_ALT_C_OPTS = "--preview 'eza --tree --level=2 --color=always {}' --bind 'ctrl-/:toggle-preview'"

if ((Get-Command fzf -ErrorAction SilentlyContinue) -and (Get-Module -ListAvailable -Name PSFzf)) {
    Import-Module PSFzf

    # fzf-tab. This rebinds Tab, taking it back from the MenuComplete binding in
    # 10-psreadline.ps1 -- deliberate, that binding is the fallback for when
    # PSFzf is not installed.
    Set-PsFzfOption -TabExpansion

    Set-PsFzfOption -PSReadlineChordProvider 'Ctrl+t'
    Set-PsFzfOption -PSReadlineChordReverseHistory 'Ctrl+r'
}

if (Get-Command zoxide -ErrorAction SilentlyContinue) {
    zoxide init powershell | Out-String | Invoke-Expression
}
