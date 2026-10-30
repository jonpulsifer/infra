# tink-agent for folly's generic HookOS UKI. The UKI's signed command line
# carries no worker_id, so entry.sh sets the agent ID to the MAC of the NIC
# that holds the default route, posts the machine's facts to fleet-controller's
# intake with ./intake, and runs tink-agent. The tink-agent image holds only
# the binary and a CA bundle, so busybox runs entry.sh and the intake client is
# a static binary. The UKI pins this image by digest, from
# clusters/folly/talos/netboot.json.
FROM busybox:1.38.0-musl@sha256:80e38f9a1b39188b8bdb28879178edb322a4402b081a9aedda1924609decd6f6 AS busybox

FROM docker.io/library/golang:1.27-alpine AS intake
WORKDIR /src
COPY intake/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/fleet-intake .

FROM ghcr.io/tinkerbell/tink-agent:v0.25.0@sha256:b76da8dcc6788f9fc8665554ff870718385a2bb507de23a3339526cf9236c0cd
COPY --from=busybox /bin/busybox /autoid/busybox
COPY --from=intake /out/fleet-intake /autoid/fleet-intake
COPY entry.sh /autoid/entry.sh
ENTRYPOINT ["/autoid/busybox", "sh", "/autoid/entry.sh"]
