{
  lib,
  pkgs,
  config,
  ...
}:
let
  inherit (lib) mkForce;
  inherit (lib.strings) toLower;

  company = "MoonPay";
  domain = (toLower company) + ".com";
  user = "jonathan";
  email = "${user}@${domain}";
  username = "jpulsifer";
in
{  
  imports = [ ./default.nix ];

  home.username = mkForce username;

  programs.git = {
    userEmail = mkForce email;
    signing.key = mkForce "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG4dHeSXomLf4FxyBJHrHihldnQXpJ3xcE57u2sOfaay";
    extraConfig = {
      url."git@github.com:${toLower company}/".insteadOf = [
        "git@github.com:${company}/"
        "https://github.com/${toLower company}/"
      ];
      gpg.ssh.program = "/Applications/1Password.app/Contents/MacOS/op-ssh-sign";
    };
  }; 

  programs.ssh.enable = true;
  programs.ssh.extraConfig = ''
    IdentityAgent "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
    IdentitiesOnly no
    VisualHostKey no
    PasswordAuthentication no
    ChallengeResponseAuthentication no
    StrictHostKeyChecking ask
    UpdateHostKeys ask
    VerifyHostKeyDNS yes
    ForwardX11 no
    ForwardX11Trusted no
    Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com
    MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com
    KexAlgorithms curve25519-sha256@libssh.org,diffie-hellman-group-exchange-sha256
    HostKeyAlgorithms ssh-ed25519-cert-v01@openssh.com,ssh-rsa-cert-v01@openssh.com,ssh-ed25519,ssh-rsa
  '';
}
