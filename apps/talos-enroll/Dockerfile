FROM golang:1.27-alpine AS builder

WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY *.go index.html ./
RUN CGO_ENABLED=0 go build -o talos-enroll .

# The render must match the Talos root's provider, so talosctl moves with
# talos_version in clusters/folly/talos/talos.tf, checksums included.
FROM alpine:3.24.2 AS talosctl
ARG TARGETARCH=amd64
RUN case "$TARGETARCH" in \
      amd64) sum=c6c9552b0e5f767352c595fa1c0af4f186f697488646872955057d23990a66c4 ;; \
      arm64) sum=5b7119f9cc68c1e6dcd394564208a9ae417c5cc9e8e2585fa173082e53f5e6d7 ;; \
      *) echo "no talosctl checksum for $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && wget -qO /talosctl "https://github.com/siderolabs/talos/releases/download/v1.14.2/talosctl-linux-${TARGETARCH}" \
 && echo "${sum}  /talosctl" | sha256sum -c - \
 && chmod 0755 /talosctl

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=talosctl /talosctl /usr/local/bin/talosctl
COPY --from=builder /app/talos-enroll /usr/local/bin/talos-enroll
EXPOSE 8080 8081
ENTRYPOINT ["/usr/local/bin/talos-enroll"]
