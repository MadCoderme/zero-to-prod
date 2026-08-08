# api/Dockerfile
FROM oven/bun:1-alpine AS base
WORKDIR /app

# Copy package files and install dependencies
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

# Copy source code
COPY . .

EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]