# Keylime's verifier, registrar and tenant, which forge runs as OCI containers under systemd
# (nix/services/keylime.nix). One image carries all three; the unit names the command. Fedora
# packages Keylime for aarch64 and x86_64, nixpkgs does not, and upstream's quay.io images are
# amd64 only, so this image exists for the Pi. The base is the multi-arch index digest, which
# the owner moves by hand.
FROM quay.io/fedora/fedora:43@sha256:1a1f5d76c6095ed6d6bf195b69138e38b8d8436a05138d09d5f19374e55cc608
# A fixed uid, so the host's bind mount of /var/lib/keylime can be owned ahead of the package's
# dynamic account. keylime-base keeps an existing user; the base already has the tss group.
RUN useradd --system --uid 1900 --gid tss --home-dir /var/lib/keylime --shell /sbin/nologin keylime \
  && dnf -y install keylime-verifier keylime-registrar keylime-tenant tpm2-tools python3-psycopg2 \
  && dnf clean all \
  && rm -rf /var/cache/dnf /var/cache/libdnf5
USER keylime
WORKDIR /var/lib/keylime
