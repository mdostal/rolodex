# rolodex service mode (`rolodex serve`, contacts-memory cm-04).
#
#   podman build -t rolodex .
#   podman run --rm -p 4180:4180 --read-only --tmpfs /tmp \
#     -v rolodex-data:/data \
#     -v ./secrets:/pantheon-secrets/rolodex:ro \
#     rolodex
#
# Plain single-arch Dockerfile: builds with `podman build` (no buildx).
# The service token is mounted as a file (ROLODEX_SERVICE_TOKEN_FILE,
# default /pantheon-secrets/rolodex/service-token), never passed as env.
# See docs/ARCHITECTURE.md "Service mode".

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the devDependencies include electron, whose postinstall
# downloads a desktop binary this image never uses; tsc needs no scripts.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-slim
ENV NODE_ENV=production \
    ROLODEX_DB=/data/rolodex.db \
    ROLODEX_SECRETS_DIR=/pantheon-secrets/rolodex \
    ROLODEX_SERVICE_TOKEN_FILE=/pantheon-secrets/rolodex/service-token \
    PORT=4180
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Fail the build if this Node's bundled SQLite lacks FTS5 (search needs it).
RUN node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(x)')" \
 && mkdir -p /data /pantheon-secrets/rolodex \
 && chown node:node /data
# Non-root. The image writes only to /data (the volume); the root
# filesystem can be mounted read-only (give SQLite a tmpfs /tmp).
USER node
VOLUME ["/data"]
EXPOSE 4180
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4180)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/cli/index.js", "serve"]
