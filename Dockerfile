# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app

# Install dependencies first, in their own layer, so `docker build` only
# re-runs npm ci when package.json/package-lock.json actually change - not
# on every source edit.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application code and local data fixtures. data/historical/*.xlsx is
# gitignored (kept out of the public GitHub repo) but NOT dockerignored - a
# build run from local source bakes in whatever real file currently sits on
# disk. If you instead build via a CI/CD pipeline pulling straight from
# GitHub, that path won't be present and Source 1 falls back gracefully to
# empty, per src/ingestion/localFileAdapter.js. Sources 2, 3 & 4 are all
# live Google Sheets, unaffected by what's baked into the image.
COPY config ./config
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY data ./data

# Run as a non-root user.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
  && chown -R appuser:appgroup /app
USER appuser

ENV NODE_ENV=production
# Cloud Run injects $PORT at runtime (default 8080); config/environment.js
# already reads process.env.PORT, so no code change is required here.
EXPOSE 8080

CMD ["node", "src/app.js"]
