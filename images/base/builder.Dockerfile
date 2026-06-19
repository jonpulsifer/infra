FROM alpine:edge

ENV WORKDIR /workspace
ENV PACKAGES gnupg make wget

RUN apk add --no-cache gnupg make wget && \
    mkdir -p ${WORKDIR}

WORKDIR ${WORKDIR}
