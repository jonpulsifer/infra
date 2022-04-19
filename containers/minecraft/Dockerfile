FROM adoptopenjdk/openjdk11

ARG MINECRAFT_VERSION=${MINECRAFT_VERSION:-1.15.1}
ARG MINECRAFT_SERVER_CHECKSUM=${CHECKSUM:-4d1826eebac84847c71a77f9349cc22afd0cf0a1}
ARG NAME=${NAME:-minecraft}
ARG APPDIR=${APPDIR:-/var/minecraft}
ARG UID=${UID:-1000}
ARG GID=${GID:-1000}

RUN addgroup --gid ${GID} ${NAME} && \
    adduser --system \
            --uid ${UID} \
            --gid ${GID} \
            --quiet \
            --no-create-home \
            --disabled-password ${NAME}

RUN mkdir -p ${APPDIR} && chmod 700 ${APPDIR}

ADD https://launcher.mojang.com/v1/objects/${MINECRAFT_SERVER_CHECKSUM}/server.jar /usr/share/java/minecraft.jar
RUN chmod 644 /usr/share/java/minecraft.jar && chown -R ${UID}:${GID} ${APPDIR}

WORKDIR ${APPDIR}
USER ${UID}:${GID}
RUN echo "eula=true" > eula.txt

ENTRYPOINT ["java", "-jar", "/usr/share/java/minecraft.jar", "nogui"]
