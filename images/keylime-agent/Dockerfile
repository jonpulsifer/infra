# Keylime's push-model agent, which the keylime-agent DaemonSet runs on each TPM node of folly
# (clusters/folly/apps/keylime/). It quotes PCRs 0 to 7 and sends the UEFI event log to the
# verifier on forge; it opens no port. Upstream's image is built from master and tagged by
# commit, so this one builds a release tag, pinned by commit, on a Debian 12 toolchain. The
# rust-keylime tag and the base digests move by hand.
FROM gcr.io/distroless/cc-debian12:latest@sha256:e5d81ddde149641e2a9ba55be4545bc125c67de07508b03ba4c22e6eb0ded5aa AS runtime

FROM docker.io/library/rust:1.99.1-bookworm@sha256:c9155318d07341301a78b45ecdd81af2e43b8b297d64e8fd4c5e80d7735607c3 AS build
# tss-esapi's generate-bindings feature needs clang; the openssl and tss2 crates link the
# distribution's libraries, which the runtime stage copies.
RUN apt-get update \
  && apt-get install -y --no-install-recommends clang llvm-dev libclang-dev libtss2-dev libssl-dev pkg-config git \
  && rm -rf /var/lib/apt/lists/*
# v0.2.10
ARG RUST_KEYLIME_COMMIT=6071a9d806ed58469dee9944a500ffdee797072f
WORKDIR /src
RUN git clone --filter=blob:none https://github.com/keylime/rust-keylime.git . \
  && git checkout --detach "$RUST_KEYLIME_COMMIT"
RUN make RELEASE=1 all
# Collect the runtime libraries under one path, so the final COPY is the same on every arch.
RUN set -eu; lib="/usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH)"; mkdir -p /out/lib /out/bin; \
  cp -a "$lib"/libtss2-*.so* "$lib"/libssl.so.3 "$lib"/libcrypto.so.3 "$lib"/libz.so.1* "$lib"/libjson-c.so.5* "$lib"/libcurl*.so.4* /out/lib/ 2>/dev/null || true; \
  cp target/release/keylime_push_model_agent target/release/keylime_agent /out/bin/; \
  mkdir -p /out/var/lib/keylime /out/etc; \
  ldd /out/bin/keylime_push_model_agent
# The agent's default run_as is keylime:tss, which it checks before it drops privileges; the
# runtime image has neither, so both are appended to its account files.
COPY --from=runtime /etc/passwd /etc/group /out/etc/
RUN printf 'keylime:x:1900:1900:keylime:/var/lib/keylime:/sbin/nologin\n' >> /out/etc/passwd \
  && printf 'tss:x:1900:\n' >> /out/etc/group

FROM runtime
COPY --from=build /out/etc/passwd /out/etc/group /etc/
COPY --from=build /out/lib/ /usr/lib/keylime/
COPY --from=build /out/bin/ /bin/
COPY --from=build /src/keylime-agent.conf /etc/keylime/agent.conf
# The agent refuses to start without keylime_dir; the DaemonSet mounts the node's over it.
COPY --from=build /out/var/lib/keylime /var/lib/keylime
ENV LD_LIBRARY_PATH=/usr/lib/keylime
ENV RUST_LOG=keylime_push_model_agent=info
ENTRYPOINT ["/bin/keylime_push_model_agent"]
