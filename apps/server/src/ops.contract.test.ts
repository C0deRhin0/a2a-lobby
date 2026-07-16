import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

describe("portable container topology", () => {
  it("does not publish PostgreSQL or Redis ports in portable compose", () => {
    const compose = read("compose.yml");
    const postgresBlock = compose.match(/  postgres:\n[\s\S]*?\n\n  redis:/)?.[0] ?? "";
    const redisBlock = compose.match(/  redis:\n[\s\S]*?\n\n  migrate:/)?.[0] ?? "";

    expect(postgresBlock).not.toMatch(/\n\s+ports:/);
    expect(redisBlock).not.toMatch(/\n\s+ports:/);
  });

  it("keeps local database/cache ports in the development override only", () => {
    const override = read("docker-compose.dev.yml");

    expect(override).toContain('"127.0.0.1:5432:5432"');
    expect(override).toContain('"127.0.0.1:6379:6379"');
  });

  it("provides a safe test compose override that removes development listener ports", () => {
    const testOverride = read("docker-compose.test.yml");

    expect(testOverride).toContain("ports: !override []");
    expect(testOverride).toContain("backup_verify:");
    expect(testOverride).toContain("RESTORE_DATABASE_URL=postgres://agent_lobby:agent_lobby_dev@postgres:5432/postgres");
  });

  it("runs the application as a non-root runtime user", () => {
    const dockerfile = read("apps/server/Dockerfile");

    expect(dockerfile).toMatch(/USER\s+node/);
    expect(dockerfile).not.toMatch(/USER\s+root/);
  });

  it("provides a portable Caddy example without embedding real secrets", () => {
    const caddy = read("ops/caddy/Caddyfile.example");

    expect(caddy).toContain("a2a.example.com");
    expect(caddy).toContain("reverse_proxy 127.0.0.1:3000");
    expect(caddy).not.toMatch(/password|token|secret/i);
  });

  it("documents Caddy example validation without starting public listeners", () => {
    const pkg = read("package.json");
    const docs = read("docs/production-ops.md");

    expect(pkg).toContain("compose:caddy:validate");
    expect(pkg).toContain("caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile");
    expect(docs).toContain("Validate the Caddyfile without starting public listeners");
  });

  it("documents backup and isolated restore verification scripts", () => {
    expect(read("ops/backup-postgres.sh")).toContain("pg_dump");
    expect(read("ops/verify-restore.sh")).toContain("agent_lobby_restore_verify");
    expect(read("docs/production-ops.md")).toContain("isolated restore verification");
  });
});
