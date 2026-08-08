{
  config,
  pkgs,
  lib,
  ...
}:
let
  kube-ps1 = pkgs.fetchFromGitHub {
    owner = "jonmosco";
    repo = "kube-ps1";
    rev = "v0.9.0";
    hash = "sha256-r8rrEfHklpPw4IvVTVqy8BmPoLv0cw9Zg8JjPh5rrm8=";
  };
in
{
  home.stateVersion = "26.05";

  programs.bat.enable = true;
  programs.bat.config = {
    style = "plain";
    color = "always";
    paging = "auto";
  };

  programs.btop.enable = true;

  programs.eza.enable = true;
  programs.eza.icons = true;
  programs.eza.git = true;

  programs.fzf = {
    enable = true;
    enableZshIntegration = true;
    defaultCommand = "fd --type f 2>/dev/null || find .";
    defaultOptions = [
      "--prompt='❯ '"
      "--pointer='❯ '"
      "--marker='❯ '"
      "--layout=reverse"
      "--info=inline:'❮ '"
      "--height=50%"
      "--margin=0,25,0,0"
      "--color=fg:-1,bg:-1,hl:#bd93f9"
      "--color=fg+:#f8f8f2,bg+:#282a36,hl+:#bd93f9"
      "--color=info:#ffb86c,prompt:#50fa7b,pointer:#ff79c6"
      "--color=marker:#ff79c6,spinner:#ffb86c,header:#6272a4"
    ];
    fileWidgetCommand = "fd --type f 2>/dev/null || find .";
    fileWidgetOptions = [
      "--preview"
      "bat --style=numbers --color=always --line-range=:200 {} 2>/dev/null"
      "--bind"
      "ctrl-/:toggle-preview"
    ];
    changeDirWidgetCommand = "fd --type d --exclude .git 2>/dev/null || find . -type d";
    changeDirWidgetOptions = [
      "--preview"
      "eza --tree --level=2 --color=always {} 2>/dev/null"
      "--bind"
      "ctrl-/:toggle-preview"
    ];
    colors = {
      "fg" = "-1";
      "bg" = "-1";
      "hl" = "#bd93f9";
      "fg+" = "#f8f8f2";
      "bg+" = "#282a36";
      "hl+" = "#bd93f9";
      "info" = "#ffb86c";
      "prompt" = "#50fa7b";
      "pointer" = "#ff79c6";
      "marker" = "#ff79c6";
      "spinner" = "#ffb86c";
      "header" = "#6272a4";
    };
  };

  programs.gh = {
    enable = true;
    settings.gitProtocol = "ssh";
  };

  # git-delta has no home-manager programs.<x> module in release-26.05; ship
  # the binary here. The mise-deployed ~/.config/git/config template wires it
  # as the pager.
  programs.neovim = {
    enable = true;
    vimAlias = true;
    defaultEditor = true;
  };

  programs.zsh = {
    enable = true;
    dotDir = ".config/zsh";
    enableCompletion = true;
    autosuggestion.enable = true;
    syntaxHighlighting.enable = true;

    shellAliases = {
      ls = "eza";
      ll = "eza -l";
      la = "eza -la";
      tree = "eza --tree";
      diff = "delta";
      htop = "btop; echo 'stop using [h]top, prefer btop'";
    };

    history = {
      share = true;
      ignoreDups = true;
      ignoreSpace = true;
    };

    plugins = [
      {
        name = "fzf-tab";
        src = pkgs.zsh-fzf-tab;
        file = "share/fzf-tab/fzf-tab.plugin.zsh";
      }
    ];

    initContent = ''
      # Path: user scripts first, then mise shims, then bun. Shims rather than
      # `mise activate`: nix installs the mise binary and stops there, so the
      # shell carries no nix-generated hook and mise resolves tool versions
      # itself, per invocation, out of ~/.local/share/mise. Safe here because
      # no mise config in this repo declares an [env] block -- exporting one
      # back into the shell is the only thing a shim cannot do.
      export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$HOME/.bun/bin:$PATH"
      export MISE_NODE_COMPILE=false

      # Profile detection
      if [[ "''${MISE_ENV:-personal}" == "work" ]]; then
        export WORK_ENV=1
      fi

      # Early zstyles (before prompt/plugins)
      setopt TRANSIENT_RPROMPT
      zstyle ':autocomplete:tab:*' fzf-completion
      zstyle ':prompt:pure:prompt:success' color cyan

      # pure-prompt: prompt function lives in fpath, not a plugin file
      fpath+=( "${pkgs.pure-prompt}/share/zsh/site-functions" )
      autoload -Uz promptinit && promptinit
      prompt pure

      # kube-ps1 (vendored from jonmosco/kube-ps1 @ v0.9.0)
      if [[ -r "${kube-ps1}/kube-ps1.sh" ]]; then
        source "${kube-ps1}/kube-ps1.sh"
        if command -v kubectl >/dev/null 2>&1; then
          source <(kubectl completion zsh)
          alias kubectl="kubecolor"
          compdef kubecolor=kubectl
          compdef k=kubectl
          compdef kube=kubectl
          export KUBE_PS1_PREFIX="" KUBE_PS1_SUFFIX="" KUBE_PS1_SEPARATOR="" KUBE_PS1_SYMBOL_PADDING="true"
          export RPS1='$(kube_ps1)'
        fi
      fi
      export KUBECONFIG="''${KUBECONFIG:-$HOME/.kube/config}"

      # Syntax highlighting colors (zsh-syntax-highlighting)
      typeset -g -A ZSH_HIGHLIGHT_STYLES
      ZSH_HIGHLIGHT_STYLES[default]=none
      ZSH_HIGHLIGHT_STYLES[unknown-token]=fg=009
      ZSH_HIGHLIGHT_STYLES[reserved-word]=fg=009,standout
      ZSH_HIGHLIGHT_STYLES[alias]=fg=white,bold
      ZSH_HIGHLIGHT_STYLES[builtin]=fg=white,bold
      ZSH_HIGHLIGHT_STYLES[function]=fg=white,bold
      ZSH_HIGHLIGHT_STYLES[command]=fg=white,bold
      ZSH_HIGHLIGHT_STYLES[precommand]=fg=white,underline
      ZSH_HIGHLIGHT_STYLES[commandseparator]=none
      ZSH_HIGHLIGHT_STYLES[hashed-command]=fg=009
      ZSH_HIGHLIGHT_STYLES[path]=fg=004,underline
      ZSH_HIGHLIGHT_STYLES[globbing]=fg=063
      ZSH_HIGHLIGHT_STYLES[history-expansion]=fg=white,underline
      ZSH_HIGHLIGHT_STYLES[single-hyphen-option]=fg=033
      ZSH_HIGHLIGHT_STYLES[double-hyphen-option]=fg=039
      ZSH_HIGHLIGHT_STYLES[back-quoted-argument]=none
      ZSH_HIGHLIGHT_STYLES[single-quoted-argument]=fg=063
      ZSH_HIGHLIGHT_STYLES[double-quoted-argument]=fg=063
      ZSH_HIGHLIGHT_STYLES[dollar-double-quoted-argument]=fg=009
      ZSH_HIGHLIGHT_STYLES[back-double-quoted-argument]=fg=009
      ZSH_HIGHLIGHT_STYLES[assign]=none

      # Keybindings (vim/emacs hybrid)
      typeset -g -A key
      key[Home]="''${terminfo[khome]}"
      key[End]="''${terminfo[kend]}"
      key[Insert]="''${terminfo[kich1]}"
      key[Backspace]="''${terminfo[kbs]}"
      key[Delete]="''${terminfo[kdch1]}"
      key[Up]="''${terminfo[kcuu1]}"
      key[Down]="''${terminfo[kcud1]}"
      key[Left]="''${terminfo[kcub1]}"
      key[Right]="''${terminfo[kcuf1]}"
      key[PageUp]="''${terminfo[kpp]}"
      key[PageDown]="''${terminfo[knp]}"
      key[Shift-Tab]="''${terminfo[kcbt]}"

      bindkey "^[[1;5C" forward-word
      bindkey "^[[1;5D" backward-word
      [[ -n "''${key[Home]}"      ]] && bindkey -- "''${key[Home]}"       beginning-of-line
      [[ -n "''${key[End]}"       ]] && bindkey -- "''${key[End]}"        end-of-line
      [[ -n "''${key[Insert]}"    ]] && bindkey -- "''${key[Insert]}"     overwrite-mode
      [[ -n "''${key[Backspace]}" ]] && bindkey -- "''${key[Backspace]}"  backward-delete-char
      [[ -n "''${key[Delete]}"    ]] && bindkey -- "''${key[Delete]}"     delete-char
      [[ -n "''${key[Up]}"        ]] && bindkey -- "''${key[Up]}"         fzf-history-widget
      [[ -n "''${key[Down]}"      ]] && bindkey -- "''${key[Down]}"       down-line-or-history
      [[ -n "''${key[Left]}"      ]] && bindkey -- "''${key[Left]}"       backward-char
      [[ -n "''${key[Right]}"     ]] && bindkey -- "''${key[Right]}"      forward-char
      [[ -n "''${key[PageUp]}"    ]] && bindkey -- "''${key[PageUp]}"     beginning-of-buffer-or-history
      [[ -n "''${key[PageDown]}"  ]] && bindkey -- "''${key[PageDown]}"   end-of-buffer-or-history
      [[ -n "''${key[Shift-Tab]}" ]] && bindkey -- "''${key[Shift-Tab]}"  reverse-menu-complete

      # kubectl logs fzf helper
      logs() {
        FZF_DEFAULT_COMMAND="kubectl get pods --all-namespaces" \
          fzf --info=inline --layout=reverse --header-lines=1 \
            --prompt "$(kubectl config current-context | sed 's/-context$//')> " \
            --header $'╱ Enter (kubectl exec) ╱ CTRL-O (open log in editor) ╱ CTRL-R (reload) ╱\n\n' \
            --bind 'ctrl-/:change-preview-window(80%,border-bottom|hidden|)' \
            --bind 'enter:execute:kubectl exec -it --namespace {1} {2} -- /bin/sh > /dev/tty' \
            --bind 'ctrl-o:execute:''${EDITOR:-vim} <(kubectl logs --all-containers --namespace {1} {2}) > /dev/tty' \
            --bind 'ctrl-r:reload:kubectl get pods --all-namespaces' \
            --preview-window up:follow \
            --preview 'kubectl logs --follow --all-containers --tail=10000 --namespace {1} {2}' "$@"
      }

      # Merge another GitHub repo into the current monorepo as a subdirectory,
      # preserving full history via git-filter-repo. Run from the monorepo root.
      # Usage: monorepo-merge <repo-name>   e.g. monorepo-merge containers
      monorepo-merge() {
        local repo="$1" top branch
        [[ -n "$repo" ]] || { echo "usage: monorepo-merge <repo-name>" >&2; return 2; }
        top="$(pwd)"
        gh repo clone "jonpulsifer/''${repo}" "/tmp/''${repo}" || return 1
        branch="$(git -C "/tmp/''${repo}" branch --show-current)"
        ( cd "/tmp/''${repo}" && git filter-repo --to-subdirectory-filter "''${repo}" ) || return 1
        git -C "''${top}" remote add "temp-''${repo}" "/tmp/''${repo}"
        git -C "''${top}" fetch "temp-''${repo}"
        git -C "''${top}" merge "temp-''${repo}/''${branch}" --allow-unrelated-histories -m "Merge ''${repo}"
        git -C "''${top}" remote remove "temp-''${repo}"
        rm -rf "/tmp/''${repo}"
      }
    '';
  };

  # Tools with no home-manager programs.<x> module ship as plain packages.
  home.packages = with pkgs; [
    fd
    ripgrep
    jq
    sd
    delta
    _1password-cli
  ];
}