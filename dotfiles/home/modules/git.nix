{ lib, pkgs, ... }:
let
  inherit (lib) mkDefault;
  github = "jonpulsifer";
in
{
  home.shellAliases = {
    boop = "${pkgs.git}/bin/git boop";
  };

  programs.gh = {
    enable = true;
    extensions = [ pkgs.gh-aipr ];
  };

  programs.git = {
    enable = true;
    signing.key = mkDefault "~/.ssh/id_ed25519";
    signing.signByDefault = true;

    settings = {
      user.name = mkDefault "Jonathan Pulsifer";
      user.email = mkDefault "jonathan@pulsifer.ca";

      color.ui = true;
      core.whitespace = "trailing-space,space-before-tab";
      format.signoff = true;
      gpg.format = "ssh";
      github.user = mkDefault github;
      help.autocorrect = 1;
      hub.protocol = "ssh";
      init.defaultBranch = "main";

      merge.conflictstyle = "zdiff3";
      pull.ff = "only";
      pull.rebase = true;
      push.default = "current";

      url."git@github.com:${github}/".insteadOf = [ "https://github.com/${github}/" ];

      alias = {
        ad = "add";
        boop = "commit -s --allow-empty -m '🫵 boop'";
        letsgo = "lfg";
        lfg = "!branch=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's@^origin/@@'); git checkout $branch && git pull --rebase";
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

        lg = ''!git log --pretty=format:"%C(dim blue)%h%Creset -%C(red)%d%Creset %s %C(dim cyan)(%cr) [%an]" --abbrev-commit -30'';
        stash-list = "stash list --pretty=format:'%C(yellow)%gd%Creset %C(red)%an%Creset: %s'";
        ilog = "log --oneline --graph --name-status --abbrev-commit";
        blame-details = "!git log -p --follow -- $1";
        repo-growth = ''!git log --format='%at %s' --reverse | awk '{print strftime("%Y-%m-%d", $1)}' | uniq -c'';
        security-log = ''!git log -p --follow -- "$1"'';
        recent-files = "!git log --name-only --pretty=format: --since='7 days ago' | sort | uniq";
        top-contributors = "!git shortlog -sn --all --no-merges";
        audit-emails = "!git log --format='%ae' | sort | uniq -c | sort -nr";

        wipe = "!git branch -D $1 && git push origin --delete $1";
        stale-branches = "!git for-each-ref --sort=committerdate refs/heads/ --format='%(refname:short) (%(committerdate:relative))' | grep -v 'days ago\\|months ago\\|years ago'";
        remote-br = "branch -r --sort=-committerdate --format='%(refname:short) - %(committerdate:relative)'";
        sync = "!git fetch --all && git pull --all";
        ir = "rebase -i HEAD~5";
        hooks-debug = "!cat .git/hooks/* | grep -v '^#'";
        reset-latest = "!git fetch origin && git reset --hard origin/$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's@^origin/@@')";

        untracked = "!git ls-files --others --exclude-standard";
        bigfiles = "!git rev-list --objects --all | git cat-file --batch-check='%(objectname) %(objecttype) %(objectsize:disk) %(rest)' | sort -k3nr | head -10";
        large-file-commits = "!git rev-list --objects --all | git cat-file --batch-check='%(objectname) %(objecttype) %(objectsize) %(rest)' | awk '$3 > 1000000 {print $0}'";
        reposize = "!du -sh .git";
        files-by-author = ''!git log --author="$1" --name-only --pretty=format: | sort | uniq'';
        check-perms = "!git ls-files -s | awk '{ if (substr($1,1,3) ~ /75[0-7]/) print $2 \" \" $4 }'";
      };
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
      ".env*.local"
      ".env.production*"
      "tmp"
      "temp"
    ];
  };
}
