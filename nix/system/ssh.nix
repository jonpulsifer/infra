{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
let
  # Old-school unauthorized-access warning shown BEFORE login, on both the
  # console (/etc/issue via getty) and SSH (pre-auth banner). Keep the stars
  # aligned, eh.
  warning = ''
    ********************************************************************
    *                          W A R N I N G                           *
    *                                                                  *
    * This is a PRIVATE computer system operated by the                *
    * pulsifer.ca homelab AUTHORITY, eh.                               *
    *                                                                  *
    * Unauthorized access is prohibited under Section 342.1 of         *
    * the Criminal Code of Canada and will be dealt with               *
    * sternly, politely, and then reported to the RCMP.                *
    *                                                                  *
    * By accessing this system you consent to monitoring and           *
    * recording. There is NO expectation of privacy, sorry.            *
    *                                                                  *
    * Evidence of unauthorized activity may be handed over to          *
    * the authorities and/or your mother.                              *
    *                                                                  *
    * AUTHORIZED PERSONNEL: PROCEED.   EVERYONE ELSE: SORRY, BUD.      *
    ********************************************************************
  '';

  hostName = config.networking.hostName;
  date = inputs.self.lastModifiedDate or "19700101";
  buildDate = "${builtins.substring 0 4 date}-${builtins.substring 4 2 date}-${builtins.substring 6 2 date}";
  rev = inputs.self.shortRev or "dirty";
in
{
  # Pre-login console banner (/etc/issue).
  services.getty.greetingLine = warning;
  services.getty.helpLine = "";

  # Post-auth, SSH-only login banner: hostname · build date · rev, with a live
  # load average coloured green (chill) -> yellow (busy) -> red (cooking).
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
      # Pre-auth SSH banner (mirrors the console warning).
      Banner = pkgs.writeText "ssh-banner" warning;
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
