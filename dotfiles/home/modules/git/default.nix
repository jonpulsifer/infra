{ lib, pkgs, ... }:
let
  inherit (lib) mkDefault;
  delta = "${pkgs.unstable.delta}/bin/delta";
  github = "jonpulsifer";
in
{
  home.shellAliases = {
    yeet = "${pkgs.git}/bin/git yeet";
    boop = "${pkgs.git}/bin/git boop";
  };
  programs.git = {
    enable = true;
    userName = mkDefault "Jonathan Pulsifer";
    userEmail = mkDefault "jonathan@pulsifer.ca";
    signing.key = mkDefault "~/.ssh/id_ed25519";
    signing.signByDefault = true;

    delta = {
      enable = true;
      options = {
        navigate = true;
        side-by-side = true;
      };
    };

    extraConfig = {
      color.ui = true;
      core.whitespace = "trailing-space,space-before-tab";
      format.signoff = true;
      gpg.format = "ssh";
      github.user = mkDefault github;
      help.autocorrect = 1;
      hub.protocol = "ssh";
      init.defaultBranch = "main";
      interactive.diffFilter = "${delta} --color-only";

      merge.conflictstyle = "zdiff3";
      pull.ff = "only";
      pull.rebase = true;
      push.default = "current";

      url."git@github.com:${github}/".insteadOf = [ "https://github.com/${github}/" ];
    };

    aliases = {
      ad = "add";
      boop = "commit -s --allow-empty -m '🫵 boop'";
      yeet = ''
        !commit_messages=(
          "fix: patched it (again 😅)"
          "chore: rearranged the chaos 🔄"
          "feat: 🌟 now with extra pizzazz 🌟"
          "refactor: (*╯°□°)╯︵ ┻━┻ unflipped it"
          "style: ✨ shiny and new! ✨"
          "docs: added some words 📖 (useful? maybe)"
          "test: is it soup yet? 🍲"
          "perf: 🚀 engage hyperdrive!"
          "build: 🤞 fingers crossed, again"
          "ci: ∠( ᐛ 」∠)＿ nailed it, probably"
          "fix: \"ctrl+z\" but in real life"
          "feat: 🐒 now with more monkey business"
          "refactor: ⛑️ cleaned up after the code explosion"
          "style: 🎨 Picasso would be proud"
          "docs: added ✨sparkly✨ details"
          "test: ᕕ(╯°□°)ᕗ stress-tested for rage quits"
          "perf: faster than light (or my internet)"
          "build: (╯°□°）╯︵ ┻━┻ re-flipped for luck"
          "ci: 😬 oh no, what now?"
          "fix: 🐛 squashed it (RIP bug)"
          "chore: 🍪 reward yourself with cookies!"
          "feat: 👽 we come in peace (mostly)"
          "refactor: 🧹 sweeping up the spaghetti code"
          "style: so fresh, so clean 🧼"
          "docs: ✍️ a true masterpiece of documentation"
          "test: 🔥 stress-tested with fire and tears"
          "perf: 🚗 upgraded to code 2.0 turbo"
          "build: who needs instructions anyway? 🙃"
          "ci: 🧙‍♂️ wizard-level debugging"
          "fix: patched it... or did I? 🤔"
        )
        message=''${commit_messages[$RANDOM % ''${#commit_messages[@]}]}
        git commit -sm "$message" && git push
      '';
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

      # Logs and History
      lg = "!git log --pretty=format:\"%C(dim blue)%h%Creset -%C(red)%d%Creset %s %C(dim cyan)(%cr) [%an]\" --abbrev-commit -30";
      stash-list = "stash list --pretty=format:'%C(yellow)%gd%Creset %C(red)%an%Creset: %s'";
      ilog = "log --oneline --graph --name-status --abbrev-commit";
      blame-details = "!git log -p --follow -- $1";
      repo-growth = "!git log --format='%at %s' --reverse | awk '{print strftime(\"%Y-%m-%d\", $1)}' | uniq -c";
      security-log = "!git log -p --follow -- \"$1\"";
      recent-files = "!git log --name-only --pretty=format: --since='7 days ago' | sort | uniq";
      top-contributors = "!git shortlog -sn --all --no-merges";
      audit-emails = "!git log --format='%ae' | sort | uniq -c | sort -nr";

      # Branch and Rebase Management
      wipe = "!git branch -D $1 && git push origin --delete $1";
      stale-branches = "!git for-each-ref --sort=committerdate refs/heads/ --format='%(refname:short) (%(committerdate:relative))' | grep -v 'days ago\\|months ago\\|years ago'";
      remote-br = "branch -r --sort=-committerdate --format='%(refname:short) - %(committerdate:relative)'";
      sync = "!git fetch --all && git pull --all";
      ir = "rebase -i HEAD~5";
      hooks-debug = "!cat .git/hooks/* | grep -v '^#'";
      reset-latest = "!git fetch origin && git reset --hard origin/$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's@^origin/@@')";

      # File and Size Management
      untracked = "!git ls-files --others --exclude-standard";
      bigfiles = "!git rev-list --objects --all | git cat-file --batch-check='%(objectname) %(objecttype) %(objectsize:disk) %(rest)' | sort -k3nr | head -10";
      large-file-commits = "!git rev-list --objects --all | git cat-file --batch-check='%(objectname) %(objecttype) %(objectsize) %(rest)' | awk '$3 > 1000000 {print $0}'";
      reposize = "!du -sh .git";
      files-by-author = "!git log --author=\"$1\" --name-only --pretty=format: | sort | uniq";
      check-perms = "!git ls-files -s | awk '{ if (substr($1,1,3) ~ /75[0-7]/) print $2 \" \" $4 }'";
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
