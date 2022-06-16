FROM alpine:edge
# RUN apk add --no-cache apko
ARG APKO_VERSION=0.4.0
ADD https://github.com/chainguard-dev/apko/releases/download/v${APKO_VERSION}/apko_${APKO_VERSION}_linux_amd64.tar.gz /tmp/apko.tar.gz
RUN tar -xzf /tmp/apko.tar.gz -C /tmp && mv /tmp/apko_${APKO_VERSION}_linux_amd64/apko /usr/bin/apko && rm -rf /tmp/*
ENTRYPOINT [ "/usr/bin/apko" ]
