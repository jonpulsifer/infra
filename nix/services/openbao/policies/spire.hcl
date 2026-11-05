# The SPIRE server's upstream authority: it sends its CA's CSR to the issuing CA.
path "pki/folly/root/sign-intermediate" {
  capabilities = ["update"]
}
path "pki/folly/cert/ca_chain" {
  capabilities = ["read"]
}
