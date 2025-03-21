#!/usr/bin/env bash
set -xeuo pipefail

# this script is for vm based deployments
# aka it installs daemons like datadog and falco

RELEASE=$(lsb_release -sc)
LINUX_USER=${LINUX_USER:-jawn}

add_gpg_keys() {
  curl -fsSL "${1}" | apt-key add -
}

add_apt_repo() {
  add-apt-repository "deb [arch=amd64] ${1}"
}

add_gpg_keys "https://packages.cloud.google.com/apt/doc/apt-key.gpg"
add_apt_repo "http://apt.kubernetes.io kubernetes-focal main"

# docker
add_gpg_keys "https://download.docker.com/linux/ubuntu/gpg"
add_apt_repo "https://download.docker.com/linux/ubuntu ${RELEASE} stable"

# update the things
apt-get -qqy update

# install the things
apt-get -qqy install \
  docker-ce \
  linux-headers-"$(uname -r)" \
  kubelet

usermod -aG docker "${LINUX_USER}"
