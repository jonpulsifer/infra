{ pkgs, ... }: {
  services.github-runners = {
    infra = {
      enable = true;
      url = "https://github.com/jonpulsifer/infra";
      tokenFile = "/var/secrets/github-token-infra";
      extraPackages = with pkgs; [ cachix ];
    };
    dotfiles = {
      enable = true;
      url = "https://github.com/jonpulsifer/dotfiles";
      tokenFile = "/var/secrets/github-token-dotfiles";
      extraPackages = with pkgs; [ cachix ];
    };
    ts = {
      enable = true;
      url = "https://github.com/jonpulsifer/ts";
      tokenFile = "/var/secrets/github-token-ts";
      extraPackages = with pkgs; [ ];
    };
  };
  nix.settings.trusted-users = [ "github-runner-infra" "github-runner-dotfiles" ];
}
