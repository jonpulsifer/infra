#!/usr/bin/env bash
set -euo pipefail

# Read-only audit of a host's GPT partlabels against nix/disko/default.nix. Without the disk-main-*
# partlabels the initrd cannot find root; disko-partlabel-migrate.sh adds them.
# Usage: ssh <host> 'sudo bash -s' < disko-partlabel-check.sh. Exit 0 migrated, 1 needs migration, 2 manual review.

# /mnt/disks is mounted nofail, so it is optional.
declare -A EXPECT=(
  ["/boot"]="disk-main-ESP"
  ["/"]="disk-main-nixos"
  ["/mnt/disks"]="disk-main-storage"
)
declare -A OPTIONAL=( ["/mnt/disks"]=1 )

# Under set -e, an absent mount must not abort the script.
source_of()    { findmnt -no SOURCE "$1" 2>/dev/null | head -n1 || true; }
partlabel_of() { lsblk -no PARTLABEL "$1" 2>/dev/null | head -n1 || true; }
parent_of()    { lsblk -no PKNAME "$1" 2>/dev/null | head -n1 || true; }
is_partition() { [[ -r "/sys/class/block/$(basename "$1")/partition" ]]; }

host="$(hostname)"
echo ">> Host: ${host}"
printf '   %-12s %-16s %-26s %s\n' "MOUNT" "DEVICE" "PARTLABEL (current)" "STATUS"

rc=0
disks=()

for mnt in /boot / /mnt/disks; do
  want="${EXPECT[$mnt]}"
  src="$(source_of "$mnt")"

  if [[ -z "${src}" ]]; then
    if [[ -n "${OPTIONAL[$mnt]:-}" ]]; then
      printf '   %-12s %-16s %-26s %s\n' "$mnt" "-" "-" "absent (optional)"
      continue
    fi
    printf '   %-12s %-16s %-26s %s\n' "$mnt" "-" "-" "MISSING (manual review)"
    rc=2; continue
  fi

  dev="$(realpath "$src" 2>/dev/null || echo "$src")"
  if ! is_partition "$dev"; then
    printf '   %-12s %-16s %-26s %s\n' "$mnt" "$dev" "-" "not a plain partition (manual review)"
    rc=2; continue
  fi

  disks+=("$(parent_of "$dev")")
  cur="$(partlabel_of "$dev")"

  if [[ "${cur}" == "${want}" ]]; then
    status="ok"
  elif [[ -z "${cur}" ]]; then
    status="NEEDS RENAME (-> ${want})"
    [[ $rc -lt 1 ]] && rc=1
  else
    status="NEEDS RENAME (${cur} -> ${want})"
    [[ $rc -lt 1 ]] && rc=1
  fi
  printf '   %-12s %-16s %-26s %s\n' "$mnt" "$dev" "${cur:-<none>}" "$status"
done

# Every partition must be on one disk.
uniq_disks="$(printf '%s\n' "${disks[@]}" | sort -u | grep -v '^$' || true)"
if [[ "$(printf '%s\n' "$uniq_disks" | grep -c . || true)" -gt 1 ]]; then
  echo "!! Mounts span multiple disks (${uniq_disks//$'\n'/, }); review before relabelling."
  rc=2
fi

echo ""
case $rc in
  0) echo ">> Verdict: already migrated — by-partlabel matches disko." ;;
  1) echo ">> Verdict: migration needed — run disko-partlabel-migrate.sh on this host." ;;
  2) echo ">> Verdict: manual review needed — layout does not match the expected disko shape." ;;
esac
exit $rc
