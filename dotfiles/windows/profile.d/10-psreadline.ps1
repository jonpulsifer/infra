# The zsh-isms. Each block names the zsh plugin or setopt it replaces.

# zsh-autosuggestions. HistoryAndPlugin pulls in CompletionPredictor as well as
# history, which is the part that beats plain history search.
Set-PSReadLineOption -PredictionSource HistoryAndPlugin
Set-PSReadLineOption -PredictionViewStyle ListView
if (Get-Module -ListAvailable -Name CompletionPredictor) {
    Import-Module CompletionPredictor
}

Set-PSReadLineOption -EditMode Emacs
Set-PSReadLineOption -BellStyle None
Set-PSReadLineOption -HistorySearchCursorMovesToEnd
Set-PSReadLineOption -MaximumHistoryCount 10000

# setopt HIST_IGNORE_SPACE
Set-PSReadLineOption -AddToHistoryHandler {
    param([string] $line)
    return -not $line.StartsWith(' ')
}

# zsh-syntax-highlighting, carrying over the ZSH_HIGHLIGHT_STYLES palette from
# .config/zsh/.zshrc: commands white, strings and globs purple, options blue,
# paths underlined, anything unrecognised red.
Set-PSReadLineOption -Colors @{
    Command                = "$([char]27)[97;1m"
    Parameter              = "$([char]27)[38;5;33m"
    Operator               = "$([char]27)[0m"
    Variable               = "$([char]27)[38;5;209m"
    String                 = "$([char]27)[38;5;63m"
    Number                 = "$([char]27)[38;5;63m"
    Type                   = "$([char]27)[97m"
    Comment                = "$([char]27)[38;5;61m"
    Keyword                = "$([char]27)[38;5;209m"
    Error                  = "$([char]27)[38;5;9m"
    InlinePrediction       = "$([char]27)[38;5;240m"
    ListPrediction         = "$([char]27)[38;5;240m"
    ListPredictionSelected = "$([char]27)[48;5;238m"
}

# fzf-tab's menu behaviour. PSFzf's tab expansion layers on top in 30-fzf.ps1.
Set-PSReadLineKeyHandler -Key Tab -Function MenuComplete
Set-PSReadLineKeyHandler -Key Shift+Tab -Function TabCompletePrevious

# Up/Down search history by what is already typed. This is what the zshrc's
# `bindkey "${key[Up]}" fzf-history-widget` is actually reaching for most of
# the time; Ctrl-R still gets the full fzf picker.
Set-PSReadLineKeyHandler -Key UpArrow -Function HistorySearchBackward
Set-PSReadLineKeyHandler -Key DownArrow -Function HistorySearchForward

# Ctrl-Left / Ctrl-Right word motion, matching the zshrc's "^[[1;5C" bindings.
Set-PSReadLineKeyHandler -Key Ctrl+LeftArrow -Function BackwardWord
Set-PSReadLineKeyHandler -Key Ctrl+RightArrow -Function ForwardWord

Set-PSReadLineKeyHandler -Key Home -Function BeginningOfLine
Set-PSReadLineKeyHandler -Key End -Function EndOfLine
Set-PSReadLineKeyHandler -Key PageUp -Function BeginningOfHistory
Set-PSReadLineKeyHandler -Key PageDown -Function EndOfHistory

# Accept the inline suggestion a word at a time, the way zsh-autosuggestions
# does with a right arrow.
Set-PSReadLineKeyHandler -Key Ctrl+f -Function ForwardWord
