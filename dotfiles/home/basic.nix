{
  lib,
  pkgs,
  config,
  ...
}:
{
  imports = [
    modules/git.nix
    modules/nix
    modules/tmux
    modules/zsh.nix
    modules/vim
  ];

  home = {
    username = lib.mkDefault "jawn";
    homeDirectory = lib.mkDefault "/home/${config.home.username}";
    sessionVariables = rec {
      # GIT_EDITOR = EDITOR;
      LANG = "en_US.UTF-8";
      LC_ALL = LANG;
      MANROFFOPT = "-c";
      MANPAGER = "sh -c 'col -bx | ${pkgs.bat}/bin/bat -l man -p'";
      # VISUAL = EDITOR;
    };

    shellAliases = rec {
      htop = "${pkgs.btop}/bin/btop; echo 'stop using [h]top, prefer btop'";
      tree = "${pkgs.eza}/bin/eza --tree";
      diff = "${pkgs.delta}/bin/delta";
      bruh = "${pkgs.fortune}/bin/fortune | ${pkgs.cowsay}/bin/cowsay -f moose | ${pkgs.dotacat}/bin/dotacat";
      paths = "echo \${PATH} | cut -f2 -d= | tr -s : \\\\n  | ${pkgs.dotacat}/bin/dotacat";
    };

    file.".dotfiles" = {
      source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/src/github.com/jonpulsifer/dotfiles";
      enable = true;
    };

    stateVersion = "25.11";
  };

  # Stable packages - core system tools that rarely change
  home.packages = with pkgs; [
    # Basic system utilities - stable and rarely changing
    dig
    mtr
    nano
    tcpdump
    unzip
    wget
    whois
    shell-utils
    httpie
    jq
    fd
    sd
    xan
  ];

  programs.home-manager.enable = true;
  manual.manpages.enable = false;
  xdg.enable = true;

  programs.nano.enable = true;
  programs.delta = {
    enable = true;
    enableGitIntegration = true;
    options = {
      navigate = true;
      side-by-side = true;
    };
  };
  programs.eza.enable = true;
  programs.ripgrep.enable = true;

  programs.bat = {
    enable = true;
    config = {
      theme = "1337";
    };
  };

  programs.btop = {
    enable = true;
    settings = {
      color_theme = "tokyo-night";
      theme_background = false;
      update_ms = 250;
    };
  };

  programs.command-not-found.enable = true;

  programs.fzf = {
    enable = true;
    defaultCommand = "${pkgs.fd}/bin/fd --type f";
    defaultOptions = [
      "--prompt='❯ '"
      "--pointer='❯ '"
      "--marker='❯ '"
      "--layout=reverse"
      "--info=inline:'❮ '"
      # "--border"
      # "--height=50%"
      # "--margin=0,25,0,0"
      "--color=fg:-1,bg:-1,hl:#bd93f9"
      "--color=fg+:#f8f8f2,bg+:#282a36,hl+:#bd93f9"
      "--color=info:#ffb86c,prompt:#50fa7b,pointer:#ff79c6"
      "--color=marker:#ff79c6,spinner:#ffb86c,header:#6272a4"

    ];
    historyWidgetOptions = [
      # "--reverse"
      #"--layout=default"
    ];
  };
}
