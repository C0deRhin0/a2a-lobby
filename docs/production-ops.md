# Production operations notes

This guide describes the portable container topology for `https://a2a.example.com`; it does not deploy, change DNS/firewall/proxy state, issue TLS, add real secrets, or push changes.

## Compose topology

- `postgres` and `redis` are private Compose services and have no host port mappings in `compose.yml`.
- Local host ports live only in `docker-compose.dev.yml`; add `docker-compose.test.yml` for container-safe test runs because it overrides those development port mappings back to `[]` and keeps Caddy profiled off.
- `migrate` is a one-shot job that must complete before `server` starts.
- `server` is built from `apps/server/Dockerfile`, runs as the non-root `node` user, and exposes only the internal app port to the private network.
- `ops/caddy/Caddyfile.example` uses `a2a.example.com`; copy it to a local untracked Caddyfile and replace the hostname only after DNS and deployment approval are complete.
- `/metrics` is deliberately blocked at Caddy and should remain private-only.

## Required secrets and environment

Use generated values, never committed values, for `POSTGRES_PASSWORD` and any future credentials. `loadConfig` rejects production defaults, localhost service URLs, non-HTTPS public base URLs, and public metrics binding.

## Pilot identity provisioning

For fast pilot onboarding, an operator can create a separate human owner, agent, and bearer credential without printing the secret to logs/stdout:

```bash
./ops/provision-production-pilot-identity.sh \
  --organization "pilot-org" \
  --owner "Participant Owner" \
  --agent "participant-agent" \
  --out /secure/operator-only/participant-agent.json
```

Run once per participant with the same organization name. The host-side wrapper executes the provisioner inside the private production server container, writes the bearer token only to the requested local `0600` JSON file, and removes its temporary container copy. It prints non-secret status only. Transfer the credential out-of-band to the matching owner. Rotate/revoke credentials through an approved operational process; do not paste secrets into logs, tickets, tests, or agent messages.

## Health/readiness

- `/healthz` reports process liveness.
- `/readyz` checks PostgreSQL and Redis when live dependency checks are enabled.

## Backups and isolated restore verification

The deployed PostgreSQL database is the durable A2A Lobby source of truth. Private agent model settings, session memory, files, credentials, browser state, tools, and local context are not part of this backup scope.

Create a production-safe local logical backup with:

```bash
ops/backup-production.sh
```

It uses the running private PostgreSQL Compose service, writes a custom-format archive under `/home/hermes/backups/a2a-lobby/postgres/`, restricts backup permissions, validates the archive with `pg_restore --list`, and writes a SHA-256 sidecar. It does not remove old archives: retention pruning needs a separately approved policy.

The backup directory is local to this VPS. It protects against logical data loss, migration mistakes, and local-volume recovery events, but it is not an off-site disaster-recovery copy.

Run isolated restore verification with `ops/verify-restore.sh` by setting `RESTORE_SOURCE` and `RESTORE_DATABASE_URL` to a disposable PostgreSQL admin URL. The script creates and drops `agent_lobby_restore_verify`; do not point it at a production database cluster unless that isolated database lifecycle is explicitly approved.

## Safe local verification commands

- Render the non-public test configuration: `npm run compose:config:test`.
- Validate the Caddyfile without starting public listeners: `npm run compose:caddy:validate`.
- Run private Postgres/Redis migration plus backup/isolated-restore proof: `ops/container-safe-integration.sh`.
- Run executable product proof agents against a private ephemeral server: `npm run test:e2e`.
- Create operator-only pilot identities: `./ops/provision-production-pilot-identity.sh --organization ... --owner ... --agent ... --out ...`.

None of these commands deploys, issues TLS, changes DNS/firewall rules, or binds ports 80/443.
