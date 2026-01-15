# syntax=docker/dockerfile:1

FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies (including dev for build tools)
COPY package*.json ./
RUN npm ci

# Copy assets and build minified CSS
COPY postcss.config.cjs ./postcss.config.cjs
COPY server.js ./server.js
COPY public ./public
RUN npm run build:css:min && cp public/style.merged.min.css public/style.css

FROM node:20-alpine AS base
WORKDIR /app

# Install runtime tools for healthcheck
RUN apk add --no-cache curl

# Install dependencies using lockfile
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY --from=build /app/public ./public
COPY server.js ./server.js
COPY index.html ./index.html
COPY kanban.js ./kanban.js
COPY markdown.js ./markdown.js

# Prepare writable data directory
RUN mkdir -p /app/data && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:${PORT}/ || exit 1

USER node

CMD ["npm", "start"]
