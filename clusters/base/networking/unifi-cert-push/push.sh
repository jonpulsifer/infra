#!/bin/sh
set -eu

# Installs the cluster's gateway certificate on the UniFi gateway console
# (unifi-core serves the UI) and restarts unifi-core only when it changed.
# Auth is the console root password, passed to sshpass via $SSHPASS.

gw=${GATEWAY:?}
crt=/cert/tls.crt
key=/cert/tls.key

run() {
  sshpass -e ssh \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR \
    -o ConnectTimeout=10 \
    "root@${gw}" "$@"
}

local_sum=$(md5sum "${crt}" | cut -d' ' -f1)
remote_sum=$(run "md5sum /data/unifi-core/config/unifi-core.crt 2>/dev/null | cut -d' ' -f1" || true)

if [ "${local_sum}" = "${remote_sum}" ]; then
  echo "certificate unchanged (${local_sum})"
  exit 0
fi

# The crt is the convergence sentinel (compared above), so it must land last:
# key first, then crt chained with the restart in one remote command. Any
# interrupted run leaves the old crt in place and the next run redoes
# everything; the only unhealed failure is restart-after-crt-write, which
# stays a loudly failing Job instead of a false "unchanged".
run "umask 077; cat > /data/unifi-core/config/unifi-core.key" < "${key}"
run "cat > /data/unifi-core/config/unifi-core.crt && systemctl restart unifi-core" < "${crt}"
echo "installed ${local_sum} on ${gw}; unifi-core restarted"
