# Backend image for Google Cloud Run (also runs anywhere Docker does).
# Build:  gcloud run deploy hms-api --source backend --region asia-south1 ...   (see docs/DEPLOY_CLOUD_RUN.md)

# ---- build: install everything, generate the Prisma client, compile TypeScript ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Prisma's query engine needs OpenSSL
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY src ./src

# `prisma generate` reads DATABASE_URL (prisma.config.ts) but never connects: a placeholder is enough at build time.
# It is not carried into the final image.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate && npx tsc -p tsconfig.json

# ---- run ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist
# The Indian drug-brand list the prescribing and pharmacy screens search (read at start-up).
COPY reference ./reference

# Cloud Run supplies PORT (8080); the app reads it.
USER node
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
