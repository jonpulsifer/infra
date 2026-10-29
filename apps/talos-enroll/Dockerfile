FROM golang:1.27-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY *.go index.html ./
RUN CGO_ENABLED=0 go build -o talos-enroll .

# The render must match the Talos root's provider, so talosctl moves with
# talos_version in clusters/folly/talos/talos.tf, checksums included.
FROM alpine:3.24.3 AS talosctl
ARG TARGETARCH=amd64
RUN case "$TARGETARCH" in \
      amd64) sum=0a69e3f9b682c5cd844b78dae305f6056ceb86c5fcc6913dcea78c527ed97cee ;; \
      arm64) sum=a4430fad81b8dc54d99e0dc7b7ea5d0741b93645bc612cbeadf12855c4ec60bb ;; \
      *) echo "no talosctl checksum for $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && wget -qO /talosctl "https://github.com/siderolabs/talos/releases/download/v1.14.4/talosctl-linux-${TARGETARCH}" \
 && echo "${sum}  /talosctl" | sha256sum -c - \
 && chmod 0755 /talosctl

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=talosctl /talosctl /usr/local/bin/talosctl
COPY --from=builder /app/talos-enroll /usr/local/bin/talos-enroll
EXPOSE 8080 8081
ENTRYPOINT ["/usr/local/bin/talos-enroll"]
