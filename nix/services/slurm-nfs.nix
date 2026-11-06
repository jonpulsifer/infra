# A scratch filesystem for folly's Slurm cluster: /srv/slurm on the root disk, exported over NFS to
# folly's nodes and pods. The login pod and every slurmd worker mount it, so a batch job's output
# reaches the login shell. Demo data only: nothing backs it up.
{ pkgs, ... }:
let
  folly = (import ../lib/networks.nix).folly;
  exportOptions = "rw,sync,no_subtree_check,insecure,no_root_squash";
in
{
  systemd.tmpfiles.rules = [
    "d /srv/slurm 1777 root root -"
  ];

  services.nfs.server = {
    enable = true;
    # Fixed ports so the auxiliary RPC services can be pinned in the firewall.
    lockdPort = 4001;
    mountdPort = 4002;
    statdPort = 4000;
    exports = ''
      /srv/slurm  ${folly.nodeCidr}(${exportOptions}) ${folly.podCidr}(${exportOptions})
    '';
  };

  networking.firewall = {
    allowedTCPPorts = [
      111 # rpcbind
      2049 # nfsd
      4000 # rpc.statd
      4001 # lockd/nlockmgr
      4002 # rpc.mountd
    ];
    allowedUDPPorts = [
      111
      2049
      4000
      4001
      4002
    ];
  };

  environment.systemPackages = [ pkgs.nfs-utils ];
}
