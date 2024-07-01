#!/usr/bin/env bash
set -xeuo pipefail

export DEBIAN_FRONTEND=noninteractive
LANG=${LANG:-en_US.UTF-8}

# root test
(($(id -u) == 0)) || { echo 'please run as root'; exit 1; }

apt-get -qqy clean
apt-get -qqy autoremove --purge
apt-get -qqy update
apt-get -qqy upgrade

# locales
apt-get -qqy install \
  apt-transport-https \
  ca-certificates \
  curl \
  language-pack-en-base \
  lsb-release \
  software-properties-common

locale-gen "${LANG}"
update-locale "${LANG}"
