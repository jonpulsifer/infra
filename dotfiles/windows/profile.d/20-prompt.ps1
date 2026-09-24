# A two-line prompt in the style of pure. PowerShell has no RPROMPT, so the right-aligned
# segments go on a line written before the prompt string.
# DOTFILES_PROMPT_GIT=0 turns off the git segment.

$script:Esc = [char]27
$script:ColourPath = "$script:Esc[38;5;33;1m"
$script:ColourGit = "$script:Esc[38;5;242m"
$script:ColourTime = "$script:Esc[38;5;222m"
$script:ColourKube = "$script:Esc[38;5;141m"
$script:ColourOk = "$script:Esc[36m"
$script:ColourErr = "$script:Esc[31m"
$script:Reset = "$script:Esc[0m"

# Git dirs whose status took over DirtyBudgetMs. They skip the dirty check and show "branch?".
$script:SlowRepos = @{}
$script:DirtyBudgetMs = 150
$script:KubeCache = @{}

function script:Get-PromptPath {
    $path = $PWD.ProviderPath
    if ($path.StartsWith($HOME, [StringComparison]::OrdinalIgnoreCase)) {
        $path = '~' + $path.Substring($HOME.Length)
    }
    return $path.Replace('\', '/')
}

function script:Find-GitDir {
    $dir = $PWD.ProviderPath
    while ($dir) {
        $candidate = Join-Path $dir '.git'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { return $null }
        $dir = $parent
    }
    return $null
}

function script:Get-PromptGit {
    if ($env:DOTFILES_PROMPT_GIT -eq '0') { return $null }

    $gitDir = script:Find-GitDir
    if (-not $gitDir) { return $null }

    # A worktree's .git is a file pointing at the real gitdir.
    if (-not (Get-Item -LiteralPath $gitDir -Force).PSIsContainer) {
        $pointer = (Get-Content -LiteralPath $gitDir -Raw -ErrorAction SilentlyContinue)
        if ($pointer -match 'gitdir:\s*(.+)') { $gitDir = $Matches[1].Trim() }
    }

    $head = Join-Path $gitDir 'HEAD'
    if (-not (Test-Path -LiteralPath $head)) { return $null }

    $ref = (Get-Content -LiteralPath $head -Raw -ErrorAction SilentlyContinue)
    if (-not $ref) { return $null }
    $ref = $ref.Trim()

    if ($ref -match '^ref:\s*refs/heads/(.+)$') {
        $branch = $Matches[1]
    }
    else {
        $branch = $ref.Substring(0, [Math]::Min(7, $ref.Length))
    }

    if ($script:SlowRepos.ContainsKey($gitDir)) {
        return "$branch?"
    }

    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    # --no-optional-locks avoids the index lock a concurrent git may hold. Skipping
    # untracked files removes most of the cost.
    $changes = & git status --porcelain --untracked-files=no --no-optional-locks 2>$null
    $stopwatch.Stop()

    if ($stopwatch.ElapsedMilliseconds -gt $script:DirtyBudgetMs) {
        $script:SlowRepos[$gitDir] = $true
    }

    if ($changes) { return "$branch*" }
    return $branch
}

function script:Get-PromptKube {
    $config = if ($env:KUBECONFIG) { $env:KUBECONFIG } else { Join-Path $HOME '.kube/config' }
    if (-not (Test-Path -LiteralPath $config)) { return $null }

    # A kubectl call per prompt is too slow, so read the file and cache by mtime.
    $stamp = (Get-Item -LiteralPath $config).LastWriteTimeUtc.Ticks
    if ($script:KubeCache.ContainsKey($config) -and $script:KubeCache[$config].Stamp -eq $stamp) {
        return $script:KubeCache[$config].Context
    }

    $context = $null
    foreach ($line in Get-Content -LiteralPath $config -ErrorAction SilentlyContinue) {
        if ($line -match '^current-context:\s*(\S+)') {
            $context = $Matches[1].Trim('"', "'")
            break
        }
    }

    $script:KubeCache[$config] = @{ Stamp = $stamp; Context = $context }
    return $context
}

function script:Get-PromptDuration {
    $last = Get-History -Count 1 -ErrorAction SilentlyContinue
    if (-not $last) { return $null }

    $seconds = $last.Duration.TotalSeconds
    # pure's PURE_CMD_MAX_EXEC_TIME default.
    if ($seconds -lt 5) { return $null }

    if ($seconds -lt 60) { return ('{0:0.0}s' -f $seconds) }
    return ('{0:0}m{1:00}s' -f [Math]::Floor($seconds / 60), ($seconds % 60))
}

function script:Measure-VisibleLength {
    param([string] $Text)
    return ($Text -replace "$script:Esc\[[0-9;]*m", '').Length
}

function prompt {
    $succeeded = $?
    $exitCode = $LASTEXITCODE

    $left = "$script:ColourPath$(script:Get-PromptPath)$script:Reset"

    $branch = script:Get-PromptGit
    if ($branch) { $left += " $script:ColourGit$branch$script:Reset" }

    $right = ''
    $duration = script:Get-PromptDuration
    if ($duration) { $right += "$script:ColourTime$duration$script:Reset" }

    $context = script:Get-PromptKube
    if ($context) {
        if ($right) { $right += '  ' }
        $right += "$script:ColourKube⎈ $context$script:Reset"
    }

    # WindowSize throws in a redirected or non-console host.
    $width = 0
    try { $width = $Host.UI.RawUI.WindowSize.Width } catch { $width = 0 }

    if ($right) {
        $gap = $width - (script:Measure-VisibleLength $left) - (script:Measure-VisibleLength $right) - 1
        if ($width -le 0 -or $gap -lt 2) { $gap = 2 }
        Write-Host ($left + (' ' * $gap) + $right)
    }
    else {
        Write-Host $left
    }

    $failed = (-not $succeeded) -or ($null -ne $exitCode -and $exitCode -ne 0)
    $colour = if ($failed) { $script:ColourErr } else { $script:ColourOk }

    # The git call in Get-PromptGit overwrites $LASTEXITCODE.
    $global:LASTEXITCODE = $exitCode

    return "$colour❯$script:Reset "
}
