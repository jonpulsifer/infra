# HookOS's syslog on spore: rsyslog listens on UDP 514 at spore's bootstrap address, where HookOS's
# signed command line sends it (../images/hookos-folly.nix), and writes each line to the journal
# under the identifier hookos, with the sender's address in HOOKOS_HOST and its program in
# HOOKOS_PROGRAM. Smee's receiver (./tinkerbell.nix) did this while Smee ran; the two cannot share
# the port.
{
  config,
  lib,
  ...
}:
let
  cfg = config.homelab.hookosSyslog;
  lab = import ../lib/anchor.nix;
  iface = "bootstrap";
  address = lab.bootstrap.hosts.spore;
  port = 514;
  spoolDir = "/var/spool/rsyslog";
in
{
  options.homelab.hookosSyslog.enable = lib.mkEnableOption "rsyslog receiving HookOS's syslog on the bootstrap VLAN";

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !config.homelab.tinkerbell.smee.enable;
        message = "hookos-syslog.nix and Smee would both listen on ${address}:${toString port}; turn one off.";
      }
      {
        assertion = config.networking.vlans ? ${iface};
        message = "hookos-syslog.nix binds to the ${iface} VLAN, which talos-boot.nix declares.";
      }
    ];

    services.rsyslogd = {
      enable = true;
      # spore's own logs stay in the journal: no local files, and no forwarding from journald below.
      defaultConfig = "";
      extraConfig = ''
        module(load="imudp")
        module(load="omjournal")

        template(name="hookos" type="list") {
          constant(outname="SYSLOG_IDENTIFIER" value="hookos")
          property(outname="MESSAGE" name="msg")
          property(outname="PRIORITY" name="syslogseverity")
          property(outname="SYSLOG_FACILITY" name="syslogfacility")
          property(outname="HOOKOS_HOST" name="fromhost-ip")
          property(outname="HOOKOS_PROGRAM" name="programname")
        }

        ruleset(name="hookos" queue.type="LinkedList") {
          action(type="omjournal" template="hookos")
        }

        input(type="imudp" address="${address}" port="${toString port}" ruleset="hookos")
      '';
    };
    services.journald.extraConfig = "ForwardToSyslog=no";

    systemd.tmpfiles.rules = [ "d ${spoolDir} 0700 root root -" ];

    systemd.services.syslog = {
      requires = [ "sys-subsystem-net-devices-${iface}.device" ];
      after = [ "sys-subsystem-net-devices-${iface}.device" ];
      serviceConfig = {
        Restart = "on-failure";
        RestartSec = "5s";
        NoNewPrivileges = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectClock = true;
        ProtectControlGroups = true;
        ProtectHome = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectSystem = "strict";
        ReadWritePaths = [ spoolDir ];
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [ "@system-service" ];
        SystemCallErrorNumber = "EPERM";
      };
    };

    networking.firewall.interfaces.${iface}.allowedUDPPorts = [ port ];
  };
}
