#!/usr/bin/env sh
# Create and validate one PostgreSQL logical backup from the live A2A Lobby
# Compose stack. This script intentionally does not prune archives: retention
# deletion must be explicitly enabled in a future approved policy.
set -eu

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-a2a-lobby}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-$PROJECT_ROOT/.env.production}"
BACKUP_DIR="${BACKUP_DIR:-/home/hermes/backups/a2a-lobby/postgres}"

if [ ! -f "$COMPOSE_ENV_FILE" ]; then
  printf '%s\n' "missing Compose environment file: $COMPOSE_ENV_FILE" >&2
  exit 1
fi

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$BACKUP_DIR/agent_lobby_${timestamp}.dump"
temporary="$archive.partial"
checksum="$archive.sha256"

cleanup() {
  rm -f "$temporary"
}
trap cleanup EXIT HUP INT TERM

compose() {
  docker compose --env-file "$COMPOSE_ENV_FILE" -p "$COMPOSE_PROJECT" -f "$PROJECT_ROOT/docker-compose.yml" "$@"
}

compose exec -T postgres pg_isready -U agent_lobby -d agent_lobby >/dev/null
compose exec -T postgres pg_dump \
  -U agent_lobby \
  -d agent_lobby \
  --format=custom \
  --no-owner \
  --no-acl >"$temporary"

# Validate that pg_restore can parse the completed custom-format archive before
# exposing it as a usable backup. No production data is restored here.
compose exec -T postgres pg_restore --list <"$temporary" >/dev/null
mv "$temporary" "$archive"
sha256sum "$archive" >"$checksum"
printf 'backup_ok archive=%s checksum=%s\n' "$archive" "$checksum"
