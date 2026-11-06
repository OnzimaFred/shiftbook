# Shiftbook API and app. Build from the project root:  docker compose build
FROM node:22.12.0-alpine AS deps
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Build the phone app (bundled with the shared roster rules and the QR code checks)
FROM node:22.12.0-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/build.js ./
COPY web/src ./src
COPY web/static ./static
COPY shared /app/shared
COPY api/src/clockcore.ts /app/api/src/clockcore.ts
RUN node build.js

FROM node:22.12.0-alpine
ENV NODE_ENV=production PORT=8080 PHOTO_DIR=/data/photos
WORKDIR /app
COPY --from=deps /app/api/node_modules ./api/node_modules
COPY api/package.json ./api/
COPY api/src ./api/src
COPY --from=web /app/api/public ./api/public
COPY db ./db
COPY shared ./shared
RUN mkdir -p /data/photos && chown -R node:node /data/photos
USER node
WORKDIR /app/api
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
# Apply any new database migrations, then start the server.
CMD ["sh", "-c", "node --experimental-strip-types --no-warnings src/migrate.ts && exec node --experimental-strip-types --no-warnings src/server.ts"]
