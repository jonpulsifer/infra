{ pkgs, ... }: {
  services.github-runners = {
    infra = {
      enable = true;
      url = "https://github.com/jonpulsifer/infra";
      tokenFile = "/var/secrets/github-token-infra";
      extraPackages = with pkgs; [ cachix ];
    };
    ts = {
      enable = true;
      url = "https://github.com/jonpulsifer/ts";
      tokenFile = "/var/secrets/github-token-ts";
      extraPackages = with pkgs; [ cachix ];
    };
  };
  nix.settings.trusted-users = [ "github-runner-800g3-1" "github-runner-oldschool" ];
}
