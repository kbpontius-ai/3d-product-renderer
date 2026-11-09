#!/usr/bin/env bash
# Takes a backup: the database and the object store, together (F-PLAT-05).
#
# Together matters. A design row pointing at artwork that is not in the object store is not a
# recoverable design, so the two are captured as one dated set with a manifest tying them.
#
#   ./scripts/backup.sh [destination]     # default: .tmp/backups/<timestamp>
#
# The database goes out in PostgreSQL's custom format (compressed, restorable table by table); the
# object store as a tar. Both are listed in the manifest with their sizes and SHA-256, because a
# backup nobody has verified is a hope rather than a backup.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${1:-$ROOT_DIR/.tmp/backups/$STAMP}"
STORAGE="${STORAGE_ROOT:-$ROOT_DIR/.tmp/storage}"

: "${DATABASE_URL:?DATABASE_URL is not set}"

mkdir -p "$DEST"
echo "backing up to $DEST"

# Every tenant table is FORCE ROW LEVEL SECURITY, which applies to the table owner too — so an
# ordinary pg_dump reads nothing and fails (or, worse on a permissive schema, quietly writes empty
# tables). The policies already grant staff a cross-tenant view, so the dump session claims it.
# A production deployment may instead give the backup role BYPASSRLS; either works, and this one
# needs no privileges the application does not already have.
# --enable-row-security is required as well: pg_dump otherwise refuses outright rather than risk a
# partial dump. Under the policies, with staff claimed above, it reads everything. The restore
# drill (`pnpm backup:drill`) is what proves that — it compares row counts against the live
# database, so a dump that silently lost a tenant's rows fails loudly instead of sitting in a
# bucket until someone needs it.
PGOPTIONS="${PGOPTIONS:--c app.is_staff=on}" \
  "$PG_BIN/pg_dump" --format=custom --no-owner --no-privileges --enable-row-security \
    --file="$DEST/database.dump" "$DATABASE_URL"

if [ -d "$STORAGE" ]; then
  tar -czf "$DEST/storage.tar.gz" -C "$STORAGE" .
else
  echo "warning: no object store at $STORAGE; backing up the database only" >&2
  : > "$DEST/storage.tar.gz"
fi

{
  echo "takenAt=$STAMP"
  echo "database=$(basename "$(echo "$DATABASE_URL" | sed 's/?.*//')")"
  echo "storageRoot=$STORAGE"
  for file in database.dump storage.tar.gz; do
    echo "$file.bytes=$(stat -c %s "$DEST/$file")"
    echo "$file.sha256=$(sha256sum "$DEST/$file" | cut -d' ' -f1)"
  done
} > "$DEST/manifest.txt"

echo "done:"
sed 's/^/  /' "$DEST/manifest.txt"
