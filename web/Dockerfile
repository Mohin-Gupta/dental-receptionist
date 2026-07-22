# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.16.0-bookworm-slim
FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS dependencies
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_BILLING_PLAN_KEYS
ARG NEXT_PUBLIC_TERMS_URL
ARG NEXT_PUBLIC_PRIVACY_URL
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_BILLING_PLAN_KEYS=${NEXT_PUBLIC_BILLING_PLAN_KEYS} \
    NEXT_PUBLIC_TERMS_URL=${NEXT_PUBLIC_TERMS_URL} \
    NEXT_PUBLIC_PRIVACY_URL=${NEXT_PUBLIC_PRIVACY_URL}
COPY --chown=node:node . .
RUN test -n "$NEXT_PUBLIC_API_URL" \
    && test -n "$NEXT_PUBLIC_BILLING_PLAN_KEYS" \
    && test -n "$NEXT_PUBLIC_TERMS_URL" \
    && test -n "$NEXT_PUBLIC_PRIVACY_URL" \
    && npm run build

FROM base AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "server.js"]
