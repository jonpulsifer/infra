{
  lib,
  pkgs,
  config,
  ...
}:
let
  inherit (pkgs.stdenv) isDarwin;
in
{
  imports = [
    modules/git
    modules/nix
    modules/node_exporter
    modules/tmux
    modules/zsh
  ];

  home = {
    username = lib.mkDefault "jawn";
    homeDirectory = (if isDarwin then "/Users/" else "/home/") + config.home.username;
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
      l = ll;
      ll = ls + " -lg";
      la = ls + " -lag";
      ls = "${pkgs.eza}/bin/eza";
      tree = ls + " --tree";
      diff = "${pkgs.delta}/bin/delta";
      bruh = "${pkgs.fortune}/bin/fortune | ${pkgs.cowsay}/bin/cowsay -f moose | ${pkgs.lolcat}/bin/lolcat";
      paths = "echo \${PATH} | cut -f2 -d= | tr -s : \\\\n  | ${pkgs.lolcat}/bin/lolcat";
    };
    stateVersion = "24.05";
  };

  home.packages = with pkgs; [
    # daily driving apps
    shell-utils
    dig
    # gnumake
    jq
    mtr
    nano
    # neofetch
    # nmap
    # shellcheck
    tcpdump
    unzip
    wget
    whois

    # hipster tools
    eza
    delta
    fd
    httpie
    ripgrep
    sd
    xan
  ];

  programs.home-manager.enable = true;
  manual.manpages.enable = false;
  xdg.enable = true;

  programs.ghostty = {
    enable = false;
    enableZshIntegration = true;

    installBatSyntax = true;

    settings = {
      auto-update = "off";
      background-opacity = 0.8;
      confirm-close-surface = false;
      font-family = "FiraCode Nerd Font Mono";
      font-size = 12;
      theme = "Teerb";
    };
  };

  programs.bat = {
    enable = true;
    config = {
      theme = "Dracula";
    };
  };

  programs.btop = {
    enable = true;
    settings = {
      color_theme = "dracula";
      theme_background = false;
      update_ms = 250;
    };
  };

  programs.command-not-found.enable = true;

  programs.fzf = {
    enable = true;
    defaultCommand = "${pkgs.fd}/bin/fd --type f";
    defaultOptions = [
      "--reverse"
      "--info=inline"
      "--border"
      #"--height=50%"
      #"--margin=0,25,0,0"
      "--color=fg:-1,bg:-1,hl:#bd93f9"
      "--color=fg+:#f8f8f2,bg+:#282a36,hl+:#bd93f9"
      "--color=info:#ffb86c,prompt:#50fa7b,pointer:#ff79c6"
      "--color=marker:#ff79c6,spinner:#ffb86c,header:#6272a4"
      "--prompt='❯ '"
    ];
  };

  programs.gpg = {
    enable = false;
    settings = {
      personal-cipher-preferences = "AES256 AES192 AES";
      personal-digest-preferences = "SHA512 SHA384 SHA256";
      personal-compress-preferences = "ZLIB BZIP2 ZIP Uncompressed";
      default-preference-list = "SHA512 SHA384 SHA256 AES256 AES192 AES ZLIB BZIP2 ZIP Uncompressed";
      cert-digest-algo = "SHA512";
      s2k-digest-algo = "SHA512";
      s2k-cipher-algo = "AES256";
      charset = "utf-8";
      fixed-list-mode = true;
      no-comments = true;
      no-emit-version = true;
      keyid-format = "0xlong";
      list-options = "show-uid-validity";
      verify-options = "show-uid-validity";
      with-fingerprint = true;
      require-cross-certification = true;
      no-symkey-cache = true;
      use-agent = true;
      throw-keyids = true;
    };
  };
}
