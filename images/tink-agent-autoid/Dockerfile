# tink-agent for folly's generic HookOS UKI. The UKI's signed command line
# carries no worker_id, so entry.sh sets the agent ID to the MAC of the NIC
# that holds the default route, attests the machine against fleetd with
# tink-attest (apps/fleetd/cmd/tink-attest), and runs tink-agent. The
# tink-agent image holds only the binary and a CA bundle, so busybox runs
# entry.sh, sets the clock and mounts securityfs, and tink-attest is a static
# binary. The UKI pins this image by digest, from
# clusters/folly/talos/netboot.json. The context is the repository root
# (build.json).
FROM busybox:1.38.0-musl@sha256:80e38f9a1b39188b8bdb28879178edb322a4402b081a9aedda1924609decd6f6 AS busybox

FROM docker.io/library/golang:1.27-alpine AS attest
# go.mod replaces pkcs11signer with ../../packages/pkcs11signer, so the tree keeps its layout.
WORKDIR /src/apps/fleetd
COPY packages/pkcs11signer/ /src/packages/pkcs11signer/
COPY apps/fleetd/go.mod apps/fleetd/go.sum ./
RUN go mod download
COPY apps/fleetd/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/tink-attest ./cmd/tink-attest

FROM ghcr.io/tinkerbell/tink-agent:v0.25.0@sha256:b76da8dcc6788f9fc8665554ff870718385a2bb507de23a3339526cf9236c0cd
COPY --from=busybox /bin/busybox /autoid/busybox
COPY --from=attest /out/tink-attest /autoid/tink-attest
COPY images/tink-agent-autoid/entry.sh /autoid/entry.sh
ENTRYPOINT ["/autoid/busybox", "sh", "/autoid/entry.sh"]
