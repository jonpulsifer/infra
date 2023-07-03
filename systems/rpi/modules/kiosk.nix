{ config, pkgs, ... }:

{
  boot = {
    kernelModules = [ "vc4" ];
    availableKernelModules = [ "usbhid" "usb_storage" "vc4" "bcm2835_dma" "i2c_bcm2835" ];
  };
  users.users.kiosk = {
    isNormalUser = true;
    openssh.authorizedKeys.keys = config.users.users.jawn.openssh.authorizedKeys.keys;
    extraGroups = [ "tty" ];
    shell = pkgs.zsh;
  };
  services.cage = {
    enable = true;
    user = "kiosk";
    program = "${pkgs.firefox}/bin/firefox -kiosk -private-window https://headerz.lolwtf.ca";
  };
}
