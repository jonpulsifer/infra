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
      fzf-tmux-url
      tmux-fzf
    ];
  };
}
