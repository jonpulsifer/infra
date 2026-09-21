FROM golang:1.27-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o flameboss .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /app/flameboss /usr/local/bin/flameboss
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/flameboss"]
