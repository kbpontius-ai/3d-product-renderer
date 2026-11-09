#!/usr/bin/env bash
# Builds the web app and runs the end-to-end suite against it.
#
# The app bundles the workspace packages at build time, so a stale server silently tests old code —
# this script exists so that cannot happen by accident.
#
#   scripts/e2e.sh                 # everything
#   scripts/e2e.sh auth.spec.ts    # one file (any playwright argument works)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# No real mail from a test run, whatever is in the shell that started it.
#
# Every process below — the web server, both workers, Playwright — inherits this script's
# environment, and with a provider key in it the suite used to send each of its `@example.com`
# invitations and resets for real, bouncing them against a sending domain with no reputation to
# spare. Unset once, here, so a launcher added later is covered without having to know. The
# transport also refuses reserved domains on its own (packages/mail/src/reserved.ts); this is the
# layer that keeps the suite on the development mailbox it reads messages back out of.
unset RESEND_API_KEY MAIL_FROM MAIL_REPLY_TO

PORT="${E2E_PORT:-3100}"

# A database and an object store of the suite's own, never whatever DATABASE_URL and STORAGE_ROOT
# happen to point at.
#
# global-setup provisions an organisation and accounts on every run, packs.spec imports packs, and
# nothing tears any of it down. Pointed at a development database that is simply where the suite
# lands, which is how one afternoon's runs left 51 accounts, 20 deprecated packs and 56MB of orphaned
# objects sitting in front of the person using the app. Isolation is the fix rather than a cleanup
# step, because a cleanup step is one that can be forgotten and one whose delete-by-pattern is a typo
# away from taking real data with it.
#
# Every run starts from nothing, as a CI run does. The specs assume it: a preview generated last run
# fails the test for a product with no preview, a pack version imported last run makes a link
# ambiguous, and a fixed SVG uploaded last run is refused as a duplicate. E2E_KEEP_DATA=1 keeps what
# is there, for looking at a run's results or rerunning one spec against them.
E2E_DATABASE="${E2E_DATABASE:-product_renderer_e2e}"

if [ -x ./scripts/dev-db.sh ]; then
  PGDATABASE="$E2E_DATABASE" ./scripts/dev-db.sh start >/dev/null 2>&1 || true

  if PGDATABASE="$E2E_DATABASE" ./scripts/dev-db.sh status >/dev/null 2>&1; then
    if [ -z "${E2E_KEEP_DATA:-}" ]; then
      echo "dropping ${E2E_DATABASE}…"
      # Anything still connected — a worker from a previous run — would keep the drop waiting.
      "${PG_BIN:-/usr/lib/postgresql/16/bin}/psql" -h "$ROOT_DIR/.tmp/pgsock" -p "${PGPORT:-55432}" \
        -U postgres -d postgres -tAc \
        "select pg_terminate_backend(pid) from pg_stat_activity where datname='$E2E_DATABASE';" \
        >/dev/null 2>&1 || true
      "${PG_BIN:-/usr/lib/postgresql/16/bin}/dropdb" -h "$ROOT_DIR/.tmp/pgsock" -p "${PGPORT:-55432}" \
        -U postgres --if-exists "$E2E_DATABASE" >/dev/null 2>&1 || true
      PGDATABASE="$E2E_DATABASE" ./scripts/dev-db.sh start >/dev/null 2>&1 || true
      # The default root only: a path someone passed in is theirs.
      rm -rf "$ROOT_DIR/.tmp/e2e-storage"
    fi

    DATABASE_URL="$(PGDATABASE="$E2E_DATABASE" ./scripts/dev-db.sh url)"
    export DATABASE_URL
    echo "using $DATABASE_URL"
  else
    # Not the inherited DATABASE_URL. That is the development database, which is the one place the
    # suite must never land, and a worktree has no .tmp/pgsock so it would land there every time.
    unset DATABASE_URL
    echo "warning: no database — account, catalog and design tests will be skipped" >&2
  fi
fi

# The same reasoning for the object store: pack assets, uploaded artwork and finished renders are
# written by key, so a shared root leaves the suite's objects among the developer's.
export STORAGE_ROOT="${E2E_STORAGE_ROOT:-$ROOT_DIR/.tmp/e2e-storage}"

# The account tests need the development tooling: an invitation endpoint and an in-memory mailbox.
export DEV_TOOLING="${DEV_TOOLING:-true}"
# The suite sets a password on every run; whether a third party is up says nothing about this code.
export PASSWORD_BREACH_CHECK="${PASSWORD_BREACH_CHECK:-off}"
export ARTWORK_PREPARE_LIMIT="${ARTWORK_PREPARE_LIMIT:-1000}"
export APP_URL="http://127.0.0.1:$PORT"
# The suite accepts a dozen or so invitations a run from one address — global setup's shared
# accounts, plus every test that is *about* the account lifecycle. Ten per ten minutes is right for
# real users on their own connections and wrong for one machine doing legitimate setup.
#
# playwright.config.ts sets this too, on the server *it* starts. This script starts its own, so that
# copy never reaches the app and the twelfth account of a run gets "Too many attempts" instead of a
# password — which reads as a flake in whichever spec happened to be twelfth.
export AUTH_INVITE_ACCEPT_LIMIT="${AUTH_INVITE_ACCEPT_LIMIT:-100}"
# Uploads, likewise: every spec uploads through the same shared account, more than thirty files a
# run, and the default budget of thirty per five minutes refused the last ones with a 429.
export ARTWORK_UPLOAD_LIMIT="${ARTWORK_UPLOAD_LIMIT:-300}"
# Explicit for the same reason: signing assets through the configured path rather than the
# per-process fallback is part of what the suite is checking.
export ASSET_URL_SECRET="${ASSET_URL_SECRET:-e2e-asset-signing-secret}"

