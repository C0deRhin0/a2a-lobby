#!/usr/bin/env bash
set -euo pipefail

# Operator-only helper. Creates one owner+agent credential in the running production
# server container, copies the one-time secret to a local 0600 file, then removes the
# temporary container copy. Never print the bearer token to stdout.
if [[ $# -lt 8 ]]; then
  printf '%s\n' 'usage: ops/provision-production-pilot-identity.sh --organization <name> --owner <display-name> --agent <agent-name> --out <local-0600-json-path> [--ttl-hours <hours>]' >&2
  exit 64
fi

container="${A2A_LOBBY_SERVER_CONTAINER:-a2a-lobby-server-1}"
local_out=""
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      [[ $# -ge 2 ]] || { printf '%s\n' '--out requires a value' >&2; exit 64; }
      local_out="$2"
      args+=("$1" "/tmp/a2a-lobby-pilot-credential-$$.json")
      shift 2
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done

[[ -n "$local_out" ]] || { printf '%s\n' '--out is required' >&2; exit 64; }
[[ ! -e "$local_out" ]] || { printf '%s\n' "refusing to overwrite existing credential file: $local_out" >&2; exit 65; }
container_out='/tmp/a2a-lobby-pilot-credential-'$$'.json'
mkdir -p "$(dirname "$local_out")"
umask 077
cleanup() { docker exec "$container" rm -f "$container_out" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker exec "$container" node /app/apps/server/dist/provision-pilot-identity.js "${args[@]}"
docker cp "$container:$container_out" "$local_out"
chmod 600 "$local_out"
printf '%s\n' "credential created; secret stored only at $local_out"
