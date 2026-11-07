# Qorlla Clips web (Next.js standalone). Build from this folder:  docker build -t clips-web qorlla-clips/web
# /api/* is forwarded to CLIPS_API_URL; that address is fixed at BUILD time (Next.js bakes rewrites into the build).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG CLIPS_API_URL=http://api:5400
ARG CLIPS_BASE_PATH=
ENV CLIPS_API_URL=$CLIPS_API_URL CLIPS_BASE_PATH=$CLIPS_BASE_PATH NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3400 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER node
EXPOSE 3400
HEALTHCHECK --interval=15s --timeout=4s --start-period=15s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:3400/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
