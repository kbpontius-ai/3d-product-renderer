# The CAD ingestion worker (docs/23-cad-ingestion.md, "Security").
#
# Its own image, not a variant of the web app's: this carries a large native CAD kernel and a much
# more hostile threat model than anything else in the system, and those should not share a
# filesystem with the thing serving customer requests.
#
# Two layers of confinement, and neither replaces the other. This image and the runtime flags that
# go with it are the outer one — configured by an operator, and therefore misconfigurable. The inner
# one is `packages/cad-occt/src/sandbox.ts`, which puts every parse in its own namespaces with no
# network at all, and holds whether the outer layer was set up correctly or not. `CAD_SANDBOX=require`
# below is what makes the inner layer non-optional here.

# ---------------------------------------------------------------------------------------------
# Build: install workspace dependencies. Nothing from this stage reaches the runtime except
# node_modules, so the toolchain, the package manager and the git history stay out of the image.
# ---------------------------------------------------------------------------------------------
FROM node:22.22.2-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------------------------------------
# Runtime.
# ---------------------------------------------------------------------------------------------
FROM node:22.22.2-bookworm-slim

# python3 runs the parser; util-linux carries `unshare` and `prlimit`, which are what the inner
# sandbox is built out of. libgl/libx11 are VTK's link-time dependencies — the OCCT bindings pull
# VTK in whether or not anything here draws anything.
RUN apt-get update && apt-get install --no-install-recommends -y \
      python3 python3-pip util-linux \
      libgl1 libglx-mesa0 libxrender1 libxext6 libsm6 \
 && rm -rf /var/lib/apt/lists/*

# The kernel, pinned. Determinism is pinned to a build — a mesh digest means nothing without knowing
# which one produced it — so this version is part of the pipeline's identity, not a floating dep.
#
# TODO before production: install from a hash-pinned requirements file rather than by version, and
# generate an SBOM at build time. docs/23 asks for both; neither is done.
ARG OCCT_VERSION=7.9.3.1.1
RUN pip3 install --no-cache-dir --break-system-packages "cadquery-ocp==${OCCT_VERSION}"

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY package.json pnpm-workspace.yaml ./

# Non-root, and owning nothing it runs. The application tree is root-owned and read-only to this
# user: an exploit that reaches the supervisor cannot rewrite the code it will run next time.
RUN useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin cadworker
USER 10001:10001

ENV NODE_ENV=production \
    # Non-negotiable in the image. The worker refuses to start rather than parse a stranger's file
    # unconfined, which is the one outcome worse than not starting.
    CAD_SANDBOX=require \
    # Written to a tmpfs the runtime mounts, so it never touches the read-only root filesystem and
    # never outlives the container.
    CAD_SCRATCH=/scratch/cad \
    CAD_THREADS=2 \
    CAD_PYTHON=python3

# tsx directly rather than through pnpm: one process instead of three, and no shell in the chain.
ENTRYPOINT ["node", "--import", "tsx", "apps/worker-cad/src/index.ts", "--role=cad-worker"]
