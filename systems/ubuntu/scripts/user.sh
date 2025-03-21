#!/usr/bin/env bash
set -xueo pipefail

LINUX_USER="${LINUX_USER:-jawn}"
LINUX_UUID="${LINUX_UUID:-1337}"
GITHUB_USER="${GITHUB_USER:-jonpulsifer}"
AUTHORIZED_KEYS="/var/ssh/${LINUX_USER}/authorized_keys"

# user
adduser \
  --disabled-password \
  --GECOS '' \
  --uid "${LINUX_UUID}" \
  "${LINUX_USER}"

# sudo
echo "${LINUX_USER}	ALL=(ALL:ALL) NOPASSWD: ALL" >> /etc/sudoers

# ssh authorized keys
mkdir -vp /var/ssh/"${LINUX_USER}"
curl -sOJ https://github.com/"${GITHUB_USER}".keys
mv -v "${GITHUB_USER}".keys "${AUTHORIZED_KEYS}"
chown "${LINUX_USER}":"${LINUX_USER}" "${AUTHORIZED_KEYS}"
chmod 644 "${AUTHORIZED_KEYS}"
