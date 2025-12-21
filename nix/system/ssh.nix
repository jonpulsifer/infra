{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
{
  users.motd = ''
    ${pkgs.fastfetch}/bin/fastfetch
    Built at ${builtins.toString inputs.self.lastModified} | ${pkgs.cowsay}/bin/cowsay -f moose | ${pkgs.dotacat}/bin/dotacat
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
