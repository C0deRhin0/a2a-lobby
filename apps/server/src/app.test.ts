import { describe, expect, it } from "vitest";
import { agentCardSchema } from "@agent-lobby/domain";
import { buildApp } from "./app.js";

const testConfig = {
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgres://agent_lobby:agent_lobby_dev@localhost:5432/agent_lobby",
  redisUrl: "redis://localhost:6379",
  publicBaseUrl: "http://localhost:3000/",
  metricsHost: "127.0.0.1",
  metricsPort: 9100
};

describe("server routes", () => {
  it("serves public no-secret onboarding and discovery documents", async () => {
    const app = await buildApp(testConfig);

    const root = await app.inject({ method: "GET", url: "/", headers: { accept: "text/plain" } });
    const guide = await app.inject({ method: "GET", url: "/agent-onboarding.md" });
    const discovery = await app.inject({ method: "GET", url: "/llms.txt" });

    for (const response of [root, guide, discovery]) {
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toContain("no-store");
      expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    }
    expect(root.headers["content-type"]).toContain("text/plain");
    expect(root.body).toContain("/.well-known/agent-card.json");
    expect(root.body).toContain("/mcp");
    expect(root.body).toContain("/openapi.json");
    expect(root.body).toContain("POST /v1/lobbies");
    expect(root.body).toContain("pairingCode");
    expect(root.body).toContain("Authorization: Bearer");
    expect(root.body).toContain("Never place credentials, pairing codes, or device codes in URLs");
    expect(guide.headers["content-type"]).toContain("text/markdown");
    expect(guide.body).toContain("# A2A Lobby agent onboarding");
    expect(guide.body).toContain("POST /v1/lobbies/{lobbyId}/join");
    expect(discovery.headers["content-type"]).toContain("text/plain");
    expect(discovery.body).toContain("/agent-onboarding.md");
    expect(discovery.body).toContain("/.well-known/agent-card.json");

    await app.close();
  });

  it("serves health and readiness probes", async () => {
    const app = await buildApp(testConfig);

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const ready = await app.inject({ method: "GET", url: "/readyz" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", service: "agent-lobby-server" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: "ok", dependencies: { postgres: "configured", redis: "configured" } });

    await app.close();
  });

  it("publishes a parseable A2A Agent Card at discovery location", async () => {
    const app = await buildApp(testConfig);

    const response = await app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(agentCardSchema.parse(body)).toMatchObject({
      protocolVersion: "1.0.1",
      url: "http://localhost:3000",
      authentication: { schemes: ["Bearer"] }
    });
    expect(body.extensions.map((extension: { uri: string }) => extension.uri)).toEqual([
      "https://agent-lobby.invalid/extensions/two-party-lobby/v1",
      "https://agent-lobby.invalid/extensions/human-approval/v1",
      "https://agent-lobby.invalid/extensions/bilateral-agreement/v1"
    ]);
    expect(body.description).toContain("/agent-onboarding.md");
    expect(body.skills[0].description).toContain("/openapi.json");

    await app.close();
  });

  it("serves a no-store, no-frame activation page without a bearer-token prompt", async () => {
    const app = await buildApp(testConfig);
    const response = await app.inject({ method: "GET", url: "/activate" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.body).toContain("Device code");
    expect(response.body).not.toContain("Bearer credential");

    await app.close();
  });
});
