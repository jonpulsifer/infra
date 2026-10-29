# apps/talos-attest's server with its policy and EK roots, for a deployment that has no NixOS host
# (the dev environment). The anchors run the Nix package. The build is cgo-free, so the CA signs
# with the software key in ATTEST_CA_KEY. The context is the repository root (build.json).
#
# Mount at runtime (the image is distroless nonroot, so it has none of these):
#   - the CA chain at ATTEST_CA_CHAIN (default /etc/talos-attest/devid-ca-chain.pem) and its key at
#     ATTEST_CA_KEY, or a PKCS#11 module, which this cgo-free build does not support
#   - ATTEST_INVENTORY (default /etc/talos-attest/machines.yaml): clusters/<site>/inventory/machines.yaml
#   - ATTEST_APPROVERS: the comma-separated logins allowed to approve (an environment variable)
#   - a writable ATTEST_STATE_DIR (default /var/lib/talos-attest), such as a volume owned by uid 65532
#   - optionally ATTEST_NETBOX_URL with a token file at ATTEST_NETBOX_TOKEN_FILE
FROM docker.io/library/golang:1.27-alpine AS build
# go.mod replaces pkcs11signer with ../../packages/pkcs11signer, so the tree keeps its layout.
WORKDIR /src/apps/talos-attest
COPY packages/pkcs11signer/ /src/packages/pkcs11signer/
COPY apps/talos-attest/go.mod apps/talos-attest/go.sum ./
RUN go mod download
COPY apps/talos-attest/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/talos-attest .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/talos-attest /usr/local/bin/talos-attest
COPY apps/talos-attest/policy.yaml /etc/talos-attest/policy.yaml
COPY apps/talos-attest/roots/ /etc/talos-attest/roots/
EXPOSE 8080 8081 8082
ENTRYPOINT ["/usr/local/bin/talos-attest"]
