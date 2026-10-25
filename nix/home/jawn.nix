{ pkgs, ... }:
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
  programs.eza.icons = "auto";
  programs.eza.git = true;

  programs.fzf = {
    enable = true;
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

  # Plain vim reads the dotfiles' ~/.vimrc; home-manager's programs.vim would write its own.
  home.sessionVariables.EDITOR = "vim";

  # The dotfiles' .zshrc runs on every host and finds its plugins here, because mise installs
  # nothing on NixOS hosts.
  xdg.dataFile = {
    "zsh/plugins/pure".source = "${pkgs.pure-prompt}/share/zsh/site-functions";
    "zsh/plugins/autosuggestions".source =
      "${pkgs.zsh-autosuggestions}/share/zsh/plugins/zsh-autosuggestions";
    "zsh/plugins/syntax-highlighting".source =
      "${pkgs.zsh-syntax-highlighting}/share/zsh-syntax-highlighting";
    "zsh/plugins/fzf-tab".source = "${pkgs.zsh-fzf-tab}/share/fzf-tab";
    "zsh/plugins/kube-ps1".source = kube-ps1;
  };

  home.packages = with pkgs; [
    fd
    ripgrep
    jq
    sd
    delta
    _1password-cli
    vim
  ];
}
