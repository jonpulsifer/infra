@{
    # PowerShell Gallery modules the profile depends on, pinned. Bump by editing
    # the version here -- Install-Modules.ps1 installs exactly what is listed.
    #
    # PSReadLine is deliberately absent: the in-box copy that ships with
    # PowerShell 7 already supports ListView prediction and HistoryAndPlugin,
    # and shadowing an auto-loaded in-box module to gain nothing is a bad trade.

    # fzf integration: Ctrl-R history, Ctrl-T paths, Alt-C, tab expansion.
    PSFzf              = '2.7.9'

    # Feeds tab-completion results into PSReadLine's predictor, which is what
    # makes HistoryAndPlugin better than history alone.
    CompletionPredictor = '0.1.1'
}
