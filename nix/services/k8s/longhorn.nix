{
  config,
  lib,
  pkgs,
  ...
}:
{
  config = lib.mkIf config.services.k8s.enable {
    # TODO(2025-09-21): this is probably not required
    environment.systemPackages = [ pkgs.openiscsi ];

    systemd.services.containerd.path = [
      pkgs.openiscsi

      # TODO(2025-09-21): double check these are still required
      "/run/wrappers/bin"
      "/run/current-system/sw/bin/"
    ];
    systemd.tmpfiles.rules = [
      "L+ /usr/local/bin - - - - /run/current-system/sw/bin/"
    ];
  };
}
