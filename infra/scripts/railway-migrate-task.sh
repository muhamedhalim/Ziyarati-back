#!/bin/sh
# Railway Postgres -> AWS RDS data migration, executed INSIDE the one-off ECS task
# `zt-production-dbmigrate` (runbook: infra/runbooks/railway-to-aws-data-migration.md).
#
# SUPERSEDED 2026-10-08 (no real data on Railway; clean AWS deployment). NOT executed. Do not run without a new decision.
# NOT executed by anyone yet. The task gets, from Secrets Manager (never from git/overrides):
#   SRC_URL     Railway source connection string (read-only use; see guards)
#   PGPASSWORD  RDS master password;  PGHOST/PGUSER/PGDATABASE = the production RDS
#
# MODE (env, set by the launcher):
#   preflight  read-only checks on the SOURCE (version, size, extensions, migrations, P0.3 guards)
#   reset      DESTRUCTIVE on the TARGET (RDS) only: drop+recreate schema public, re-add extensions
#              requires CONFIRM_WIPE=wipe-rds-ziyarati
#   restore    pg_dump (source, read-only snapshot) -> /tmp -> pg_restore (target, extensions excluded)
#   counts     exact row counts per table on both sides + diff; non-zero exit if they differ
#   target-info  read-only summary of the TARGET
set -eu

MODE="${MODE:?MODE is required}"
: "${SRC_URL:?SRC_URL is required}"
: "${PGHOST:?}" "${PGUSER:?}" "${PGDATABASE:?}" "${PGPASSWORD:?}"

# ---- guards: the source is never RDS, the target is always the production RDS ------------
case "$PGHOST" in
  zt-production-pg.*.eu-central-1.rds.amazonaws.com) ;;
  *) echo "REFUSING: target host is not the production RDS" >&2; exit 2 ;;
esac
SRC_HOST="$(printf '%s' "$SRC_URL" | sed -E 's#^[a-z]+://[^@]*@([^:/?]+).*#\1#')"
case "$SRC_HOST" in
  *.rds.amazonaws.com|"$PGHOST"|"") echo "REFUSING: source host looks like the target or is unparsable" >&2; exit 2 ;;
esac
echo "source host: $SRC_HOST   target host: $PGHOST   mode: $MODE"

# Every session against the SOURCE is forced read-only at the server.
src_psql() { PGOPTIONS='-c default_transaction_read_only=on' psql "$SRC_URL" -v ON_ERROR_STOP=1 -P pager=off "$@"; }
dst_psql() { psql -v ON_ERROR_STOP=1 -P pager=off "$@"; }

t0="$(date +%s)"
elapsed() { echo "elapsed: $(( $(date +%s) - t0 ))s"; }

case "$MODE" in

preflight)
  src_psql -c "SELECT version()" \
           -c "SELECT current_setting('server_version_num')::int/10000 AS server_major" \
           -c "SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size" \
           -c "SELECT datname, pg_encoding_to_char(encoding) enc, datcollate, datctype FROM pg_database WHERE datname=current_database()" \
           -c "SELECT extname, extversion FROM pg_extension ORDER BY 1" \
           -c "SELECT count(*) AS tables FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'" \
           -c "SELECT (SELECT count(*) FROM pg_indexes WHERE schemaname='public') AS indexes, (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public') AS constraints, (SELECT count(*) FROM pg_constraint WHERE contype='x') AS exclusion_constraints" \
           -c "SELECT count(*) AS migrations_applied FROM migrations" \
           -c "SELECT name FROM migrations ORDER BY id DESC LIMIT 5" \
           -c "SELECT schemaname, relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 15" \
           -c "SELECT rolname, rolsuper FROM pg_roles WHERE rolname NOT LIKE 'pg\_%' ORDER BY 1" \
           -c "SELECT count(*) AS enc_whatsapp_tokens FROM whatsapp_accounts WHERE access_token LIKE 'enc:v1:%'" \
           -c "SELECT count(*) AS plaintext_whatsapp_tokens FROM whatsapp_accounts WHERE access_token IS NOT NULL AND access_token NOT LIKE 'enc:v1:%'"
  # Names of applied migrations, for the "source is a subset of the image" gate.
  src_psql -At -c "SELECT name FROM migrations ORDER BY id" > /tmp/src_migrations.txt
  echo "--- source migrations: $(wc -l < /tmp/src_migrations.txt) (names follow, for the subset gate)"
  cat /tmp/src_migrations.txt
  elapsed
  ;;

target-info)
  dst_psql -c "SELECT version()" \
           -c "SELECT count(*) AS tables FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'" \
           -c "SELECT count(*) AS migrations_applied FROM migrations" \
           -c "SELECT extname, extversion FROM pg_extension ORDER BY 1"
  ;;

reset)
  [ "${CONFIRM_WIPE:-}" = "wipe-rds-ziyarati" ] || { echo "REFUSING: CONFIRM_WIPE not set" >&2; exit 2; }
  echo "WIPING schema public on the TARGET ($PGHOST/$PGDATABASE) — the source is not touched"
  dst_psql <<'SQL'
DROP SCHEMA public CASCADE;
CREATE SCHEMA public AUTHORIZATION ziyarati_app;
GRANT ALL ON SCHEMA public TO ziyarati_app;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
SELECT extname, extversion FROM pg_extension ORDER BY 1;
SQL
  elapsed
  ;;

restore)
  echo "pg_dump client: $(pg_dump --version)"
  rm -f /tmp/zt.dump /tmp/restore.list
  # Consistent snapshot of the source, custom format, no owners/ACLs (RDS has its own roles).
  PGOPTIONS='-c default_transaction_read_only=on' \
    pg_dump -Fc --no-owner --no-acl -d "$SRC_URL" -f /tmp/zt.dump
  echo "dump size: $(du -h /tmp/zt.dump | cut -f1)"; elapsed
  # Extensions already exist on RDS (created by `reset`/bootstrap); restoring them needs superuser.
  pg_restore -l /tmp/zt.dump | grep -v ' EXTENSION ' > /tmp/restore.list
  pg_restore --exit-on-error --no-owner --no-acl --role=ziyarati_app \
             -L /tmp/restore.list -d "$PGDATABASE" /tmp/zt.dump
  elapsed
  dst_psql -c "ANALYZE" >/dev/null
  rm -f /tmp/zt.dump /tmp/restore.list     # no copy of the data survives the task
  echo "restore complete"; elapsed
  ;;

counts)
  gen="SELECT format('SELECT %L AS t, count(*) AS n FROM %I.%I', tablename, schemaname, tablename) FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
  src_psql -At -c "$gen" | while read -r q; do src_psql -At -F'|' -c "$q"; done > /tmp/src_counts.txt
  dst_psql -At -c "$gen" | while read -r q; do dst_psql -At -F'|' -c "$q"; done > /tmp/dst_counts.txt
  echo "source tables: $(wc -l < /tmp/src_counts.txt)  target tables: $(wc -l < /tmp/dst_counts.txt)"
  if diff /tmp/src_counts.txt /tmp/dst_counts.txt > /tmp/counts.diff; then
    echo "COUNTS MATCH for every table"; awk -F'|' '{s+=$2} END {print "total rows: " s}' /tmp/src_counts.txt
  else
    echo "COUNT MISMATCH (< source, > target):"; cat /tmp/counts.diff; exit 1
  fi
  elapsed
  ;;

*) echo "unknown MODE: $MODE" >&2; exit 2 ;;
esac
