# The web app (F-SHIP-01).
#
# Two stages. The build needs the whole workspace — `next.config.mjs` lists seven `@pr/*` packages
# under `transpilePackages`, so they are compiled from TypeScript source as part of the Next build
# rather than consumed as a built `dist`. Copying only `apps/web` produces a build that fails on the
# first workspace import.
#
# The runtime stage keeps node_modules rather than using Next's standalone output: the render and
# CAD workers run the same sources through `tsx`, and one dependency tree across all three images is
# worth more here than the megabytes standalone would save.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# corepack pins pnpm from `packageManager`, so the image cannot drift from what CI and laptops use.
RUN corepack enable

# Manifests first: this layer only changes when a dependency does, so an ordinary code change
# reuses the install.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker-render/package.json apps/worker-render/
COPY apps/worker-cad/package.json apps/worker-cad/
COPY packages packages
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY apps/web apps/web
RUN pnpm --filter @pr/web build

# After the build, so an edit to a script does not invalidate it. This image is also what the
# `migrate` service runs, and `scripts/db-migrate.ts` lives here — without it that one-shot exits
# non-zero, and because `web` waits on `service_completed_successfully`, nothing in the stack
# starts at all.
COPY scripts scripts

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Where the object store is mounted. Absolute, because the web app's working directory is not the
# repository root and a relative value silently splits the store in two — the failure the README
# describes on macOS, and the same one in a container.
ENV STORAGE_ROOT=/var/lib/3d-product-renderer/storage

COPY --from=build /app /app

# Unprivileged, and owning only what it must write.
RUN mkdir -p "$STORAGE_ROOT" && chown -R node:node "$STORAGE_ROOT"
USER node

# Both jobs this image is used for, checked while the build can still fail rather than at the next
# deploy. `tsx` and `scripts/` are what the `migrate` service needs; adding `--prod` to the install
# above would drop tsx and take migrations with it, silently.
RUN test -x /app/apps/web/node_modules/.bin/next \
 && test -d /app/node_modules/tsx \
 && test -f /app/scripts/db-migrate.ts

EXPOSE 3000
# `next` directly rather than `pnpm --filter @pr/web start`: corepack resolves pnpm from the registry
# on first use and its cache is not among what this stage copies, so a pnpm entrypoint would make
# every container start depend on the npm registry being reachable. There is no corepack in this
# stage for the same reason. The port matches apps/web/package.json; the compose healthcheck and
# Caddy both assume it.
WORKDIR /app/apps/web
CMD ["/app/apps/web/node_modules/.bin/next", "start", "--port", "3000"]
