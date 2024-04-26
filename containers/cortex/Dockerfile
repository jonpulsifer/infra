FROM ubuntu:noble
LABEL maintainer=jonathan@pulsifer.ca \
      ca.pulsifer.os=linux \
      ca.pulsifer.distro=ubuntu \
      ca.pulsifer.codename=focal \
      ca.pulsifer.release=20.04
ARG COMPONENT=${COMPONENT:-cortex}
RUN apt-get -qqy update && apt-get -qqy install gnupg2 curl openjdk-14-jre-headless
RUN curl -sSL https://raw.githubusercontent.com/TheHive-Project/TheHive/master/PGP-PUBLIC-KEY | apt-key add - && \
    echo 'deb https://deb.thehive-project.org release main' > /etc/apt/sources.list.d/thehive.list && \
    apt-get -qqy update && apt-get -qqy install ${COMPONENT}
COPY application.conf /etc/cortex/application.conf
# USER 999:999
EXPOSE 9001
ENTRYPOINT [ "/opt/cortex/bin/cortex" ]
CMD [ "-Dconfig.file=/etc/cortex/application.conf", "-Dlogger.file=/etc/cortex/logback.xml", "-Dpidfile.path=/dev/null" ]
