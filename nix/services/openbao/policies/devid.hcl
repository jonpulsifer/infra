# The owner's one-time signing of the DevID CA on spore's YubiKey under the issuing CA.
path "pki/folly/root/sign-intermediate" {
  capabilities = ["update"]
}
path "pki/folly/cert/ca_chain" {
  capabilities = ["read"]
}
