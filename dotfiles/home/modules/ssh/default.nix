{ config, lib, pkgs, ... }:
let
  inherit (lib) mkIf;
  inherit (pkgs.stdenv) isLinux;
in
{
  home.sessionVariables = { SSH_AUTH_SOCK = "$XDG_RUNTIME_DIR/ssh-agent.sock"; };
  programs.zsh.shellAliases = {
    sshpw = "SSH_ASKPASS=${pkgs.shell-utils}/bin/sshpw DISPLAY=1 ssh-add ${config.programs.git.signing.key} < /dev/null";
  };
  programs.ssh = {
    enable = true;
    compression = true;
    forwardAgent = false; # Disabled globally for better security
    serverAliveInterval = 300;
    serverAliveCountMax = 2;
    hashKnownHosts = true;
    controlMaster = "auto";
    extraConfig = ''
      AddKeysToAgent yes
      AddressFamily inet
      ChallengeResponseAuthentication no
      ForwardX11 no
      ForwardX11Trusted no
      PasswordAuthentication no
      StrictHostKeyChecking yes
      VerifyHostKeyDNS yes
      VisualHostKey no
      HostKeyAlgorithms ssh-ed25519-cert-v01@openssh.com,ssh-ed25519
      Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com
      KexAlgorithms curve25519-sha256@libssh.org,diffie-hellman-group-exchange-sha256
      MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com
    '';
    matchBlocks = {
      "*.fml.pulsifer.ca" = { port = 22; forwardAgent = true; };
      "*.lolwtf.ca" = { port = 22; forwardAgent = true; };
      "github.com" = {
        user = "git";
        forwardAgent = true; # Enable agent forwarding only for GitHub
      };
      "*pi0*" = {
        user = "pi";
        forwardAgent = true;
        extraOptions = {
          PasswordAuthentication = "yes"; # Retained for compatibility
        };
      };
      "pikvm" = {
        user = "root";
        extraOptions = {
          PasswordAuthentication = "yes"; # Retained for compatibility
        };
      };
      "unifi" = {
        user = "root";
        extraOptions = {
          PasswordAuthentication = "yes"; # Legacy compatibility
          Ciphers = "aes256-ctr"; # Optimized for older devices
          MACs = "hmac-sha2-256";
        };
      };
      "erx-eth0" = {
        user = "ubnt";
        extraOptions = {
          PasswordAuthentication = "yes"; # Legacy compatibility
        };
      };
      "compute.*" = {
        extraOptions = {
          ChallengeResponseAuthentication = "yes"; # Needed for GCE OS Login 2FA
        };
      };
    };
  };
  systemd.user.services.ssh-agent = mkIf isLinux {
    Unit.Description = "SSH Agent";
    Install.WantedBy = [ "default.target" ];
    Service = {
      Environment = [ "SSH_AUTH_SOCK=%t/ssh-agent.sock" ];
      ExecStart = "ssh-agent -D -a $SSH_AUTH_SOCK";
      Restart = "on-failure";
    };
  };
}
