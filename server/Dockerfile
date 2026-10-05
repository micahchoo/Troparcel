# Built from the repository root (docker-compose.yml sets the context):
# the server shares src/purge.js with the plugin.
FROM node:24-alpine

WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY server/index.js ./server/
COPY src/purge.js src/connection-string.js ./src/

RUN mkdir -p /app/data && chown node:node /app/data

USER node

ENV PORT=2468
ENV HOST=0.0.0.0
ENV PERSISTENCE_DIR=/app/data

EXPOSE 2468

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:2468/health || exit 1

CMD ["node", "server/index.js"]
