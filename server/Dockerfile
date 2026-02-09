FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js ./

RUN mkdir -p /app/data && chown node:node /app/data

# Run as non-root user (#18)
USER node

ENV PORT=2468
ENV HOST=0.0.0.0
ENV PERSISTENCE_DIR=/app/data

EXPOSE 2468

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:2468/health || exit 1

CMD ["node", "index.js"]
