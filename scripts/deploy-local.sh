#!/usr/bin/env bash
# Stands up a complete local instance, from a clean clone to a sign-in link.
#
#   scripts/deploy-local.sh you@example.com              # do it, with an empty catalog
#   scripts/deploy-local.sh you@example.com --samples    # ...and import the sample packs too
#   scripts/deploy-local.sh --check                      # only report what this machine can run
#
# Idempotent: run it again after a `git pull` and it migrates, re-imports and tells you the state
# without duplicating anything. It is the README's numbered steps, executable, so the two cannot
# drift apart.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CHECK_ONLY=false
SAMPLES=false
EMAIL=""
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=true ;;
    --samples) SAMPLES=true ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) EMAIL="$arg" ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

# --- what can this machine run? ----------------------------------------------------------------
#
# Four of the five pieces are independently optional, and until now the only way to find out which
# you were missing was to reach the feature that needed it. Each line says what is lost, not just
# what is absent.

MISSING_REQUIRED=0

bold "Checking this machine"

if command -v node >/dev/null 2>&1 && [ "$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')" -ge 22 ]; then
  ok "Node $(node --version)"
else
  bad "Node 22+ — required; nothing runs without it"; MISSING_REQUIRED=1
fi

if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm --version)"
else
  bad "pnpm — required; \`corepack enable\` picks up the pinned version"; MISSING_REQUIRED=1
fi

PG_BIN_DIR="${PG_BIN:-/usr/lib/postgresql/16/bin}"
if [ -x "$PG_BIN_DIR/initdb" ]; then
  ok "PostgreSQL at $PG_BIN_DIR"
elif command -v brew >/dev/null 2>&1 && [ -x "$(brew --prefix postgresql@16 2>/dev/null)/bin/initdb" ]; then
  PG_BIN_DIR="$(brew --prefix postgresql@16)/bin"
  export PG_BIN="$PG_BIN_DIR"
  ok "PostgreSQL at $PG_BIN_DIR (found via Homebrew)"
else
  bad "PostgreSQL 16 — without it: no accounts, no catalog, no saved designs. Only /design/demo works."
  MISSING_REQUIRED=1
fi

if command -v "${BLENDER_PATH:-blender}" >/dev/null 2>&1; then
  ok "Blender ($("${BLENDER_PATH:-blender}" --version 2>/dev/null | head -1))"
elif [ -x "/Applications/Blender.app/Contents/MacOS/Blender" ]; then
  warn "Blender is installed but not on the path — export BLENDER_PATH=/Applications/Blender.app/Contents/MacOS/Blender"
else
  warn "Blender — without it: everything works up to asking for pixels. RENDER_BACKEND=fake exercises the rest."
fi

CAD_PY="${CAD_PYTHON:-python3}"
if command -v "$CAD_PY" >/dev/null 2>&1 && "$CAD_PY" -c 'import OCP' >/dev/null 2>&1; then
  ok "OCCT bindings for $CAD_PY"
else
  warn "OCCT — without it: /admin/cad accepts uploads and the worker produces parametric cylinders"
  warn "  instead of your geometry, which looks like success. pip install cadquery-ocp==7.9.3.1.1"
fi

# The parser sandbox. Linux-only, and its absence is a security fact rather than a missing feature,
# so it is reported even though nothing here will stop working without it.
if command -v unshare >/dev/null 2>&1 && command -v prlimit >/dev/null 2>&1 \
   && unshare --user --map-root-user --net --ipc --uts --pid --mount --fork --kill-child --mount-proc true >/dev/null 2>&1; then
  ok "CAD parser sandbox available (namespaces + rlimits)"
else
  warn "CAD parser sandbox unavailable — Linux-only. On a laptop reading your own files that is a"
  warn "  reasonable trade; on a server set CAD_SANDBOX=require so the worker refuses to start."
fi

if [ "$MISSING_REQUIRED" -ne 0 ]; then
  echo
  bad "Install the required pieces above, then run this again."
  exit 1
fi

if [ "$CHECK_ONLY" = true ]; then
  echo
  bold "Nothing was changed. Run \`scripts/deploy-local.sh you@example.com\` to stand it up."
  exit 0
fi

if [ -z "$EMAIL" ]; then
  echo
  bad "An email address is needed for the first account: scripts/deploy-local.sh you@example.com"
  echo "  The platform is invite-only by construction, and that includes the first account."
  exit 1
fi

# --- stand it up -------------------------------------------------------------------------------

echo
bold "Installing dependencies"
pnpm install --frozen-lockfile

echo
bold "Database"
if [ -z "${DATABASE_URL:-}" ]; then
  ./scripts/dev-db.sh start >/dev/null
  DATABASE_URL="$(./scripts/dev-db.sh url)"
  export DATABASE_URL
  ok "throwaway cluster under .tmp/ — $DATABASE_URL"
else
  ok "using the DATABASE_URL already set"
fi
pnpm db:migrate

echo
bold "Catalog"
# A fresh installation ships no products; the sample packs are the test fixtures, imported only on
# request. Both are idempotent: an unchanged pack re-imports as "unchanged" and only refreshes its
# assets.
if [ "$SAMPLES" = true ]; then
  pnpm import:pack fixtures/packs/cap-basic --publish --replace
  pnpm import:pack fixtures/packs/box-basic --publish --replace
else
  ok "empty — add products at /admin/packs or /admin/cad, or re-run with --samples"
fi

echo
bold "Account"
# Idempotent: the organisation is reused if it exists, and a fresh invitation is issued either way.
pnpm seed:dev "$EMAIL"

cat <<NEXT

$(bold "Ready")

  1. Open the invitation link above and set a password. That account is staff, so it can
     reach /admin.
  2. Start the app:            pnpm --filter @pr/web dev        # or: pnpm build:web && pnpm start:web
  3. Optional, in their own terminals:
         pnpm worker:render     renders submitted from the editor
         pnpm worker:cad        STEP files uploaded at /admin/cad

  Keep DATABASE_URL exported in every terminal, or they will not agree about where anything is:

      export DATABASE_URL="$DATABASE_URL"

NEXT
