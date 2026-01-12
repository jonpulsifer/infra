{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
{
  users.motd =
    let
      hostName = config.networking.hostName;
      date = inputs.self.lastModifiedDate or "19700101";
      buildDate = "${builtins.substring 0 4 date}-${builtins.substring 4 2 date}-${builtins.substring 6 2 date}";
      rev = inputs.self.shortRev or "dirty";
    in
    ''
             o8o
             `"'
ooo. .oo.   oooo  oooo    ooo  .ooooo.   .oooo.o
`888P"Y88b  `888   `88b..8P'  d88' `88b d88(  "8
 888   888   888     Y888'    888   888 `"Y88b.
 888   888   888   .o8"'88b   888   888 o.  )88b
o888o o888o o888o o88'   888o `Y8bod8P' 8""888P'
 ${hostName}  ${buildDate}  ${rev}
    '';
  programs.ssh.startAgent = true;

  programs.gnupg.agent = {
    enable = false;
    enableExtraSocket = true;
    enableSSHSupport = true;
  };

  services.openssh = {
    enable = true;
    settings = {
      AllowAgentForwarding = true;
      ChallengeResponseAuthentication = false;
      KbdInteractiveAuthentication = false;
      PasswordAuthentication = false;
      PermitRootLogin = "no";
    };

    hostKeys = [
      {
        type = "ed25519";
        path = "/etc/ssh/ssh_host_ed25519_key";
      }
    ];
  };
  services.sshguard.enable = true;
}
