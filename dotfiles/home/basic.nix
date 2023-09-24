{ lib, pkgs, config, ... }:

let
  inherit (pkgs.stdenv) isDarwin;
  inherit (lib) mkDefault mkIf optionals;
  inherit (config.lib.file) mkOutOfStoreSymlink;

  username = "jawn";
  homeDirectory = (if isDarwin then "/Users/" else "/home/") + username;
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
    inherit username homeDirectory;

    file.".dotfiles".source =
      mkOutOfStoreSymlink "${homeDirectory}/src/github.com/jonpulsifer/dotfiles";

    sessionVariables = rec {
      # EDITOR = mkDefault "code --wait";
      # GIT_EDITOR = EDITOR;
      LANG = "en_US.UTF-8";
      LC_ALL = LANG;
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
    };
    stateVersion = "22.11";
  };

  home.packages = with pkgs;
    [
      shell-utils

      # things i use

      dig
      # gnumake
      jq
      mtr
      nano
      # neofetch
      # nmap
      # shellcheck
      tcpdump
      # unzip
      wget
      whois

      # hipster tools
      eza
      delta
      fd
      # hexyl
      httpie
      ripgrep
      sd
      # silver-searcher
      # tokei
      xsv
    ];

  programs.home-manager.enable = true;
  manual.manpages.enable = false;
  xdg.enable = true;

  programs.bat = {
    enable = true;
    config = { theme = "Dracula"; };
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
      default-preference-list =
        "SHA512 SHA384 SHA256 AES256 AES192 AES ZLIB BZIP2 ZIP Uncompressed";
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
