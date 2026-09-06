FROM golang:1.27-alpine AS builder

WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY main.go index.html ./
RUN CGO_ENABLED=0 go build -o smiirl .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /app/smiirl /usr/local/bin/smiirl
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/smiirl"]
