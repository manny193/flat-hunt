# syntax=docker/dockerfile:1
# Flat Radar - local dev and self-host fallback (production runs on Cloudflare Workers).
# Runs src/node-server.js (node:http + node:sqlite). Zero npm dependencies, so no npm install step.
#
#   docker build -t flat-radar .
#   docker run --init -p 127.0.0.1:8787:8787 -v flat-radar-data:/data \
#     -e APP_PASSWORD=... -e SESSION_SECRET=... flat-radar
#
# node:sqlite needs Node >= 22.13 without a flag; the 22 slim tag tracks the latest 22.x.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/flat-radar.db

WORKDIR /app

# App files stay owned by root and read-only for the runtime user.
COPY package.json ./
COPY src ./src
COPY web ./web
COPY migrations ./migrations

# SQLite lives on a volume owned by the unprivileged built-in "node" user (uid 1000).
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8787

# No curl in slim images; use Node's built-in fetch. /healthz must not require login.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

STOPSIGNAL SIGTERM
CMD ["node", "--disable-warning=ExperimentalWarning", "src/node-server.js"]
