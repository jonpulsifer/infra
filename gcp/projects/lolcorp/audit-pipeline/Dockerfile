FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /audit-pipeline .

FROM gcr.io/distroless/static-debian12
COPY --from=builder /audit-pipeline /audit-pipeline
ENTRYPOINT ["/audit-pipeline"]
