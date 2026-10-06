FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN go build -o /ddns .

FROM gcr.io/distroless/static
COPY --from=build /ddns /ddns
ENTRYPOINT ["/ddns"]
