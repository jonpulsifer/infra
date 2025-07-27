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
    # modules/node_exporter
    modules/tmux
    modules/zsh
    modules/vim
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
      bruh = "${pkgs.fortune}/bin/fortune | ${pkgs.cowsay}/bin/cowsay -f moose | ${pkgs.dotacat}/bin/dotacat";
      paths = "echo \${PATH} | cut -f2 -d= | tr -s : \\\\n  | ${pkgs.dotacat}/bin/dotacat";
    };

    file.".dotfiles" = {
      source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/src/github.com/jonpulsifer/dotfiles";
      enable = true;
    };

    stateVersion = "25.05";
  };

  # Stable packages - core system tools that rarely change
  home.packages = with pkgs; [
    # Basic system utilities - stable
    dig
    httpie
    jq
    mtr
    nano
    tcpdump
    unzip
    wget
    whois
    shell-utils
  ] ++ (with pkgs.unstable; [
    # Development tools - from unstable for latest features
    eza
    delta
    fd
    ripgrep
    sd
    xan
  ]);

  programs.home-manager.enable = true;
  manual.manpages.enable = false;
  xdg.enable = true;

  programs.ghostty = {
    enable = true;
    enableZshIntegration = true;
    installBatSyntax = lib.mkIf (config.programs.ghostty.package != null) true;
    settings = {
      background-blur = true;
      background-opacity = 0.9;
      bold-is-bright = true;
      font-family = "CaskaydiaCove Nerd Font";
      font-size = 12;
      font-thicken = false;
      theme = "Argonaut";
    };
  };

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
    defaultCommand = "${pkgs.unstable.fd}/bin/fd --type f";
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
