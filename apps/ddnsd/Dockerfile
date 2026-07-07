FROM golang:1.26-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN go vet ./... && go test ./...
RUN CGO_ENABLED=0 go build -o ddnsd main.go

FROM alpine:latest
COPY --from=builder /app/ddnsd /usr/local/bin/ddnsd
CMD ["/usr/local/bin/ddnsd"]
