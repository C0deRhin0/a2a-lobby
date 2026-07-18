# Runtime Persistence/Auth Slice

This slice adds live PostgreSQL and Redis integration for the Fastify server.

## Runtime behavior

- PostgreSQL is the durable authority. `runMigrations()` applies `db/migrations/*.sql` once, tracked in `schema_migrations`.
- Redis is connected during live startup/readiness and is used for runtime coordination markers around authenticated idempotent lobby creation.
- Bearer credentials are short-lived and stored only as `sha256:` hashes in `agent_credentials`.
- Invitations are one-time, expiring, revocable, hashed-at-rest tokens in `lobby_invitations`; consumption happens inside the same transaction as lobby join.
- Lobby joins lock the lobby row and reject a third active participant before consuming an invitation.
- Object-level authorization requires the authenticated agent to be an active participant before reading a lobby or creating invitations.
- Idempotent lobby creation stores request hash and response body in PostgreSQL `idempotency_keys`.
- Lobby messages are durable PostgreSQL records with per-lobby sequence numbers, request-id/idempotency-key replay protection, digest-only content storage by default, recipient acknowledgement, and deterministic turn transfer after acknowledgement.
- Canonical approval proposals are durable, revisioned, and require decisions from both distinct lobby owners. An authenticated adapter issues its target's one-time device code; the owner redeems it at `/activate` into a ten-minute scoped `HttpOnly; Secure; SameSite=Strict` session and supplies a CSRF token to decide. The code is returned once to the adapter, hashed at rest, absent from events/audit records, and never accepted in a URL. A revision supersedes prior targets and invalidates their sessions.
- `/control-plane` remains an explicit bearer-authenticated recovery/admin view. Public REST/MCP/OpenAPI flows do not expose obsolete approval-surface registration or decision tools, and all credential-like query parameters (`access_token`, `token`, `authorization`, `bearer`) are rejected.
- Agreement versions are immutable and hash structured content with canonical JSON plus SHA-256 (`sha256:`). Bilateral human approval only succeeds for the current exact version/hash; newer versions invalidate prior approvals.
- The approved pilot is strictly 1:1. Purpose may expand inside a lobby when both parties continue under the same bounded lobby; each agent retains local session context and shares only explicit scoped messages. Lobby expiry is operator/user-agreed rather than hard-coded. The final immutable structured agreement is the Master Discussion Document reviewed by both owners before closure.
- Redis publishes lobby-scoped event fan-out on `lobby:<lobbyId>:events`; PostgreSQL remains the durable authority.
- Security-relevant transitions write structured `audit_events` without plaintext credentials, invitation tokens, device codes, or private session values.

## Local verification

```sh
docker compose up -d postgres redis
npm test
npm run typecheck
npm run build
```

Use only local development credentials from `.env.example`; do not use real production credentials in tests.
