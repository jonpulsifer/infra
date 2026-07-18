{ config, pkgs, ... }:
let
  mkRunner =
    {
      repo,
      enable ? true,
      name ? "metal",
      replace ? true,
      extraPackages ? [ ],
    }:
    if enable then
      {
        inherit enable name replace;
        url = "https://github.com/jonpulsifer/${repo}";
        tokenFile = "/var/secrets/github-token-${repo}";
        extraLabels = [
          name
          config.networking.hostName
          "metal"
        ];
        extraPackages =
          with pkgs;
          [
            nodejs_22
            unzip
          ]
          ++ extraPackages;
      }
    else
      null;
in
{
  services.github-runners = {
    infra = mkRunner {
      repo = "infra";
      extraPackages = [ pkgs.cachix ];
    };
  };
  nix.settings.trusted-users = [
    "github-runner-infra"
  ];
}
