#!/autoid/busybox sh
# tink-lab's stand-in for attestation, layered on the lab's tink-agent-autoid image. The lab's
# entry.sh runs tink-attest against fleetd, which leaves /worker/fleet/attested and the install
# code; nothing here can answer that flow, so this leaves what a verdict would and then runs the
# lab's entry.sh, whose attest step skips itself because fleet_attest_url is empty.
#
# tinklab_attest= on the kernel command line picks the verdict: pass (the default) writes the
# marker, a fresh 43-character code and the lab's Ubuntu payload (/tinklab/payload.tar.gz, from
# agent/user-data), nocode writes the marker only, fail writes none of them.
B=/autoid/busybox

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

log() {
  echo "tink-lab attest: $*"
  for t in /dev/tty0 /dev/ttyS0; do echo "tink-lab attest: $*" >"$t" 2>/dev/null || true; done
}

if [ -n "$(cmdline fleet_attest_url)" ]; then
  log "fleet_attest_url is set; refusing to run against a real attestation service"
  exit 1
fi

$B mkdir -p /worker/fleet && $B chmod 0700 /worker/fleet
$B rm -f /worker/fleet/attested /worker/fleet/install_code /worker/fleet/payload.tar.gz
verdict=$(cmdline tinklab_attest)
case "${verdict:-pass}" in
  pass)
    (umask 077 && $B head -c 32 /dev/urandom | $B base64 | $B tr '+/' '-_' | $B tr -d '=\n' >/worker/fleet/install_code)
    (umask 077 && $B cp /tinklab/payload.tar.gz /worker/fleet/payload.tar.gz)
    : >/worker/fleet/attested
    log "PASSED (stand-in); install code and payload written"
    ;;
  nocode)
    : >/worker/fleet/attested
    log "PASSED (stand-in); no install code"
    ;;
  *)
    log "FAILED (stand-in)"
    ;;
esac
exec $B sh /autoid/entry.sh "$@"
