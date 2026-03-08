# ── Stage 1: Install all deps (including devDeps for build) ──────────────────
FROM node:20-alpine AS build-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 2: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=build-deps /app/node_modules ./node_modules
COPY . .
# Generate Prisma client from schema
RUN npx prisma generate
# Build the React Router app
RUN npm run build

# ── Stage 3: Production deps only ─────────────────────────────────────────────
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 4: Final image ──────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# Copy production node_modules
COPY --from=prod-deps /app/node_modules ./node_modules

# Copy generated Prisma client (built in stage 2)
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma

# Copy Prisma CLI for migrations (needed at runtime)
COPY --from=build-deps /app/node_modules/prisma ./node_modules/prisma

# Copy build output
COPY --from=build /app/build ./build

# Copy prisma schema + migrations (needed for migrate deploy)
COPY prisma ./prisma
COPY prisma.config.ts ./

# Copy package.json for npm start
COPY package.json ./

EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000

# Sync schema to DB then start the app
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && npm run start"]
