export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  publicBaseUrl: string;
  metricsHost?: string;
  metricsPort?: number;
  liveDependencyChecks?: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const isProduction = nodeEnv === "production";
  const databaseUrl = env.DATABASE_URL ?? (isProduction ? undefined : "postgres://agent_lobby:agent_lobby_dev@localhost:5432/agent_lobby");
  const redisUrl = env.REDIS_URL ?? (isProduction ? undefined : "redis://localhost:6379");
  const publicBaseUrl = env.A2A_PUBLIC_BASE_URL ?? (isProduction ? undefined : "http://localhost:3000");
  if (!databaseUrl) throw new Error("DATABASE_URL is required in production");
  if (!redisUrl) throw new Error("REDIS_URL is required in production");
  if (!publicBaseUrl) throw new Error("A2A_PUBLIC_BASE_URL is required in production");
  if (isProduction) validateProductionEnv({ databaseUrl, redisUrl, publicBaseUrl, metricsHost: env.METRICS_HOST ?? "127.0.0.1" });

  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number.parseInt(env.PORT ?? "3000", 10),
    databaseUrl,
    redisUrl,
    publicBaseUrl,
    metricsHost: env.METRICS_HOST ?? "127.0.0.1",
    metricsPort: Number.parseInt(env.METRICS_PORT ?? "9100", 10),
    liveDependencyChecks: nodeEnv !== "test"
  };
}

function validateProductionEnv(input: { databaseUrl: string; redisUrl: string; publicBaseUrl: string; metricsHost: string }): void {
  const database = new URL(input.databaseUrl);
  const redis = new URL(input.redisUrl);
  const publicBase = new URL(input.publicBaseUrl);
  if (["localhost", "127.0.0.1", "0.0.0.0"].includes(database.hostname)) throw new Error("DATABASE_URL must use the internal Compose service name in production");
  if (database.password === "agent_lobby_dev") throw new Error("DATABASE_URL must not use the development database password in production");
  if (["localhost", "127.0.0.1", "0.0.0.0"].includes(redis.hostname)) throw new Error("REDIS_URL must use the internal Compose service name in production");
  if (publicBase.protocol !== "https:") throw new Error("A2A_PUBLIC_BASE_URL must use https in production");
  if (!["127.0.0.1", "::1", "localhost"].includes(input.metricsHost)) throw new Error("METRICS_HOST must remain private-only");
}
