FROM gcr.io/trusted-builds/ubuntu-2404-base

ENV PACKAGES git gpg make wget

RUN apt-get -qqy update && apt-get -qqy upgrade && \
    apt-get -qqy install ${PACKAGES}

# google cloud build
WORKDIR /workspace
