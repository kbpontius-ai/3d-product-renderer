#!/usr/bin/env bash
# Restores a backup into a database and an object store (F-PLAT-05).
#
#   TARGET_DATABASE_URL=... TARGET_STORAGE_ROOT=... ./scripts/restore.sh .tmp/backups/<stamp>
#
# Deliberately refuses to write over the database named in DATABASE_URL unless told to: the moment
# anyone needs this, they are having a bad day, and a restore that silently replaced production
# because someone forgot an environment variable would make it worse.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
SOURCE="${1:?usage: restore.sh <backup directory>}"

: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is not set}"
TARGET_STORAGE="${TARGET_STORAGE_ROOT:-$ROOT_DIR/.tmp/restored-storage}"

if [ "${TARGET_DATABASE_URL}" = "${DATABASE_URL:-}" ] && [ "${ALLOW_RESTORE_OVER_LIVE:-}" != "true" ]; then
  echo "refusing to restore over DATABASE_URL; set ALLOW_RESTORE_OVER_LIVE=true if that is the intent" >&2
  exit 2
fi

echo "verifying $SOURCE"
while IFS='=' read -r key value; do
  case "$key" in
    *.sha256)
      file="${key%.sha256}"
      actual="$(sha256sum "$SOURCE/$file" | cut -d' ' -f1)"
      [ "$actual" = "$value" ] || { echo "checksum mismatch for $file" >&2; exit 1; }
      ;;
  esac
done < "$SOURCE/manifest.txt"

echo "restoring the database"
# Same reason as the dump: the row-level policies apply to whoever is writing, and a restore that
# silently dropped every tenant row would be the worst possible outcome of a restore.
PGOPTIONS="${PGOPTIONS:--c app.is_staff=on}" \
  "$PG_BIN/pg_restore" --clean --if-exists --no-owner --no-privileges \
    --dbname="$TARGET_DATABASE_URL" "$SOURCE/database.dump"

echo "restoring the object store into $TARGET_STORAGE"
mkdir -p "$TARGET_STORAGE"
if [ -s "$SOURCE/storage.tar.gz" ]; then
  tar -xzf "$SOURCE/storage.tar.gz" -C "$TARGET_STORAGE"
fi

echo "restored"
