FROM eclipse-temurin:21.0.7_6-jdk

ARG MINECRAFT_VERSION=${MINECRAFT_VERSION:-1.18.2}
ARG MINECRAFT_SERVER_CHECKSUM=${CHECKSUM:-c8f83c5655308435b3dcf03c06d9fe8740a77469}
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
