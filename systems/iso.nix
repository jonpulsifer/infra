{ config, lib, ... }: with lib; {
  users.users = {
    # Remove initialHashedPassword for root and nixos
    root.initialHashedPassword = mkForce null;
    nixos.initialHashedPassword = mkForce null;
    jawn.extraGroups = [ "video" "networkmanager" ];
  };

  # why is this a thing that exists
  services.openssh.settings.PermitRootLogin = mkForce "no";

  # auto log me in and let me be a trusted user
  services.getty.autologinUser = mkForce config.users.users.jawn.name;
}
  
