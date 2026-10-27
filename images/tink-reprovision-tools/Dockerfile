# The tools the reprovision Template runs in HookOS, baked in so a node on the boot VLAN needs no
# package mirror: sgdisk and util-linux wipe the disk, efibootmgr sets BootNext, and docker-cli
# starts the detached reboot container. clusters/folly/tinkerbell/template.yaml pins this image by
# digest, which the containers workflow's delivery rewrites.
FROM docker.io/library/alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --no-cache sgdisk util-linux efibootmgr docker-cli
