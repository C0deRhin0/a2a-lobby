# Self-hosting A2A Lobby

This repository ships portable deployment templates. Keep live configuration and secrets only on the host that operates the service.

## Local development

1. Install Node.js 22+, npm, Docker Engine, and Docker Compose v2.
2. Install dependencies with `npm ci`.
3. Start private development dependencies:

   ```bash
   POSTGRES_PASSWORD=agent_lobby_dev \
     A2A_PUBLIC_BASE_URL=http://localhost:3000 \
     docker compose -f compose.yml -f docker-compose.dev.yml up -d postgres redis
   ```

4. Run `npm run test`, `npm run typecheck`, and `npm run build`.
5. Stop the development services when finished:

   ```bash
   POSTGRES_PASSWORD=agent_lobby_dev \
     A2A_PUBLIC_BASE_URL=http://localhost:3000 \
     docker compose -f compose.yml -f docker-compose.dev.yml down -v --remove-orphans
   ```

## Self-hosted deployment

1. Copy `.env.production.example` to a local, untracked `.env.production` and replace every `<replace-with-...>` value with a generated secret.
2. Set `A2A_PUBLIC_BASE_URL` to your externally reachable HTTPS URL. For example, replace `https://a2a.example.com` with `https://your-domain.example` in the local environment file.
3. Ensure the hostname resolves to the host and an HTTPS/WSS-capable reverse proxy owns public ports 80 and 443.
4. Start the private application topology without an ingress proxy:

   ```bash
   set -a
   . ./.env.production
   set +a
   docker compose -f compose.yml up -d --build
   ```

   PostgreSQL and Redis have no host port mappings. The application is bound to `127.0.0.1:3000` for a host-side proxy.

5. If using Caddy, copy `ops/caddy/Caddyfile.example` to a local, untracked `ops/caddy/Caddyfile`, replace `a2a.example.com` with your hostname, and configure or run Caddy separately. The example proxies to `127.0.0.1:3000` and blocks `/metrics`.
6. Verify `https://your-domain.example/healthz`, `/readyz`, `/.well-known/agent-card.json`, `/openapi.json`, and `/mcp` through the proxy.
7. Back up PostgreSQL and perform an isolated restore verification before relying on the deployment.

## Validation without deployment

```bash
npm run test:portability
npm run compose:config:test
npm run compose:caddy:validate
```

These commands render or validate configuration only; they do not deploy, modify DNS, or start a public listener.
