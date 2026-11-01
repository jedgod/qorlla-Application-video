# Establish clean production LTS JavaScript runtime engine container environment layers
FROM node:20-alpine

# Set target microservice directory execution isolation space
WORKDIR /usr/src/app

# Pipeline system caching dependencies strategies
COPY package*.json ./
RUN npm ci --omit=dev

# Pull down localized structural service models
# Every module server.js loads (directly or through another): a missing one makes the container exit at start ("Cannot find module").
COPY server.js appointments.js docs.js post-meeting.js notifications.js workplace.js auth.js portal-token.js store.js mailer.js index.html qorlla.html chat.html login.html guest.html guest.js guest-sessions.js lockout.js ./
COPY history.js invitation.js meet-launch.js meeting-limit.js phone-help.js shield-bridge.js support-tickets.js voice.js ./
COPY i18n.js Qorlla-Logo.jpg ./
COPY locales ./locales
COPY assets ./assets
COPY seed ./seed
COPY scripts ./scripts
COPY meet-sync ./meet-sync

# Expose internal core signaling port mapping bounds out to bridge configurations
ENV DATA_DIR=/usr/src/app/data
# Run unprivileged: the app only needs to write its data directory
RUN mkdir -p /usr/src/app/data && chown -R node:node /usr/src/app
USER node
VOLUME ["/usr/src/app/data"]

EXPOSE 5000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5000/api/health || exit 1

# Set entry execution process loops
CMD ["node", "server.js"]