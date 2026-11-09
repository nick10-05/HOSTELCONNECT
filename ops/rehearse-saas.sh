#!/usr/bin/env bash
# The multi-tenant rehearsal (phase 6), before deploying migrations 013 onward to
# production: restores a production backup into the local "restore_drill" database,
# runs the new migrations on it, and checks nothing was lost and everything is in
# hostel #1. Production is never touched.
#
#   ops/rehearse-saas.sh <backup.dump.age> <age-private-key-file>
#
# Needs what ops/restore-drill.sh needs (Docker, age, Git Bash) and server/.env with the
# local MIGRATION_DATABASE_URL and DATABASE_URL. Prints counts and checks only.
# The restore_drill database is kept afterwards for a closer look; drop it when done.
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <backup.dump.age> <age-private-key-file>" >&2
  exit 2
fi
here=$(cd "$(dirname "$0")" && pwd)

bash "$here/restore-drill.sh" "$1" "$2" --keep
echo
(cd "$here/../server" && npx tsx scripts/rehearse-saas.ts --database restore_drill)
echo
echo "Drop the copy when done:"
echo "  docker exec -i hostelconnect-db psql -U hostel_admin -d postgres -c \"DROP DATABASE restore_drill\""
