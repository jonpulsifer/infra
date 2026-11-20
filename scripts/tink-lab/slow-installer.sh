#!/tinklab/busybox sh
# shellcheck shell=busybox
# tink-lab's slow installer, which tink-lab.sh slow-installer puts in front of the class's Talos
# installer. Every second for the seconds in /tinklab/seconds it writes a tick, a 512-byte record
# with a count, the time and the container's hostname, 1 MiB from the end of the --disk it was
# given, and echoes it to the serial console. Then it runs the real installer with the same
# arguments, with its output on the console too. wipe-disk zeroes that sector, so a tick there
# after a wipe, or after the install action's timeout, is a disk writer that outlived its action.
B=/tinklab/busybox
secs=$($B cat /tinklab/seconds)
disk="" prev=""
for a in "$@"; do
  [ "$prev" = --disk ] && disk=$a
  prev=$a
done
[ -b "$disk" ] || {
  echo "slow-installer: no --disk block device"
  exit 1
}
sector=$(($($B blockdev --getsize64 "$disk") / 512 - 2048))
n=0
while [ "$n" -lt "$secs" ]; do
  n=$((n + 1))
  rec="TINKLAB-TICK n=$n t=$($B date +%s) host=$($B hostname)"
  $B printf '%-511s\n' "$rec" | $B dd of="$disk" bs=512 seek="$sector" count=1 conv=notrunc,fsync 2>/dev/null
  echo "slow-installer: $rec" | $B tee /dev/ttyS0
  $B sleep 1
done
echo "slow-installer: running the real installer" | $B tee /dev/ttyS0
set -o pipefail
/tinklab/installer "$@" 2>&1 | $B tee /dev/ttyS0
