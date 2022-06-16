FROM northamerica-northeast1-docker.pkg.dev/trusted-builds/i/base

ENV WORKDIR /workspace
ENV PACKAGES gnupg2 make wget

RUN apt-get -qqy update && apt-get -qqy upgrade && \
    apt-get -qy install ${PACKAGES} && \
    mkdir -p ${WORKDIR}

WORKDIR ${WORKDIR}
