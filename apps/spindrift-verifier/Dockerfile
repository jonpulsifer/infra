FROM golang:1.26-alpine AS builder
WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /spindrift-verifier .

FROM scratch
COPY --from=builder /spindrift-verifier /spindrift-verifier
ENTRYPOINT ["/spindrift-verifier"]
