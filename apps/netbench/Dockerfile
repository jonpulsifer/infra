FROM golang:1.26-alpine AS builder

WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY main.go index.html ./
RUN CGO_ENABLED=0 go build -o netbench .

FROM alpine:latest
# iperf3 is the workhorse; netbench shells out to it.
RUN apk add --no-cache iperf3
COPY --from=builder /app/netbench /usr/local/bin/netbench
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/netbench"]
