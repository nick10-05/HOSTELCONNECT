#!/usr/bin/env bash
# Real recovery: loads the rows of a backup into a database that was just migrated
# and is still empty (e.g. a new Supabase project). Steps around it: docs/deploy.md.
#
#   ops/restore-data.sh <backup.dump.age> <age-private-key-file> <admin-database-url>
#
# The admin URL is the migration credential in libpq form (for Supabase: the session
# pooler with ?sslmode=require). Pass it in quotes. Migrations come first because they
# create the hostel_app role, the tables and the rights; this script adds only rows,
# so the backup must come from the same migration level as the code.
# Needs age and Docker. Run from Git Bash.
set -euo pipefail

if [ $# -ne 3 ]; then
  echo "Usage: $0 <backup.dump.age> <age-private-key-file> <admin-database-url>" >&2
  exit 2
fi
backup=$1
key=$2
export RESTORE_DATABASE_URL=$3
pg() { docker run --rm -i -e RESTORE_DATABASE_URL postgres:17-alpine sh -c "$1"; }

[ -f "$backup" ] || { echo "No such backup file: $backup" >&2; exit 1; }
[ -f "$key" ] || { echo "No such key file: $key" >&2; exit 1; }
command -v age >/dev/null || { echo "age is not installed (winget install FiloSottile.age)" >&2; exit 1; }

# Refuse to mix a backup into a database that already holds hostel data.
users=$(pg 'psql "$RESTORE_DATABASE_URL" -tAc "SELECT count(*) FROM users"')
if [ "$users" != "0" ]; then
  echo "The target database already has $users users. Restore only into an empty, freshly migrated database." >&2
  exit 1
fi

# The backup carries its own list of applied migrations; drop the fresh one so the
# rows from the backup can go in.
pg 'psql -q -v ON_ERROR_STOP=1 "$RESTORE_DATABASE_URL" -c "TRUNCATE schema_migrations"'

# One transaction: either every row goes in, or none does.
# Tables are loaded in name order (beds before rooms), which foreign keys would
# refuse. session_replication_role=replica skips those checks during the load, as
# Supabase's own restore guide does; the rows come from one consistent dump.
age --decrypt --identity "$key" "$backup" |
  pg 'PGOPTIONS="-c session_replication_role=replica" pg_restore --data-only --no-owner --single-transaction --exit-on-error -d "$RESTORE_DATABASE_URL"'

echo "Restored. Rows now in the database:"
pg 'psql "$RESTORE_DATABASE_URL" -c "SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM buildings) AS buildings, (SELECT count(*) FROM beds) AS beds, (SELECT count(*) FROM stays) AS stays, (SELECT max(name) FROM schema_migrations) AS last_migration"'
