module github.com/jonpulsifer/infra/apps/fleetd

go 1.27.0

require (
	github.com/google/go-attestation v0.6.4
	github.com/google/go-tpm v0.9.8
	github.com/google/go-tpm-tools v0.4.11
	github.com/jonpulsifer/infra/packages/pkcs11signer v0.0.0
	gopkg.in/yaml.v3 v3.0.1
)

require (
	github.com/GoogleCloudPlatform/confidential-space/server v0.0.0-20260915221818-a6c0685fb9fc // indirect
	github.com/eclipse-keypont/crypto11 v1.6.8 // indirect
	github.com/google/go-configfs-tsm v0.3.3 // indirect
	github.com/google/go-sev-guest v0.14.0 // indirect
	github.com/google/go-tdx-guest v0.3.2-0.20250814004405-ffb0869e6f4d // indirect
	github.com/google/logger v1.1.1 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/miekg/pkcs11 v1.1.2 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/thales-e-security/pool v0.0.2 // indirect
	go.uber.org/multierr v1.11.0 // indirect
	golang.org/x/crypto v0.52.0 // indirect
	golang.org/x/sys v0.45.0 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
)

replace github.com/jonpulsifer/infra/packages/pkcs11signer => ../../packages/pkcs11signer
