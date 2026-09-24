# syntax=docker/dockerfile:1

# Node 22 to match CI and `engines.node` in package.json -- see the long note
# in apps/api/Dockerfile for why the three were made to agree. This stage only
# builds the bundle, but a bundle built on a Node the suite never ran on is
# still a bundle nothing tested.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @syntra/web build

# The unprivileged nginx image never needs root or NET_BIND_SERVICE. It listens
# on 8080, which lets the Kubernetes deployment enforce runAsNonRoot and drop
# every capability. The useful readiness signal for this service is the API's,
# and
#     docker-compose.yml already gates `web` on `api`'s health check. A probe
#     here would report that nginx is up, which it always is.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
