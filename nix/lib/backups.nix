# Backup facts shared by the Garage hosts and the host backup jobs. Each site backs up into a
# Garage S3 store on one of its own hosts; the clusters copy it to GCS.
{ pkgs }:
let
  fleet = import ./fleet.nix;
  metricsDir = "/var/lib/prometheus-node-exporter-text-files";
in
rec {
  s3Port = 3900;

  garageHosts = {
    folly = "spore";
    offsite = "oldschool";
  };

  s3Endpoint = site: "http://${garageHosts.${site}}.${fleet.dnsZone}:${toString s3Port}";

  # Writes lab_backup_last_success_timestamp_seconds for one source into the node-exporter
  # textfile directory. Run it as root, and only after the job succeeds.
  heartbeat =
    source:
    pkgs.writeShellScript "lab-backup-heartbeat-${source}" ''
      set -euo pipefail
      metrics=$(${pkgs.coreutils}/bin/mktemp ${metricsDir}/.lab-backup-${source}.XXXXXX)
      trap '${pkgs.coreutils}/bin/rm -f "$metrics"' EXIT
      {
        printf '# HELP lab_backup_last_success_timestamp_seconds Unix time of the last successful backup job.\n'
        printf '# TYPE lab_backup_last_success_timestamp_seconds gauge\n'
        printf 'lab_backup_last_success_timestamp_seconds{source="%s"} %s\n' ${source} "$(${pkgs.coreutils}/bin/date +%s)"
      } > "$metrics"
      # mktemp creates 0600, and node_exporter reads the directory as its own user.
      ${pkgs.coreutils}/bin/chmod 0644 "$metrics"
      ${pkgs.coreutils}/bin/mv "$metrics" ${metricsDir}/lab-backup-${source}.prom
      trap - EXIT
    '';
}
