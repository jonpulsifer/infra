{ lib, pkgs, ... }:
let
  inherit (lib) mkDefault;
  github = "jonpulsifer";
in
{
  home.shellAliases = {
    yeet = "${pkgs.git}/bin/git commit -sm \"\$(${pkgs.curl}/bin/curl -s https://whatthecommit.com/index.txt)\" && ${pkgs.git}/bin/git push";
  };
  programs.git = {
    enable = true;
    userName = mkDefault "Jonathan Pulsifer";
    userEmail = mkDefault "jonathan@pulsifer.ca";
    signing.key = mkDefault "~/.ssh/id_ed25519";
    signing.signByDefault = true;

    extraConfig = {
      color.ui = true;
      core = { whitespace = "trailing-space,space-before-tab"; };
      format = { signoff = true; };
      gpg.format = "ssh";
      github.user = mkDefault github;
      help = { autocorrect = 1; };
      hub.protocol = "https";
      init.defaultBranch = "main";
      pull = { ff = "only"; };
      pull.rebase = true;
      push = { default = "current"; };
      url."git@github.com:${github}/".insteadOf =
        [ "https://github.com/${github}/" ];
    };

    aliases = {
      co = "checkout";
      d = "diff";
      s = "status";
      f = "fetch";
    };

    ignores = [
      ".DS_Store"
      "*~"
      "*.swp"
      "*_rsa"
      "*_ed25519"
      "*.pub"
      "credentials.json"
      "secrets*.json"
      "\\#*\\#"
      "*~"
      ".#*"
      ".env"
      ".env.production*"
    ];
  };
}
