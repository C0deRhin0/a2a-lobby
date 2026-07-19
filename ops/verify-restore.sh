#!/usr/bin/env sh
set -eu

: "${RESTORE_SOURCE:?set RESTORE_SOURCE to a pg_dump custom-format file}"
: "${RESTORE_DATABASE_URL:?set RESTORE_DATABASE_URL to an isolated PostgreSQL admin URL}"

restore_db="agent_lobby_restore_verify"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $restore_db;"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE $restore_db;"
target_url="${RESTORE_DATABASE_URL%/*}/$restore_db"
pg_restore --no-owner --no-acl --exit-on-error --dbname "$target_url" "$RESTORE_SOURCE"
psql "$target_url" -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE $restore_db;"
