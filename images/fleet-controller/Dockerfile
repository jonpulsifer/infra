# apps/fleet-controller for a boot plane that runs as containers (the metal dev env). spore runs
# the same source through apps/fleet-controller/package.nix. The context is the repository root
# (build.json).
FROM docker.io/library/golang:1.27-alpine AS build
WORKDIR /src/apps/fleet-controller
COPY apps/fleet-controller/go.mod apps/fleet-controller/go.sum ./
RUN go mod download
COPY apps/fleet-controller/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/fleet-controller .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/fleet-controller /usr/local/bin/fleet-controller
EXPOSE 8446
ENTRYPOINT ["/usr/local/bin/fleet-controller"]
