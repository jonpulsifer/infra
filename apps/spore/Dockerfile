# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS base
ARG BUN_VERSION=1.3.10
RUN apk add --no-cache bash curl libc6-compat \
  && curl -fsSL https://bun.sh/install | bash -s -- --version "${BUN_VERSION}"
ENV PATH="/root/.bun/bin:${PATH}" \
  NEXT_TELEMETRY_DISABLED=1 \
  TURBO_TELEMETRY_DISABLED=1

FROM base AS pruner
WORKDIR /app
COPY . .
RUN bunx turbo@2.10.3 prune spore --docker

FROM base AS builder
ENV STANDALONE=1
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN apk add --no-cache g++ make python3 \
  && bun install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN bun run build --filter=spore

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runner
RUN apk add --no-cache dnsmasq supervisor
ENV DATABASE_URL=file:/app/data/spore.db \
  HOSTNAME=0.0.0.0 \
  NODE_ENV=production \
  PORT=3000
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 --ingroup nodejs nextjs \
  && mkdir -p /var/lib/tftpboot /app/data /var/log/supervisor \
  && chown -R nextjs:nodejs /app /var/lib/tftpboot /var/log/supervisor
COPY --chown=nextjs:nodejs apps/spore/docker/dnsmasq.conf /etc/dnsmasq.conf
COPY --chown=nextjs:nodejs apps/spore/docker/supervisord.conf /etc/supervisord.conf
COPY --from=builder --chown=nextjs:nodejs /app/apps/spore/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/spore/.next/static ./apps/spore/.next/static
EXPOSE 3000 69/udp
CMD ["supervisord", "-c", "/etc/supervisord.conf"]
