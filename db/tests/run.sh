#!/usr/bin/env bash
# Builds a fresh database from the migrations and seed, then runs the database tests.
# Usage: PGHOST=localhost PGUSER=postgres db/tests/run.sh
set -uo pipefail
cd "$(dirname "$0")/.."
DB=${TEST_DB:-shiftbook_test}
P="psql -X -v ON_ERROR_STOP=1 -q"
$P -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null 2>&1 || { echo "Can't reach Postgres"; exit 1; }
for f in migrations/*.sql; do $P -d $DB -f "$f" >/dev/null || { echo "Migration failed: $f"; exit 1; }; done
$P -d $DB -1 -f seed.sql >/dev/null || { echo "Seed failed"; exit 1; }
out=""
for t in tests/*_test.sql; do
  r=$($P -d $DB -f "$t" 2>&1); code=$?
  out+=$(grep -E "PASS|FAIL|ERROR" <<<"$r" | sed 's/^.*NOTICE:  //')$'\n'
  [ $code -ne 0 ] && out+="ERROR: $t stopped early"$'\n'
done
printf "%s" "$out" | sed '/^$/d'
pass=$(grep -c '^PASS' <<<"$out" || true); fail=$(grep -cE '^FAIL|ERROR' <<<"$out" || true)
echo "---- $pass passed, $fail failed"
[ "$fail" -eq 0 ]
