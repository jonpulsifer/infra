{ config, pkgs, ... }:
let
  mkRunner = { repo, enable ? true, name ? "metal", replace ? true, extraPackages ? [ ] }:
    if enable then {
      inherit enable name replace;
      url = "https://github.com/jonpulsifer/${repo}";
      user = config.users.users.github-runner.name;
      tokenFile = "/var/secrets/github-token-${repo}";
      extraLabels = [ name config.networking.hostName "metal" ];
      extraPackages = with pkgs; [ docker nodejs-18_x unzip ] ++ extraPackages;
    } else null;
in
{
  users.groups.github-runner = { };
  users.users.github-runner = {
    isSystemUser = true;
    shell = pkgs.bash;
    group = config.users.groups.github-runner.name;
    extraGroups = [ "wheel" "docker" ];
  };

  services.github-runners = {
    dotfiles = mkRunner { repo = "dotfiles"; extraPackages = [ pkgs.cachix ]; };
    infra = mkRunner { repo = "infra"; extraPackages = [ pkgs.cachix ]; };
    ts = mkRunner { repo = "ts"; };
  };
  nix.settings.trusted-users = [ "github-runner-infra" "github-runner-dotfiles" ];
}
