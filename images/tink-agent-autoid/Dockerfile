# tink-agent for folly's generic HookOS UKI. The UKI's signed command line
# carries no worker_id, so entry.sh sets the agent ID to the MAC of the NIC
# that holds the default route before it runs tink-agent. The UKI pins this
# image by digest, from clusters/folly/talos/netboot.json.
FROM busybox:1.37.0-musl@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092 AS busybox

FROM ghcr.io/tinkerbell/tink-agent:v0.25.0@sha256:b76da8dcc6788f9fc8665554ff870718385a2bb507de23a3339526cf9236c0cd
COPY --from=busybox /bin/busybox /autoid/busybox
COPY entry.sh /autoid/entry.sh
ENTRYPOINT ["/autoid/busybox", "sh", "/autoid/entry.sh"]
