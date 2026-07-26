#!/bin/sh
set -eu

token_file=${KUBECONFIG_TOKEN_FILE:-/var/run/secrets/kubernetes.io/serviceaccount/token}
kubeconfig=${KUBECONFIG_OUTPUT:-/home/atlantis/.kube/config}
kube_dir=$(dirname "${kubeconfig}")

topology_value() {
  key=$1
  file=$2
  sed -n "s/^[[:space:]]*\"${key}\": \"\\([^\"]*\\)\",*$/\\1/p" "${file}"
}

cluster_entry() {
  cluster=$1
  topology="${DIR}/clusters/${cluster}/config/cluster-topology.json"
  ca="${DIR}/terraform/pki/certs/${cluster}-ca.pem"
  host=$(topology_value API_SERVER_HOSTNAME "${topology}")
  port=$(topology_value API_SERVER_PORT "${topology}")

  test -n "${host}"
  test -n "${port}"
  test -r "${ca}"

  cat <<EOF
- cluster:
    certificate-authority-data: $(base64 <"${ca}" | tr -d '\n')
    server: https://${host}:${port}
  name: ${cluster}
EOF
}

test -n "${DIR:-}"
test -r "${token_file}"
mkdir -p "${kube_dir}"
temporary=$(mktemp "${kubeconfig}.XXXXXX")
trap 'rm -f "${temporary}"' EXIT

{
  cat <<EOF
apiVersion: v1
kind: Config
clusters:
EOF
  cluster_entry folly
  cluster_entry offsite
  cat <<EOF
contexts:
- context:
    cluster: folly
    user: atlantis
  name: folly
- context:
    cluster: offsite
    user: atlantis
  name: offsite
current-context: offsite
users:
- name: atlantis
  user:
    tokenFile: ${token_file}
EOF
} >"${temporary}"

chmod 0600 "${temporary}"
mv "${temporary}" "${kubeconfig}"
trap - EXIT
