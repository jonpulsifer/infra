FROM golang:1.27-alpine AS builder

WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -o rackstat .

FROM scratch
COPY --from=builder /app/rackstat /rackstat
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/rackstat"]
