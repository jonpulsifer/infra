FROM gcr.io/trusted-builds/ubuntu-2204-base

ENV WORKDIR /workspace
ENV PACKAGES gnupg2 make wget

RUN apt-get -qqy update && apt-get -qqy upgrade && \
    apt-get -qy install ${PACKAGES} && \
    mkdir -p ${WORKDIR}

WORKDIR ${WORKDIR}
