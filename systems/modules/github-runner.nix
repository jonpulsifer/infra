{ pkgs, ... }: {
  services.github-runners = {
    infra = {
      enable = true;
      url = "https://github.com/jonpulsifer/infra";
      tokenFile = "/var/secrets/github-token-infra";
      replace = true;
      extraPackages = with pkgs; [ cachix unzip ];
    };
    dotfiles = {
      enable = true;
      url = "https://github.com/jonpulsifer/dotfiles";
      tokenFile = "/var/secrets/github-token-dotfiles";
      replace = true;
      extraPackages = with pkgs; [ cachix ];
    };
    ts = {
      enable = true;
      url = "https://github.com/jonpulsifer/ts";
      tokenFile = "/var/secrets/github-token-ts";
      replace = true;
      extraPackages = with pkgs; [ ];
    };
  };
  nix.settings.trusted-users = [ "github-runner-infra" "github-runner-dotfiles" ];
}
