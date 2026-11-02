FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY sql ./sql
USER node
EXPOSE 4600
CMD ["node","src/server.mjs"]
