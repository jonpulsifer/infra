{ pkgs, ... }:
let hostname = "JTWV573RHQ";
in {
  networking = {
    computerName = hostname;
    hostName = hostname;
    localHostName = hostname;
  };
  security.pam.enableSudoTouchIdAuth = true;
}
