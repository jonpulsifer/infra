{ lib, pkgs, config, ... }:
let
  inherit (lib) mkForce;
  inherit (lib.strings) toLower;

  company = "MoonPay";
  domain = (toLower company) + ".com";
  user = "jonathan";
  email = "${user}@${domain}";
in
{
  imports = [ ./default.nix ./gui.nix ];
  home.packages = with pkgs; [ awscli2 cloudflared ffmpeg nodejs_18 python3 terraform-docs gnupg ];
  programs.git = {
    userEmail = mkForce email;
    signing.key = mkForce "~/.ssh/${toLower company}_ed25519";
    extraConfig = {
      url."git@github.com:${toLower company}/".insteadOf = [
        "git@github.com:${company}/"
        "https://github.com/${toLower company}/"
      ];
    };
  };

  programs.ssh.extraConfig = mkForce ''
    IdentityFile ~/.ssh/${toLower company}_ed25519
    IdentitiesOnly yes
    AddressFamily inet
    VisualHostKey no
    PasswordAuthentication no
    ChallengeResponseAuthentication no
    StrictHostKeyChecking ask
    VerifyHostKeyDNS yes
    ForwardX11 no
    ForwardX11Trusted no
    Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com
    MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com
    KexAlgorithms curve25519-sha256@libssh.org,diffie-hellman-group-exchange-sha256
    HostKeyAlgorithms ssh-ed25519-cert-v01@openssh.com,ssh-rsa-cert-v01@openssh.com,ssh-ed25519,ssh-rsa
  '';
}
