import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("configuration validation", () => {
  const prodEnv = {
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    PORT: "3000",
    DATABASE_URL: "postgres://agent_lobby:strong-password@postgres:5432/agent_lobby",
    REDIS_URL: "redis://redis:6379",
    A2A_PUBLIC_BASE_URL: "https://a2a.example.com",
    METRICS_HOST: "127.0.0.1"
  };

  it("rejects missing production secrets and localhost service URLs", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...prodEnv, DATABASE_URL: "postgres://agent_lobby:agent_lobby_dev@postgres:5432/agent_lobby" })).toThrow(/development database password/);
    expect(() => loadConfig({ ...prodEnv, REDIS_URL: "redis://localhost:6379" })).toThrow(/REDIS_URL/);
  });

  it("accepts explicit production configuration with private-only metrics", () => {
    expect(loadConfig(prodEnv)).toMatchObject({
      publicBaseUrl: "https://a2a.example.com",
      metricsHost: "127.0.0.1",
      liveDependencyChecks: true
    });
  });
});
