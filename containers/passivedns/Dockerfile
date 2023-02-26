FROM alpine:3.17
LABEL maintainer "Jonathan Pulsifer <jonathan@pulsifer.ca>"

RUN addgroup -S passivedns && adduser -S -g passivedns passivedns  
RUN apk add --no-cache -t .build-deps build-base automake autoconf git \
  && apk add --no-cache ldns-dev libpcap-dev \
  && git clone --single-branch --depth 1 https://github.com/gamelinux/passivedns /tmp/src \
  && cd /tmp/src \
  && autoreconf --install \
  && ./configure \
  && make \
  && make install \
  && /bin/rm -r /tmp/src \
  && apk del .build-deps \
  && mkdir /var/log/passivedns \
  && chown passivedns:passivedns /var/log/passivedns \
  && chmod +s /usr/local/bin/passivedns

USER passivedns
ENTRYPOINT ["/usr/local/bin/passivedns"]
CMD ["-l", "-", "-L", "-", "-C", "0", "-P", "0", "-X", "46CDNOLFIPRSTMndHfsxoryetaz"]
