FROM node:22-alpine AS build
WORKDIR /opt/qorlla/qorlla-phone-join
COPY qorlla-phone-join/package*.json ./
RUN npm ci
COPY qorlla-phone-join/tsconfig.json ./
COPY qorlla-phone-join/src ./src
COPY qorlla-phone-join/test ./test
RUN npm run build && npm prune --omit=dev
FROM node:22-alpine
WORKDIR /opt/qorlla/qorlla-phone-join
COPY --from=build --chown=node:node /opt/qorlla/qorlla-phone-join/node_modules ./node_modules
COPY --from=build --chown=node:node /opt/qorlla/qorlla-phone-join/dist/src ./dist/src
COPY qorlla-phone-join/package.json ./
COPY qorlla-phone-join/scripts/run-gateway.mjs ./scripts/run-gateway.mjs
COPY qorlla-meet-video/server/telephony/workload-transport.mjs /opt/qorlla/qorlla-meet-video/server/telephony/workload-transport.mjs
USER node
CMD ["node", "scripts/run-gateway.mjs"]
