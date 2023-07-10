{ config, pkgs, ... }:
let
  kioskUser = "kiosk";
  kioskUrl = "https://headerz.lolwtf.ca";
in
{
  hardware.raspberry-pi."4".touch-ft5406.enable = true;
  hardware.raspberry-pi."4".fkms-3d.enable = true;

  users.users.${kioskUser} = {
    isNormalUser = true;
    openssh.authorizedKeys.keys = config.users.users.jawn.openssh.authorizedKeys.keys;
    extraGroups = [
      "audio"
      "input"
      "tty"
      "video"
    ];
    shell = pkgs.zsh;
  };
  services.xserver = {
    enable = true;
    displayManager.lightdm.enable = true;
    displayManager.autoLogin.enable = true;
    displayManager.autoLogin.user = kioskUser;
  };
}
