# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/contracts/package.json packages/contracts/
COPY packages/connectors/package.json packages/connectors/
COPY packages/protocols/package.json packages/protocols/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @syntra/db generate

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
# Migrations are applied at start rather than at build: the database is not
# reachable while the image is being built, and a container that boots against
# an out-of-date schema would fail in far less obvious ways.
CMD ["sh", "-c", "pnpm --filter @syntra/db migrate && pnpm --filter @syntra/api exec tsx src/server.ts"]
