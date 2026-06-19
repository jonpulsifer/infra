FROM alpine
ENV PACK_VERSION=${PACK_VERSION:-v0.6.0}
RUN wget -qO - https://github.com/buildpack/pack/releases/download/${PACK_VERSION}/pack-${PACK_VERSION}-linux.tgz | tar xzf -

FROM scratch
COPY --from=0 /pack /pack
USER 65534:65534
ENTRYPOINT ["/pack"]
