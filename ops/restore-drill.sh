#!/usr/bin/env bash
# Restore drill: proves a backup can really be opened and loaded, without touching
# production or the development database.
#
#   ops/restore-drill.sh <backup.dump.age> <age-private-key-file> [--keep]
#
# Decrypts the backup, loads it into a fresh "restore_drill" database in the local
# Docker Postgres (docker compose up -d), prints the row count of every table, then
# drops the database again (--keep leaves it for a closer look).
# Needs age (Windows: winget install FiloSottile.age) and Docker. Run from Git Bash.
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <backup.dump.age> <age-private-key-file> [--keep]" >&2
  exit 2
fi
backup=$1
key=$2
keep=${3:-}
container=hostelconnect-db
db=restore_drill
psql_admin() { docker exec -i "$container" psql -q -v ON_ERROR_STOP=1 -U hostel_admin "$@"; }

[ -f "$backup" ] || { echo "No such backup file: $backup" >&2; exit 1; }
[ -f "$key" ] || { echo "No such key file: $key" >&2; exit 1; }
command -v age >/dev/null || { echo "age is not installed (winget install FiloSottile.age)" >&2; exit 1; }

echo "Creating an empty $db database..."
psql_admin -d postgres -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" -c "CREATE DATABASE $db"
# The backup creates the public schema itself, so the empty one goes first.
psql_admin -d "$db" -c "DROP SCHEMA public"

echo "Decrypting and loading $backup..."
# Decrypted data only passes through this pipe; it is never written to disk.
age --decrypt --identity "$key" "$backup" |
  docker exec -i "$container" pg_restore --exit-on-error --no-owner --no-privileges -U hostel_admin -d "$db"

echo
echo "Rows per table in the restored copy:"
psql_admin -d "$db" -c "
  SELECT c.relname AS table_name,
         (xpath('/row/n/text()',
                query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')
         ))[1]::text::int AS rows
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
  ORDER BY c.relname"
echo "Last migration in the backup:"
psql_admin -d "$db" -t -c "SELECT max(name) FROM schema_migrations"

if [ "$keep" = "--keep" ]; then
  echo "Kept: docker exec -it $container psql -U hostel_admin -d $db"
else
  psql_admin -d postgres -c "DROP DATABASE $db"
  echo "Drill passed; the $db database was dropped again."
fi
