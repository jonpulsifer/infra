# spiffe-adc, the executable an ADC `external_account` document runs for a
# subject token (./main.go). A pod gets it as an image volume, so the image is
# the one static binary and nothing else; the library execs it directly.
FROM docker.io/library/golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/spiffe-adc .

FROM scratch
COPY --from=build /out/spiffe-adc /spiffe-adc
ENTRYPOINT ["/spiffe-adc"]
