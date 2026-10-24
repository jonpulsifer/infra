# The SPIRE agent with the TPM node attestor from boxboat/spire-tpm-plugin,
# rebuilt against the plugin SDK of the SPIRE release below. That SDK adds a
# Validate RPC, which the plugin answers as unimplemented.
FROM golang:1.27-alpine AS plugin
ARG PLUGIN_COMMIT=dc65abf6a51d08c67f0f2b40901344c8a1c7d714
ARG PLUGIN_SDK=v1.15.3
RUN apk add --no-cache git
WORKDIR /src
RUN git init -q . \
 && git fetch -q --depth 1 https://github.com/boxboat/spire-tpm-plugin "$PLUGIN_COMMIT" \
 && git checkout -q FETCH_HEAD
RUN sed -i 's/configv1.UnsafeConfigServer/configv1.UnimplementedConfigServer/' pkg/agent/agent.go pkg/server/server.go \
 && go get "github.com/spiffe/spire-plugin-sdk@$PLUGIN_SDK" \
 && go mod tidy
RUN for b in tpm_attestor_agent get_tpm_pubhash; do \
      CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o "/out/$b" "./cmd/$b"; \
    done

FROM ghcr.io/spiffe/spire-agent:1.15.5@sha256:3652c732b0f0d36f4dd78394230a1b1cd0ddcc29548a46c67a996b1a78c14481
COPY --from=plugin /out/ /opt/spire/plugins/
