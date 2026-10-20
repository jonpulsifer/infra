@{
    # PSScriptAnalyzer's defaults assume you are writing modules for other
    # people to consume. These are a shell profile and a set of setup scripts,
    # so a handful of its rules are aimed at the wrong target. Each exclusion
    # below says why. Everything else -- including every Error-severity rule and
    # the genuinely useful warnings about unused and uninitialised variables --
    # stays on.
    ExcludeRules = @(
        # Setup scripts and the prompt function write to the terminal on
        # purpose. Write-Output would put the text in the pipeline, which for a
        # prompt means it ends up in the prompt string.
        'PSAvoidUsingWriteHost'

        # `wsl-here`, `towsl`, `boop`, `ll` are shell commands, not cmdlets.
        # Get-WslHere is not what anyone is going to type.
        'PSUseApprovedVerbs'
        'PSUseSingularNouns'

        # `mise activate pwsh | Invoke-Expression` and `zoxide init powershell |
        # Invoke-Expression` are the documented activation pattern for both
        # tools. The input is a local binary's own output, not user data.
        'PSAvoidUsingInvokeExpression'

        # The profile fragments contain U+276F and friends and carry no BOM.
        # PowerShell 7 reads .ps1 as UTF-8 by default; a BOM would only matter
        # for Windows PowerShell 5.1, which never loads these files.
        'PSUseBOMForUnicodeEncodedFile'
    )
}
