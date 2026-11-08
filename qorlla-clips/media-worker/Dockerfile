# Qorlla Clips media worker. FFmpeg and a font come from the distribution's own packages (no binary is downloaded from anywhere else).
FROM node:22-alpine
RUN apk add --no-cache ffmpeg font-dejavu
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    RENDER_FONT=/usr/share/fonts/dejavu/DejaVuSans.ttf
USER node
CMD ["node", "src/worker.mjs"]
