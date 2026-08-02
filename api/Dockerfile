# syntax=docker/dockerfile:1.7

# Production CI should override this with an approved immutable digest, for
# example node:24.16.0-bookworm-slim@sha256:<digest>.
ARG NODE_IMAGE=node:24.16.0-bookworm-slim

FROM ${NODE_IMAGE} AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build

ENV NODE_ENV=development

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node prisma ./prisma

# npm ci fails if package.json and package-lock.json drift, which keeps the
# dependency graph reproducible.
RUN npm ci --include=dev

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src

RUN npm exec -- prisma generate \
    && npm run build

# Build this target for the one-shot migration job. It intentionally retains
# the build dependency tree, including the Prisma CLI.
FROM build AS migration

ENV NODE_ENV=production

USER node

CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

FROM build AS production-dependencies

# @prisma/client declares the Prisma CLI as an optional peer, so npm can retain
# it even after pruning devDependencies. The generated client and query engine
# live under @prisma/client and .prisma; remove only the CLI.
RUN npm prune --omit=dev \
    && rm -rf node_modules/prisma \
    && rm -f node_modules/.bin/prisma \
    && node -e "require('@prisma/client')" \
    && npm cache clean --force

FROM base AS runtime

ENV NODE_ENV=production \
    PORT=3001

COPY --from=production-dependencies --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma

USER node

EXPOSE 3001
STOPSIGNAL SIGTERM

# The same image runs the worker with: node dist/worker.js
CMD ["node", "dist/index.js"]
