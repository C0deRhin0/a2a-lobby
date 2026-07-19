#!/usr/bin/env sh
set -eu

export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-agent_lobby_dev}"
compose_files="-f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.test.yml"

docker compose $compose_files config >/dev/null
trap 'docker compose $compose_files down --volumes --remove-orphans' EXIT INT TERM
docker compose $compose_files up --build -d postgres redis
docker compose $compose_files run --rm migrate
docker compose $compose_files run --rm backup_verify
