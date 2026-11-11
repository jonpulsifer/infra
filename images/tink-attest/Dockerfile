# apps/fleetd's tink-attest client, which the tpm-reattest DaemonSet runs on each TPM node to renew
# the LDevID and send the daily check (clusters/folly/apps/spire/tpm-reattest.yaml), and tpm2-tools
# to inspect the TPM. The context is the repository root (build.json). The containers workflow's
# delivery pins the image by digest in the DaemonSet. HookOS runs the same client from the agent
# image (images/tink-agent-autoid).
FROM docker.io/library/golang:1.27-alpine AS build
# go.mod replaces pkcs11signer with ../../packages/pkcs11signer, so the tree keeps its layout.
WORKDIR /src/apps/fleetd
COPY packages/pkcs11signer/ /src/packages/pkcs11signer/
COPY apps/fleetd/go.mod apps/fleetd/go.sum ./
RUN go mod download
COPY apps/fleetd/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/tink-attest ./cmd/tink-attest

FROM docker.io/library/alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN apk add --no-cache tpm2-tools tpm2-tss-tcti-device
COPY --from=build /out/tink-attest /usr/local/bin/tink-attest
CMD ["/usr/local/bin/tink-attest"]
