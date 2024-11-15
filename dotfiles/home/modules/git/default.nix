{ lib, pkgs, ... }:
let
  inherit (lib) mkDefault;
  github = "jonpulsifer";
in
{
  home.shellAliases = {
    yeet = "${pkgs.git}/bin/git yeet";
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
      ad = "add";
      boop = "git commit -s --allow-empty -m '🫵 boop'";
      yeet = ''
        !commit_messages=(
          "fix: oops"
          "chore: move things around"
          "feat: add more cowbell"
          "refactor: let's try this again"
          "style: make it pop"
          "docs: add more emojis"
          "test: hope this works"
          "perf: zoom zoom"
          "build: maybe it'll work this time"
          "ci: cross your fingers"
        )
        message=''${commit_messages[$RANDOM % ''${#commit_messages[@]}]}
        git commit -sm "$message" && git push
      '';
      letsgo = "!git lfg";
      lfg = "!{ git checkout main || git checkout master; } && git pull --rebase";
      lol = "log --graph --decorate --pretty=oneline --abbrev-commit --all";
      stash-pull-pop = "!git stash && git pull --rebase && git stash pop";
      co = "checkout";
      d = "diff";
      s = "status";
      f = "fetch";
      del = "branch -D";
      br = "branch --format='%(HEAD) %(color:yellow)%(refname:short)%(color:reset) - %(contents:subject) %(color:green)(%(committerdate:relative)) [%(authorname)]' --sort=-committerdate";
      save = "!git add -A && git commit -m 'chore: savepoint'";
      undo = "reset HEAD~1 --mixed";
      lg = "!git log --pretty=format:\"%C(dim blue)%h%Creset -%C(red)%d%Creset %s %C(dim cyan)(%cr) [%an]\" --abbrev-commit -30";
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
