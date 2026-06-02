# OpenMyModel Cloud Backend - Docker Image (国内镜像)
ARG NODE_VERSION=22

# ---- Build Stage ----
FROM docker.m.daocloud.io/library/node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- Runtime Stage ----
FROM docker.m.daocloud.io/library/node:${NODE_VERSION}-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm rebuild better-sqlite3
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000
ENV ADMIN_PASSWORD=admin123456
ENV DOMAIN=localhost
ENV PORT=3000
CMD ["node", "dist/index.js"]
