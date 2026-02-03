# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# Stage 2: Runtime (schlankes Image)
FROM node:20-alpine

WORKDIR /app

# Kopiere nur das Gebaute + node_modules + package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Starte die App
EXPOSE 8080
CMD ["node", "dist/index.js"]