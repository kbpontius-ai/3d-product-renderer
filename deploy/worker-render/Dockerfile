# The render worker (F-SHIP-02).
#
# Node plus Blender. `python3-numpy` is not optional and its absence is the expensive kind: Blender's
# glTF importer needs it, so without it the worker starts cleanly, claims a job, and fails at mesh
# import — a queue that looks alive and completes nothing.
#
# The runtime base is Ubuntu 24.04 rather than the Node image's Debian, and that is the whole reason
# this file has two distributions in it. Blender is not an ordinary dependency here: `docs/16` pins
# the preview's tone mapping to Blender's AgX view transform as a matched pair, and the parity suite
# measures SSIM against renders produced by whatever build CI used. CI is Ubuntu 24.04, which ships
# 4.0.2. Debian bookworm ships the 3.x series, which predates AgX entirely — so a bookworm runtime
# would have built, started, claimed jobs, and quietly rendered against a different colour pipeline
# than every budget in the suite was calibrated on. Distribution build, not the blender.org tarball,
# for the same reason: the official builds carry OpenImageDenoise and Ubuntu's do not, the worker
# switches the denoiser on whenever it finds one, and that too would diverge from the baseline.
#
# No GPU. A droplet has none, so Cycles runs on CPU and a render is minutes rather than seconds
# (F-SHIP-09). That is a pilot-grade trade, and it is the one thing about this image worth knowing
# before somebody waits on a queue.

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker-render/package.json apps/worker-render/
COPY apps/worker-cad/package.json apps/worker-cad/
COPY packages packages
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY apps/worker-render apps/worker-render
COPY scripts scripts

FROM ubuntu:24.04 AS runtime
WORKDIR /app

# The series CI validates against. A bump here is a parity-suite event, not a package upgrade.
ARG BLENDER_SERIES=4.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends blender python3-numpy ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Node from the stage that installed against it, so the runtime cannot drift from the build.
COPY --from=build /usr/local/bin/node /usr/local/bin/node

ENV NODE_ENV=production
ENV BLENDER_PATH=/usr/bin/blender
ENV STORAGE_ROOT=/var/lib/3d-product-renderer/storage
ENV RENDER_SCRATCH=/var/lib/3d-product-renderer/render-work

COPY --from=build /app /app

RUN useradd --system --create-home --uid 1001 worker \
 && mkdir -p "$STORAGE_ROOT" "$RENDER_SCRATCH" \
 && chown -R worker:worker "$STORAGE_ROOT" "$RENDER_SCRATCH"
USER worker

# Three things that are cheap to assert now and expensive to discover on a queue: the Blender series
# the budgets assume, the numpy the glTF importer needs, and a Node that runs on this base at all.
RUN set -eu; \
    node --version; \
    blender --version | head -1; \
    blender --version | head -1 | grep -q "Blender ${BLENDER_SERIES}\." \
      || { echo "FATAL: expected Blender ${BLENDER_SERIES}.x — see docs/16 parity budgets"; exit 1; }; \
    blender --background --python-expr "import numpy" >/dev/null; \
    test -d /app/node_modules/tsx

# `node --import tsx` rather than `pnpm --filter ... start`, matching deploy/cad-worker/Dockerfile
# so the two workers start the same way. Two reasons beyond consistency: corepack resolves pnpm from
# the registry on first use and its cache is not among what the runtime stage copies, so a pnpm
# entrypoint makes every container start depend on the npm registry; and this is one process rather
# than three, with no shell in the chain.
CMD ["node", "--import", "tsx", "apps/worker-render/src/index.ts", "--role=render-worker"]
