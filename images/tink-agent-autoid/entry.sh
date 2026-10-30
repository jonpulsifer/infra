#!/autoid/busybox sh
# With no worker_id on the kernel command line, hook-bootkit starts the agent
# with an empty ID. The NIC that holds the default route is the one that
# netbooted, so its MAC is the ID Smee would have put on the command line.
#
# Every boot attests before tink-agent waits for work: attestation is the
# intake. hook-bootkit runs this container privileged, in the host's network
# namespace, with the host's /worker mounted, so tink-attest reaches the TPM,
# the boot NIC and the switch's LLDP frame, and leaves the install code in
# /worker/fleet for the Template's install action.
B=/autoid/busybox
dev=""
if [ -z "$ID" ]; then
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    # shellcheck disable=SC2016
    dev=$($B ip route show default | $B awk '{for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit }}')
    [ -n "$dev" ] && break
    $B sleep 2
  done
  if [ -z "$dev" ]; then
    # hook-bootkit starts the container once and never again, so this boot runs no agent.
    echo "autoid: no default route after 30 seconds" >&2
    exit 1
  fi
  ID=$($B cat "/sys/class/net/$dev/address")
  WORKER_ID=$ID
  export ID WORKER_ID
fi
echo "autoid: agent ID $ID (from ${dev:-the command line})"

log() {
  echo "attest: $*"
  for t in /dev/tty0 /dev/ttyS0; do echo "attest: $*" >"$t" 2>/dev/null || true; done
}

# cmdline prints the value of a key=value word on the kernel command line.
cmdline() {
  for word in $($B cat /proc/cmdline); do
    case "$word" in
    "$1"=*)
      echo "${word#*=}"
      return
      ;;
    esac
  done
}

# attest sets the clock, which fleetd checks certificate dates against, then
# runs tink-attest until it passes, fleetd gives a verdict (exit 3), or five
# tries fail.
attest() {
  url=${ATTEST_URL:-$(cmdline fleet_attest_url)}
  ntp=${NTP_SERVER:-$(cmdline fleet_ntp_server)}
  if [ -z "$url" ]; then
    log "fleet_attest_url is empty; this boot does not attest"
    return 0
  fi
  if [ -n "$ntp" ] && $B timeout 30 $B ntpd -q -n -p "$ntp"; then
    $B hwclock --systohc --utc 2>/dev/null || log "the RTC refused the write"
    log "clock set from $ntp: $($B date -u)"
  else
    log "${ntp:-no NTP server} did not set the clock; it stays $($B date -u)"
  fi
  $B mountpoint -q /sys/kernel/security || $B mount -t securityfs securityfs /sys/kernel/security
  $B mkdir -p /worker/fleet && $B chmod 0700 /worker/fleet
  for try in 1 2 3 4 5; do
    /autoid/tink-attest -url "$url" -mac "$ID" -install-code /worker/fleet/install_code
    case $? in
    0) return 0 ;;
    3) return 1 ;;
    esac
    log "try $try failed"
    [ "$try" -lt 5 ] && $B sleep 30
  done
  return 1
}

attest || log "the machine did not attest; tink-agent starts anyway and gets no install"
exec /tink-agent "$@"
