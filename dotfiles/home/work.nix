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
  imports = [
    ./basic.nix
    ./darwin.nix
    modules/ai
    modules/kubernetes.nix
    modules/peon-ping.nix
  ];

  home.username = mkForce username;
  home.packages = with pkgs; [
    ffmpeg
    moonpay-cli
  ];

  # homebrew paths like to be at the top of the path list
  programs.zsh.initContent = lib.mkOrder 100 ''
    export PATH="/opt/homebrew/sbin:$PATH"
    export PATH="/opt/homebrew/bin:$PATH"
  '';

  programs.zsh.profileExtra = ''
    fpath[1,0]="/opt/homebrew/share/zsh/site-functions";
  '';

  # We use the cask version of ghostty
  programs.ghostty.package = null;

  programs.git = {
    signing.key = mkForce "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG4dHeSXomLf4FxyBJHrHihldnQXpJ3xcE57u2sOfaay";
    settings = {
      user.email = mkForce email;
      url."git@github.com:${toLower company}/".insteadOf = [
        "git@github.com:${company}/"
        "https://github.com/${toLower company}/"
      ];
      gpg.ssh.program = "/Applications/1Password.app/Contents/MacOS/op-ssh-sign";
    };
  };

  ai.mcpServers.moonpay = {
    command = "mp";
    args = [ "mcp" ];
  };
  ai.mcpServers.notion = {
    type = "http";
    url = "https://mcp.notion.com/mcp";
  };
  ai.mcpServers.linear = {
    type = "http";
    url = "https://mcp.linear.app/mcp";
  };

  programs.peon-ping = {
    enable = true;
    enableClaudeCodeIntegration = true;
    enableGeminiIntegration = true;
    enableOpenCodeIntegration = true;
    settings = {
      default_pack = "wc2_human_ships";
    };
  };

  programs.ssh.enable = true;
  programs.ssh.enableDefaultConfig = false;
  programs.ssh.matchBlocks."*" = {
    extraOptions = {
      IdentityAgent = "\"~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock\"";
      IdentitiesOnly = "no";
      VisualHostKey = "no";
      PasswordAuthentication = "no";
      ChallengeResponseAuthentication = "no";
      StrictHostKeyChecking = "ask";
      UpdateHostKeys = "ask";
      VerifyHostKeyDNS = "yes";
      ForwardX11 = "no";
      ForwardX11Trusted = "no";
      Ciphers = "chacha20-poly1305@openssh.com,aes256-gcm@openssh.com";
      MACs = "hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com";
      KexAlgorithms = "curve25519-sha256@libssh.org,diffie-hellman-group-exchange-sha256";
      HostKeyAlgorithms = "ssh-ed25519-cert-v01@openssh.com,ssh-rsa-cert-v01@openssh.com,ssh-ed25519,ssh-rsa";
    };
  };
}
