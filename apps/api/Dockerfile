# syntax=docker/dockerfile:1

# NODE 22, not 24, and pinned deliberately at all three places it is stated.
#
# package.json says `engines.node >= 22` and both CI jobs pin `node-version: 22`
# -- so the suite that gates every release has only ever run on 22, while this
# image shipped 24. That is a production runtime nothing tests: a change in
# Node's TLS defaults, its OpenSSL, or its handling of the SAML/XML native
# paths would pass CI and fail on a customer's host, and the first symptom
# would be an SSO integration that stopped working after an upgrade nobody
# connected to it. Aligning downwards is the cheap direction -- moving CI up
# to 24 instead would need the whole suite re-validated on it first, and
# nothing here requires a 24-only feature.
FROM node:22-alpine AS base
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

# THE WHOLE BUILD TREE, devDependencies included, AND THAT IS NOT AN OVERSIGHT.
#
# `pnpm install --prod` here would be wrong twice over, and both failures land
# at container start rather than at build time:
#
#   - The runtime does not run compiled JavaScript. `start` is
#     `node --import tsx src/server.ts` and the CMD below is the same thing --
#     the TypeScript source IS the artefact. `tsx` and `typescript` are ROOT
#     devDependencies, so `--prod` deletes the interpreter this image invokes.
#   - `prisma` (the CLI, as opposed to `@prisma/client`) is a devDependency of
#     @syntra/db, and the migrate step below is `prisma migrate deploy`. A
#     pruned image cannot migrate, which is the one thing it must do before it
#     can serve anything.
#
# Neither is fixable by moving a package between dependency lists without also
# deciding whether this image should build JavaScript ahead of time -- a real
# change, worth doing on its own, not as a side effect of shrinking a layer.
# Until then the tree is copied whole, on purpose.
COPY --from=build /app /app

# Not root. Nothing in this container writes to the tree it runs from, and a
# process that does not need to own its own source should not be able to
# rewrite it -- an RCE in an XML or SCIM parser then cannot persist itself
# into the code that runs at next boot. `node` is uid 1000 in the official
# image and already owns /home/node, which is where corepack and pnpm keep
# their cache; /app stays root-owned and world-readable, which is exactly the
# arrangement wanted.
USER node

# The same probe docker-compose.yml runs, stated here as well so that a plain
# `docker run` -- or any orchestrator that reads the image rather than the
# compose file -- gets it too. Previously only compose had one, so the image
# on its own reported "healthy" from the instant it started.
#
# READINESS, not /health: a liveness check that only proves the process is
# listening would report healthy while it cannot reach Postgres. No curl or
# wget in the alpine runtime, so this uses Node's own fetch rather than adding
# a package for the sake of a health check.
HEALTHCHECK --interval=5s --timeout=5s --start-period=30s --retries=20 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations are applied at start rather than at build: the database is not
# reachable while the image is being built, and a container that boots against
# an out-of-date schema would fail in far less obvious ways.
CMD ["sh", "-c", "pnpm --filter @syntra/db migrate && pnpm --filter @syntra/api exec tsx src/server.ts"]
