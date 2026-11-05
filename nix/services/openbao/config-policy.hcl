# The policy of the token that openbao-config.service runs with: the PKI mounts, the policies
# and the auth methods that git declares, and its own renewal. scripts/openbao-config-token.sh
# writes it with the root token once; the service keeps it current afterwards.
path "sys/mounts" {
  capabilities = ["read"]
}
path "sys/mounts/pki/*" {
  capabilities = ["create", "read", "update"]
}
path "pki/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
path "sys/policies/acl" {
  capabilities = ["list"]
}
path "sys/policies/acl/*" {
  capabilities = ["create", "read", "update"]
}
path "sys/auth" {
  capabilities = ["read"]
}
path "sys/auth/*" {
  capabilities = ["create", "read", "update", "sudo"]
}
path "auth/approle/*" {
  capabilities = ["create", "read", "update", "list"]
}
path "auth/kubernetes/*" {
  capabilities = ["create", "read", "update", "list"]
}
path "auth/token/renew-self" {
  capabilities = ["update"]
}
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
