{ config, pkgs, ... }:

{
  hardware.raspberry-pi."4".touch-ft5406.enable = true;

  users.users.kiosk = {
    isNormalUser = true;
    openssh.authorizedKeys.keys = config.users.users.jawn.openssh.authorizedKeys.keys;
    extraGroups = [
      "audio"
      "input"
      "networkmanager"
      "tty"
      "video"
    ];
    shell = pkgs.zsh;
  };
  services.cage = {
    enable = true;
    user = "kiosk";
    # extraArguments = [ "-d" ];
    program = "${pkgs.firefox}/bin/firefox -kiosk -private-window https://headerz.lolwtf.ca";
  };
}
