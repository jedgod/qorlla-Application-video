FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY sql ./sql
ENV NODE_ENV=production PORT=5500
RUN chown -R node:node /app
USER node
EXPOSE 5500
HEALTHCHECK --interval=15s --timeout=4s --retries=5 CMD wget -qO- http://127.0.0.1:5500/api/v1/health || exit 1
CMD ["node", "server/index.mjs"]
