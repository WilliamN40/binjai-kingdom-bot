# syntax=docker/dockerfile:1

# ── Build: compile TypeScript, then drop dev dependencies ────────────
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── Runtime ──────────────────────────────────────────────────────────
FROM node:24-bookworm-slim
# curl: image downloads in private chat. git + ripgrep: used by Claude Code tools.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOME=/home/node \
    DATA_DIR=/data \
    WORKSPACE_DIR=/data/workspace

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The bot never runs as root. /data holds transcripts and state (mounted from the host).
RUN mkdir -p /data /home/node/.claude && chown -R node:node /data /home/node/.claude
USER node

CMD ["node", "dist/index.js"]
