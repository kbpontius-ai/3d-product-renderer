#!/usr/bin/env bash
# Starts a throwaway PostgreSQL for development and integration tests.
#
# CI uses a service container; this exists so the same tests can run on a laptop (or in a sandbox)
# without Docker. Data lives under .tmp/ and is safe to delete at any time.
#
#   scripts/dev-db.sh start|stop|status|reset
#
# Exports nothing: print the URL with `scripts/dev-db.sh url` and set DATABASE_URL from it.
set -euo pipefail

PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGDATA="${PGDATA:-$ROOT_DIR/.tmp/pgdata}"
PGPORT="${PGPORT:-55432}"
PGSOCKET="${PGSOCKET:-$ROOT_DIR/.tmp/pgsock}"
PGUSER_APP="${PGUSER_APP:-product_renderer}"
PGDATABASE="${PGDATABASE:-product_renderer}"
LOGFILE="$ROOT_DIR/.tmp/postgres.log"

# PostgreSQL refuses to run as root; use an unprivileged account when we happen to be root.
RUNNER="${PG_RUNNER:-pgdev}"
as_runner() {
  if [ "$(id -u)" -eq 0 ]; then
    su "$RUNNER" -s /bin/bash -c "$1"
  else
    bash -c "$1"
  fi
}

ensure_runner() {
  [ "$(id -u)" -eq 0 ] || return 0
  id -u "$RUNNER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$RUNNER"
}

url() {
  echo "postgres://$PGUSER_APP:$PGUSER_APP@127.0.0.1:$PGPORT/$PGDATABASE"
}

start() {
  ensure_runner
  mkdir -p "$(dirname "$PGDATA")" "$PGSOCKET"

  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    echo "initialising cluster in $PGDATA"
    mkdir -p "$PGDATA"
    [ "$(id -u)" -eq 0 ] && chown -R "$RUNNER" "$PGDATA" "$PGSOCKET" "$(dirname "$PGDATA")"
    as_runner "$PG_BIN/initdb -D '$PGDATA' -U postgres --auth-local=trust --auth-host=trust -E UTF8" >/dev/null
  fi

  [ "$(id -u)" -eq 0 ] && chown -R "$RUNNER" "$PGDATA" "$PGSOCKET"

  if status >/dev/null 2>&1; then
    echo "already running on port $PGPORT"
  else
    as_runner "$PG_BIN/pg_ctl -D '$PGDATA' -l '$LOGFILE' -o \"-p $PGPORT -k '$PGSOCKET' -c listen_addresses=127.0.0.1\" -w start" >/dev/null
    echo "started on port $PGPORT"
  fi

  # -d postgres on every maintenance connection: PGDATABASE is a libpq variable as well as this
  # script's parameter, so without it psql defaults to the database being created and fails.
  as_runner "$PG_BIN/psql -h '$PGSOCKET' -p $PGPORT -U postgres -d postgres -tAc \"select 1 from pg_roles where rolname='$PGUSER_APP'\"" | grep -q 1 || \
    as_runner "$PG_BIN/psql -h '$PGSOCKET' -p $PGPORT -U postgres -d postgres -c \"create role $PGUSER_APP login password '$PGUSER_APP' createdb\"" >/dev/null

  as_runner "$PG_BIN/psql -h '$PGSOCKET' -p $PGPORT -U postgres -d postgres -tAc \"select 1 from pg_database where datname='$PGDATABASE'\"" | grep -q 1 || \
    as_runner "$PG_BIN/createdb -h '$PGSOCKET' -p $PGPORT -U postgres -O $PGUSER_APP $PGDATABASE" >/dev/null

  echo "$(url)"
}

stop() {
  as_runner "$PG_BIN/pg_ctl -D '$PGDATA' -m fast -w stop" >/dev/null 2>&1 || true
  echo "stopped"
}

status() {
  as_runner "$PG_BIN/pg_ctl -D '$PGDATA' status" >/dev/null 2>&1
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status && echo "running" || { echo "not running"; exit 1; } ;;
  url) url ;;
  reset)
    stop
    rm -rf "$PGDATA"
    start
    ;;
  *)
    echo "usage: $0 start|stop|status|url|reset" >&2
    exit 2
    ;;
esac
