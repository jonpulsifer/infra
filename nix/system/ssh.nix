{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
let
  hostName = config.networking.hostName;
  date = inputs.self.lastModifiedDate or "19700101";
  buildDate = "${builtins.substring 0 4 date}-${builtins.substring 4 2 date}-${builtins.substring 6 2 date}";
  rev = inputs.self.shortRev or "dirty";
in
{
  services.getty.helpLine = "";

  environment.loginShellInit = ''
    if [ -n "$SSH_CONNECTION" ]; then
      read -r _l1 _l5 _l15 _rest < /proc/loadavg
      _cores=$(nproc)
      _col=$(awk -v l="$_l1" -v c="$_cores" 'BEGIN { r = l / c; if (r < 0.7) print "32"; else if (r < 1.0) print "33"; else print "31" }')
      printf '\n  \033[1m${hostName}\033[0m  ·  ${buildDate}  ·  ${rev}\n'
      printf '  ────────────────────────────────────────\n'
      printf '  load  \033[1;%sm%s\033[0m  %s  %s   ·  %s cores\n\n' "$_col" "$_l1" "$_l5" "$_l15" "$_cores"
      unset _l1 _l5 _l15 _rest _cores _col
    fi
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