if [ -n "${DATABASE_URL:-}" ]; then
  echo "migrating and importing fixture packs…"
  pnpm db:migrate >/dev/null
  pnpm import:pack fixtures/packs/cap-basic --publish --replace >/dev/null
  pnpm import:pack fixtures/packs/bottle-oval --publish --replace >/dev/null
  pnpm import:pack fixtures/packs/box-basic --publish --replace >/dev/null
fi

echo "building…"
pnpm --filter @pr/web build >/dev/null

# A render worker, if this machine has a renderer. Without one the queue still works and the render
# tests that only need a job still run; the ones that need pixels skip themselves.
WORKER_PGID_FILE=".tmp/render-worker.pgid"

if [ -n "${DATABASE_URL:-}" ] && command -v "${BLENDER_PATH:-blender}" >/dev/null 2>&1; then
  # Stop the previous run's worker before starting one on the current code.
  #
  # By process group, recorded when it was started, rather than by matching a command line: pnpm
  # runs the worker as `sh -c tsx src/index.ts`, which the pattern this used to use never matched.
  # Every run therefore left its worker behind, and since they all poll the same queue, a job could
  # be claimed by a worker built from code several changes old — which is exactly the kind of
  # failure that looks like a bug in whatever you just wrote.
  if [ -f "$WORKER_PGID_FILE" ]; then
    kill -TERM -"$(cat "$WORKER_PGID_FILE")" >/dev/null 2>&1 || true
    rm -f "$WORKER_PGID_FILE"
  fi
  # And by the marker the worker carries in its own argv, which catches one started by hand or left
  # by a run that predates the file above. Matching on a path fragment does not work: pnpm runs it
  # through two shells and tsx re-execs node, so the surviving process reads
  # `node …/tsx/dist/cli.mjs src/index.ts` and is reparented to init.
  pkill -f -- "--role=render-worke[r]" >/dev/null 2>&1 || true

  mkdir -p "$(dirname "$WORKER_PGID_FILE")"
  # setsid so the worker leads its own process group and the whole chain — pnpm, its shell, tsx —
  # goes away together next time.
  setsid nohup env DATABASE_URL="$DATABASE_URL" RENDER_THREADS="${RENDER_THREADS:-2}" \
    pnpm worker:render > /tmp/render-worker.log 2>&1 &
  echo $! > "$WORKER_PGID_FILE"
  export E2E_RENDER_WORKER=true
  echo "render worker started (pgid $(cat "$WORKER_PGID_FILE"))"
fi

# A CAD worker. Unlike the render worker this needs nothing installed — the reference importer has
# no kernel behind it, which is the whole reason it exists — so it starts whenever there is a
# database. Same process-group discipline, for the same reason: a worker left over from a previous
# run polls the same queue and claims jobs with code nobody is testing.
CAD_WORKER_PGID_FILE=".tmp/cad-worker.pgid"

if [ -n "${DATABASE_URL:-}" ]; then
  if [ -f "$CAD_WORKER_PGID_FILE" ]; then
    kill -TERM -"$(cat "$CAD_WORKER_PGID_FILE")" >/dev/null 2>&1 || true
    rm -f "$CAD_WORKER_PGID_FILE"
  fi
  pkill -f -- "--role=cad-worke[r]" >/dev/null 2>&1 || true

  mkdir -p "$(dirname "$CAD_WORKER_PGID_FILE")"
  setsid nohup env DATABASE_URL="$DATABASE_URL" CAD_THREADS="${CAD_THREADS:-2}" \
    pnpm worker:cad > /tmp/cad-worker.log 2>&1 &
  echo $! > "$CAD_WORKER_PGID_FILE"
  export E2E_CAD_WORKER=true
  echo "cad worker started (pgid $(cat "$CAD_WORKER_PGID_FILE"))"
fi

# Replace any server left over from a previous run, so the build just made is the one under test.
pkill -f "next-serv[e]r" >/dev/null 2>&1 || true
sleep 1

nohup env \
  DATABASE_URL="${DATABASE_URL:-}" \
  APP_URL="$APP_URL" \
  DEV_TOOLING="$DEV_TOOLING" \
  ALLOW_DEV_TOOLING_IN_PRODUCTION="$DEV_TOOLING" \
  AUTH_INVITE_ACCEPT_LIMIT="$AUTH_INVITE_ACCEPT_LIMIT" \
  ARTWORK_UPLOAD_LIMIT="$ARTWORK_UPLOAD_LIMIT" \
  ASSET_URL_SECRET="$ASSET_URL_SECRET" \
  pnpm --filter @pr/web exec next start --port "$PORT" > /tmp/next-e2e.log 2>&1 &

for _ in $(seq 1 40); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/design/demo" && break
  sleep 1
done

status=0
pnpm exec playwright test "$@" || status=$?

# Stop the workers this run started, rather than leaving them polling.
#
# They hold the e2e database, so a worker left behind claims nothing submitted from the development
# app: the render sits in the queue, the bell never rings, and nothing on screen explains why. The
# server on $PORT is deliberately left up — preview-probe and scripts/screenshot.ts expect to find
# it there.
for pgid_file in "$WORKER_PGID_FILE" "$CAD_WORKER_PGID_FILE"; do
  [ -f "$pgid_file" ] || continue
  kill -TERM -"$(cat "$pgid_file")" >/dev/null 2>&1 || true
  rm -f "$pgid_file"
done

exit $status
