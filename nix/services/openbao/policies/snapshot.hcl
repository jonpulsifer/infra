# openbao-snapshot.service: a Raft snapshot each night.
path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}
