{
  config,
  lib,
  pkgs,
  name,
  inputs,
  ...
}:
let
  sshKeys = lib.splitString "\n" (builtins.readFile inputs.wannabekeys);
in
{
  imports = [
    # ../nix/modules/github-runner.nix
    ../nix/modules/yarr.nix
    ../nix/modules/k8s
  ];

  networking.hostName = name;
  # networking.wireless = {
  #   enable = true;
  #   networks = {
  #     Goggly = {
  #       pskRaw = "c1e6a7dd93cd062b1b0e1f394b54f5a80ce63de04e9d9478f87312f8099df864";
  #     };
  #     # Goggly2 = {
  #     #   pskRaw = "fd6e6e6bbb22865a53302494040e6e3799a2f097a8321152e264c568bc16b3d5";
  #     # };
  #   };
  # };

  services.k8s = {
    enable = true;
    network = "offsite";
  };

  services.tailscale = {
    extraUpFlags = [ "--advertise-routes=192.168.2.0/24" ];
    useRoutingFeatures = "both";
  };

  systemd.services.tailscale-transport-layer-offloads = {
    # https://tailscale.com/kb/1320/performance-best-practices#ethtool-configuration.
    description = "Linux optimizations for subnet routers and exit nodes";
    after = [ "network.target" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${pkgs.ethtool}/sbin/ethtool -K eno1 rx-udp-gro-forwarding on rx-gro-list off";
    };
    wantedBy = [ "default.target" ];
  };

  services.ddnsd.enable = true;
  virtualisation.docker.enable = true;

  users.users.quiker = {
    uid = 1338;
    isNormalUser = true;
    extraGroups = [
      "wheel"
      "tty"
    ]
    ++ lib.optionals (config.virtualisation.docker.enable) [ "docker" ];
    openssh.authorizedKeys.keys = sshKeys;
    shell = pkgs.zsh;
  };

  home-manager.users.quiker = {
    home.sessionVariables = rec {
      LANG = "en_US.UTF-8";
      LC_ALL = LANG;
      MANROFFOPT = "-c";
      MANPAGER = "sh -c 'col -bx | ${pkgs.bat}/bin/bat -l man -p'";
    };
    home.shellAliases = rec {
      bruh = "${pkgs.fortune}/bin/fortune | ${pkgs.cowsay}/bin/cowsay -f moose | ${pkgs.lolcat}/bin/lolcat";
      paths = "echo \${PATH} | cut -f2 -d= | tr -s : \\\\n  | ${pkgs.lolcat}/bin/lolcat";
      htop = "${pkgs.btop}/bin/btop; echo 'stop using [h]top, prefer btop'";
      l = ll;
      ll = ls + " -lg";
      la = ls + " -lag";
      ls = "${pkgs.eza}/bin/eza";
      tree = ls + " --tree";
      diff = "${pkgs.delta}/bin/delta";
    };
    xdg.enable = true;

    home.packages = with pkgs; [
      dig
      jq
      mtr
      nano
      tcpdump
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

    programs.bat.enable = true;
    programs.btop.enable = true;
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
    programs.zsh = {
      enable = true;
      enableCompletion = true;
      autosuggestion.enable = true;
      syntaxHighlighting.enable = true;
    };
    home.stateVersion = "24.05";
  };
}
