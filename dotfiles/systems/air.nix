{ pkgs, ... }:
let
  hostname = "air";
in
{
  system.defaults.alf.globalstate = 1; # enabled
  system.defaults.alf.allowsignedenabled = 1;
  system.defaults.alf.allowdownloadsignedenabled = 0;
  system.defaults.alf.loggingenabled = 0;
  system.defaults.alf.stealthenabled = 0;

  system.defaults.SoftwareUpdate.AutomaticallyInstallMacOSUpdates = true;
}
