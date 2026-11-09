#!/usr/bin/env bash
# VERTIGO harness — backups of the transaction store (PV-WRITE-001 / W1.10).
#
# The Postgres journal holds what the harness itself proved: plans, write journal, receipts, events. Notion stays
# the durable business truth, but losing this store loses the evidence of every verified transaction and the
# executor's memory of what it already sent. It is dumped daily and a dump is only trusted once restored.
#
#   deploy/backup.sh              dump now (pg_dump -Fc), check the archive, prune dumps older than the retention
#   deploy/backup.sh --check FILE restore FILE into a throwaway database, print its row counts, drop it
#
# Run it ON THE SERVER from the repository root (cron: deploy/backup.cron). The database runs in the compose
# `db` service; nothing here reads or prints a credential.
#   VERTIGO_BACKUP_DIR             where dumps go (default /var/backups/vertigo-harness — outside the repository)
#   VERTIGO_BACKUP_RETENTION_DAYS  default 14
#   VERTIGO_PG_LOCAL=1             use the local Postgres client tools instead of the compose service (tests only)
#   VERTIGO_PG_DB / VERTIGO_PG_USER  database and role (default vertigo_harness / vertigo)
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${VERTIGO_BACKUP_DIR:-/var/backups/vertigo-harness}"
RETENTION_DAYS="${VERTIGO_BACKUP_RETENTION_DAYS:-14}"
DB="${VERTIGO_PG_DB:-vertigo_harness}"
PGUSER_NAME="${VERTIGO_PG_USER:-vertigo}"

# One way in to the Postgres tools: the compose service on the server, the local binaries in tests.
pg() {
  if [ "${VERTIGO_PG_LOCAL:-}" = "1" ]; then "$@"; else (cd deploy && docker compose --env-file .env exec -T db "$@"); fi
}
# The role is named explicitly on the server; locally the current OS user is the default role unless one is given.
U=(-U "$PGUSER_NAME")
if [ "${VERTIGO_PG_LOCAL:-}" = "1" ] && [ -z "${VERTIGO_PG_USER:-}" ]; then U=(); fi

counts() {
  pg psql ${U[@]+"${U[@]}"} -d "$1" -At -F ' ' -c "
    select 'plans', count(*) from plans
    union all select 'receipts', count(*) from receipts
    union all select 'events', count(*) from transaction_events
    union all select 'plan_writes', (to_regclass('plan_writes') is not null)::int"
}

if [ "${1:-}" = "--check" ]; then
  FILE="${2:?usage: deploy/backup.sh --check FILE}"
  [ -s "$FILE" ] || { echo "backup check: $FILE is missing or empty"; exit 1; }
  SCRATCH="vertigo_restore_check_$(date -u +%Y%m%d%H%M%S)_$$"
  pg createdb ${U[@]+"${U[@]}"} "$SCRATCH"
  trap 'pg dropdb ${U[@]+"${U[@]}"} --if-exists "$SCRATCH" >/dev/null 2>&1 || true' EXIT
  pg pg_restore ${U[@]+"${U[@]}"} -d "$SCRATCH" --no-owner --no-privileges --exit-on-error < "$FILE"
  echo "restored $(basename "$FILE") into a throwaway database; row counts:"
  counts "$SCRATCH" | while read -r name n; do
    if [ "$name" = "plan_writes" ]; then echo "  plan_writes table: $([ "$n" = 1 ] && echo present || echo absent)"; else echo "  $name: $n"; fi
  done
  exit 0
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/vertigo_harness-$STAMP.dump"
# Written aside, checked, then renamed: a dump that is present is a dump that is complete.
pg pg_dump ${U[@]+"${U[@]}"} -d "$DB" -Fc > "$OUT.partial"
[ -s "$OUT.partial" ] || { rm -f "$OUT.partial"; echo "backup: empty dump, nothing kept"; exit 1; }
pg_restore --list "$OUT.partial" >/dev/null 2>&1 || pg pg_restore --list < "$OUT.partial" >/dev/null || { rm -f "$OUT.partial"; echo "backup: the dump is not a readable archive, nothing kept"; exit 1; }
mv "$OUT.partial" "$OUT"
chmod 600 "$OUT"
find "$BACKUP_DIR" -maxdepth 1 -name 'vertigo_harness-*.dump' -mtime +"$RETENTION_DAYS" -delete
echo "backup: $(basename "$OUT") ($(du -h "$OUT" | cut -f1)); $(find "$BACKUP_DIR" -maxdepth 1 -name 'vertigo_harness-*.dump' | wc -l | tr -d ' ') dump(s) kept, ${RETENTION_DAYS} days retention"
