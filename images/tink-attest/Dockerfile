# The attest action that clusters/folly/tinkerbell/template-attest.yaml runs in HookOS:
# apps/talos-attest's tink-attest client, and tpm2-tools to inspect the TPM from the console. The
# context is the repository root (build.json). The containers workflow's delivery pins the image by
# digest in the Template.
FROM docker.io/library/golang:1.27-alpine AS build
WORKDIR /src
COPY apps/talos-attest/go.mod apps/talos-attest/go.sum ./
RUN go mod download
COPY apps/talos-attest/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/tink-attest ./cmd/tink-attest

FROM docker.io/library/alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --no-cache tpm2-tools tpm2-tss-tcti-device
COPY --from=build /out/tink-attest /usr/local/bin/tink-attest
CMD ["/usr/local/bin/tink-attest"]
