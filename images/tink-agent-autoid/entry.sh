#!/autoid/busybox sh
# With no worker_id on the kernel command line, hook-bootkit starts the agent
# with an empty ID. The NIC that holds the default route is the one that
# netbooted, so its MAC is the ID Smee would have put on the command line.
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
# fleet-intake (./intake) tells fleet-controller the machine is here. tink-agent starts whatever
# the controller answers, or if it never answers.
/autoid/fleet-intake "$ID" || echo "autoid: fleet intake failed, starting tink-agent anyway" >&2
exec /tink-agent "$@"
