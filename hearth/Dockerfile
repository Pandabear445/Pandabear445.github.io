# Base image: Node 22 on Debian 12 "bookworm", slim variant. The minor version is pinned so a rebuild never
# jumps to a new Node line by surprise; Dependabot (.github/dependabot.yml) proposes updates weekly (keep both
# FROM lines the same). For fully reproducible builds you can pin the exact image too, e.g.
#   FROM node:22.23-bookworm-slim@sha256:<digest>
# (find the digest with: docker buildx imagetools inspect node:22.23-bookworm-slim). Dependabot keeps digests current too.

# Stage 1: install dependencies. better-sqlite3 normally downloads a prebuilt binary, but if that
# download isn't available it compiles from source — which needs Python and a C++ toolchain.
FROM node:26.10-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Stage 2: the small image that actually runs Hearth (no compilers inside).
FROM node:26.10-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
# OS security fixes released after the base image was built, and the SSH client (sftp) that copies
# encrypted backups to linked regions. And no package managers (npm, npx, corepack,
# yarn): Hearth doesn't use them at runtime, and they bring their own dependencies with known vulnerabilities.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
# Program files stay owned by root, so the app (which runs as the unprivileged "node" user, uid 1000)
# can read them but never change them. Only /data is writable for it.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
# Admin → Regions serves this script to new relay servers.
COPY scripts/setup-turn.sh ./scripts/setup-turn.sh
COPY deploy/docker-entrypoint.sh /usr/local/bin/hearth-entrypoint
RUN chmod 0755 /usr/local/bin/hearth-entrypoint \
 && mkdir -p /data && chown node:node /data && chmod 0700 /data
VOLUME /data
EXPOSE 3000

# Healthy = /api/health/live answers (the liveness probe; /api/health/ready also checks the database and disk). Hearth speaks HTTPS (self-signed) unless HTTPS=false, so try both.
HEALTHCHECK --interval=30s --timeout=6s --start-period=40s --retries=3 \
  CMD ["node", "-e", "const p=process.env.PORT||3000,h=require('http'),s=require('https');const t=(m,u)=>new Promise((ok,no)=>{const r=m.get(u+'://127.0.0.1:'+p+'/api/health/live',{rejectUnauthorized:false,timeout:4000},x=>{x.resume();x.statusCode===200?ok():no()});r.on('error',no);r.on('timeout',()=>r.destroy(new Error('timeout')))});const o=String(process.env.HTTPS).toLowerCase()==='false'?[[h,'http'],[s,'https']]:[[s,'https'],[h,'http']];t(...o[0]).catch(()=>t(...o[1])).then(()=>process.exit(0),()=>process.exit(1))"]

# Hearth never runs as root. docker-compose.yml starts it as uid 1000 directly. If the container is started
# as root anyway (plain `docker run`, or a docker-compose.yml from before this change, which the update tool
# keeps as it is), the entrypoint hands /data to uid 1000 — older images wrote it as root — and then
# permanently drops to that user before Hearth starts.
ENTRYPOINT ["/usr/local/bin/hearth-entrypoint"]
CMD ["node", "server/index.js"]
