# syntax=docker/dockerfile:1
#
# tally: the FastAPI server and the CLI in one virtualenv, serving the built
# web app. The context is the repo root, because the web is the `tally-web`
# workspace and turbo prune reads the root lockfile. Dockerfile.ocr is this
# image plus the `ocr` extra; keep the two in step.
FROM cgr.dev/chainguard/node:latest-dev@sha256:56fb738564e8423e1d3268cfb300200f306cfb2eecc38867a453713c7aa0ff0e AS bun
# renovate: datasource=npm depName=bun
ARG BUN_VERSION=1.4.3
ENV BUN_INSTALL=/usr/local \
  TURBO_TELEMETRY_DISABLED=1
USER root
RUN apk add --no-cache bash curl unzip \
  && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

FROM bun AS pruner
# renovate: datasource=npm depName=turbo
ARG TURBO_VERSION=2.11.9
WORKDIR /app
COPY . .
RUN bun x "turbo@${TURBO_VERSION}" prune tally-web --docker

FROM bun AS web
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN bun run --cwd apps/tally/web build \
  && test -f apps/tally/web/dist/index.html

# The builder and the runner share one Python image, so the virtualenv's
# interpreter links resolve in both.
FROM python:3.13-slim-trixie@sha256:2d44738ebf4ce5f63b9d9ea871e9c7cfdc0426f7b0c97cac915fd88ded1d86bb AS python
ENV PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1

FROM python AS venv
COPY --from=ghcr.io/astral-sh/uv:0.13.0@sha256:cdc6093146eb3ff6a40107b38f008b789e050e77ad87865e381d9917da55a168 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 \
  UV_LINK_MODE=copy \
  UV_PYTHON_DOWNLOADS=never \
  UV_PYTHON_PREFERENCE=only-system \
  UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app/src
COPY apps/tally/pyproject.toml apps/tally/uv.lock apps/tally/.python-version apps/tally/README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
  uv sync --frozen --no-dev --no-install-project
COPY apps/tally/src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
  uv sync --frozen --no-dev --no-editable

FROM python AS runner
ENV PATH=/app/.venv/bin:$PATH \
  TALLY_WEB_DIST=/app/web
WORKDIR /app
COPY --from=venv /app/.venv /app/.venv
COPY --from=web /app/apps/tally/web/dist /app/web
RUN python -c "import tally.server.app" \
  && tally --help >/dev/null \
  && test -f "$TALLY_WEB_DIST/index.html"
USER 65532:65532
EXPOSE 8080
CMD ["tally", "serve", "--host", "0.0.0.0", "--port", "8080"]
