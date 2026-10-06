# Stage 1: install dependencies. better-sqlite3 normally downloads a prebuilt binary, but if that
# download isn't available it compiles from source — which needs Python and a C++ toolchain.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Stage 2: the small image that actually runs Hearth (no compilers inside).
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
