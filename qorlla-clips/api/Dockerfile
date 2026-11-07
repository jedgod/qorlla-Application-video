# Qorlla Clips API. Build from this folder:  docker build -t clips-api qorlla-clips/api
# The Prisma CLI stays in the image on purpose: migrations run from it (`npm run db:migrate`) before a new version starts serving.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY scripts ./scripts
# the production client is generated for PostgreSQL; the URL here is a placeholder used only to pick the provider
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" node scripts/generate.mjs

FROM node:22-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# prisma/ is writable by the runtime user: the migration command writes a provider-specific copy of the schema beside the migrations
COPY --from=deps --chown=node:node /app/prisma ./prisma
COPY --from=deps /app/scripts ./scripts
COPY package.json ./
COPY src ./src
USER node
EXPOSE 5400
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:5400/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
