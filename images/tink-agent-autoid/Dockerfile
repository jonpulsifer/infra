# tink-agent for folly's generic HookOS UKI. The UKI's signed command line
# carries no worker_id, so entry.sh sets the agent ID to the MAC of the NIC
# that holds the default route before it runs tink-agent. The UKI pins this
# image by digest, from clusters/folly/talos/netboot.json.
FROM busybox:1.38.0-musl@sha256:119bdf19f884fb540a02b02534632c16525266957572e85996e377d5d41d3168 AS busybox

FROM ghcr.io/tinkerbell/tink-agent:v0.25.0@sha256:b76da8dcc6788f9fc8665554ff870718385a2bb507de23a3339526cf9236c0cd
COPY --from=busybox /bin/busybox /autoid/busybox
COPY entry.sh /autoid/entry.sh
ENTRYPOINT ["/autoid/busybox", "sh", "/autoid/entry.sh"]
