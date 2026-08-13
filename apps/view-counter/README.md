# view-counter

A Go GCP Cloud Function that serves an SVG view-count badge backed by Firestore.

Each request increments a counter document and renders the current count as an
SVG image, so it can be embedded directly in a README or web page with an
`<img>` tag.

## Shape

- `view_counter.go` — the function itself, registered with the Functions
  Framework as the `ViewCounter` HTTP entrypoint.
- `cmd/` — a local entrypoint for running the function outside GCP.
- `view_counter_test.go` — unit tests.
- `spindrift.yaml` — what Spindrift knows about this directory, including the
  build command. The module root is a library, so a zero-config build compiles
  a package archive rather than a program; the declared command names `./cmd`
  so the build produces the binary its start command expects.

## Deploy

Deployment is automated. `.github/workflows/view-counter.yml` deploys to the
`homelab-ng` project on change; there is no manual step.

## Local development

```bash
cd apps/view-counter
go test ./...
go run ./cmd
```

Running locally needs Firestore credentials in the environment, or a Firestore
emulator.
