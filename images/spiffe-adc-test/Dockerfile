# The client-library tests of the SPIRE path to GCP: three programs that each
# upload one object through Application Default Credentials and nothing else.
# The Google libraries for Go, Python and JavaScript read the ADC document the
# spiffe-adc component provides and run spiffe-adc for the subject token. The
# Job in clusters/folly/apps/spire-test/clients.yaml runs each as a container
# of one pod. The context is this directory (build.json).
FROM docker.io/library/golang:1.27-alpine AS go
WORKDIR /src
COPY go/go.mod go/go.sum ./
RUN go mod download
COPY go/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/go-upload .

FROM docker.io/oven/bun:1.4.4-slim AS runner
# Python with its own venv beside Bun, so one image carries all three.
RUN apt-get update -q \
 && apt-get install -yq --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY python/requirements.txt /test/python/requirements.txt
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -r /test/python/requirements.txt
COPY python/upload.py /test/python/upload.py
WORKDIR /test/bun
COPY bun/package.json bun/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY bun/upload.ts ./
COPY --from=go /out/go-upload /test/go-upload
WORKDIR /test
