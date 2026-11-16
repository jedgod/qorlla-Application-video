FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
USER node
EXPOSE 8080
CMD ["node","src/server.mjs"]
