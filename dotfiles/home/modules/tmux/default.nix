{
  config,
  lib,
  pkgs,
  ...
}:
{
  home.packages = with pkgs; [ gitmux ];
  programs.tmux = {
    enable = true;
    baseIndex = 1;
    extraConfig = builtins.readFile ./tmux.conf;
    historyLimit = 500000;
    mouse = true;
    newSession = false;
    secureSocket = lib.mkDefault true;
    sensibleOnTop = true;
    shortcut = "g";
    terminal = "screen-256color";
    plugins = with pkgs.tmuxPlugins; [
      fuzzback
      fzf-tmux-url
      tmux-fzf
      {
        plugin = mkTmuxPlugin {
          pluginName = "1password";
          rtpFilePath = "plugin.tmux";
          version = "master";
          src = pkgs.fetchFromGitHub {
            owner = "yardnsm";
            repo = "tmux-1password";
            rev = "bb1bbd2acfe1b4d5dcf917f6ddf3b0f634a13362";
            sha256 = "sha256-k+4mHE7oEjp85aPv0oOcjgecfvM/s0rG8x332bvn+4Y=";
          };
        };
        extraConfig = ''
          set -g @1password-subdomain 'pulsifer'
          set -g @1password-vault 'afh4hmnamahifeepetyjloissq'
          set -g @1password-key 'x'
          set -g @1password-copy-to-clipboard 'off'
          set -g @1password-filter-tags 'tmux'
        '';
      }
    ];
  };
}
