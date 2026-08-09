FROM oven/bun:1
WORKDIR /app
COPY package.json ./
COPY . .
RUN bun install && bun run --cwd apps/web build
