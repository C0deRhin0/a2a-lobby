#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?set DATABASE_URL to the internal PostgreSQL URL}"
: "${BACKUP_DIR:=./backups}"

mkdir -p "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl --file "$BACKUP_DIR/agent_lobby_$timestamp.dump"
printf '%s\n' "$BACKUP_DIR/agent_lobby_$timestamp.dump"
