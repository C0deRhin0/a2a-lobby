#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Pool } from "pg";
import { buildApp } from "../../apps/server/src/app.js";
import { createBearerCredential } from "../../apps/server/src/auth.js";
import { runMigrations } from "../../apps/server/src/migrations.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://agent_lobby:agent_lobby_dev@localhost:5432/agent_lobby";
const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://localhost:6379";
const runId = randomUUID();
const workspace = join(process.cwd(), ".tmp-product-proof", runId);
mkdirSync(workspace, { recursive: true });

const pool = new Pool({ connectionString: databaseUrl });
const organizationIds: string[] = [];
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

try {
  await runMigrations(pool);
  const seed = await seedIdentities(runId);
  organizationIds.push(seed.organizationId);
  const initiatorCredential = await createBearerCredential(pool, { organizationId: seed.organizationId, agentId: seed.initiatorAgentId, expiresAt: new Date(Date.now() + 10 * 60_000) });
  const counterpartyCredential = await createBearerCredential(pool, { organizationId: seed.organizationId, agentId: seed.counterpartyAgentId, expiresAt: new Date(Date.now() + 10 * 60_000) });

  app = await buildApp({ host: "127.0.0.1", port: 0, databaseUrl, redisUrl, publicBaseUrl: "http://127.0.0.1:0", metricsHost: "127.0.0.1", metricsPort: 9100, liveDependencyChecks: true });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (typeof address !== "object" || !address) throw new Error("private test server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const commonEnv = { ...process.env, AGENT_LOBBY_BASE_URL: baseUrl, AGENT_LOBBY_HANDOFF: join(workspace, "handoff.json") };
  const tsStore = join(workspace, "ts-session-store.json");
  const pyStore = join(workspace, "py-session-store.json");

  await runTsAgent({ ...commonEnv, AGENT_LOBBY_TOKEN: initiatorCredential.token, AGENT_LOBBY_SESSION_STORE: tsStore, AGENT_LOBBY_STAGE: "initiator-create" });
  await run("python3", ["examples/reference-agents/python_agent.py"], { ...commonEnv, AGENT_LOBBY_TOKEN: counterpartyCredential.token, AGENT_LOBBY_SESSION_STORE: pyStore, AGENT_LOBBY_STAGE: "counterparty-join" });
  await runTsAgent({ ...commonEnv, AGENT_LOBBY_TOKEN: initiatorCredential.token, AGENT_LOBBY_SESSION_STORE: tsStore, AGENT_LOBBY_STAGE: "initiator-message-approval-agreement", COUNTERPARTY_AGENT_ID: seed.counterpartyAgentId });
  await run("python3", ["examples/reference-agents/python_agent.py"], { ...commonEnv, AGENT_LOBBY_TOKEN: counterpartyCredential.token, AGENT_LOBBY_SESSION_STORE: pyStore, AGENT_LOBBY_STAGE: "counterparty-ack-decide", HUMAN_DECISION: "approved" });
  await runTsAgent({ ...commonEnv, AGENT_LOBBY_TOKEN: initiatorCredential.token, AGENT_LOBBY_SESSION_STORE: tsStore, AGENT_LOBBY_STAGE: "initiator-finalize" });
  await run("python3", ["examples/reference-agents/python_agent.py"], { ...commonEnv, AGENT_LOBBY_TOKEN: counterpartyCredential.token, AGENT_LOBBY_SESSION_STORE: pyStore, AGENT_LOBBY_STAGE: "counterparty-approve-agreement" });

  const handoff = JSON.parse(readFileSync(join(workspace, "handoff.json"), "utf8"));
  if (handoff.humanDecision?.state !== "approved") throw new Error("authenticated web-style human decision was not approved");
  if (handoff.counterpartyAgreementApproval?.fullyApproved !== true) throw new Error("bilateral agreement approval did not close");
  const finalLobby = await app.inject({ method: "GET", url: `/v1/lobbies/${handoff.lobbyId}`, headers: { authorization: `Bearer ${initiatorCredential.token}` } });
  if (finalLobby.json().status !== "closed") throw new Error(`expected closed lobby, got ${finalLobby.body}`);
  await app.close();
  app = undefined;
  console.log(JSON.stringify({ ok: true, privateBaseUrl: baseUrl, lobbyId: handoff.lobbyId, stores: [tsStore, pyStore] }));
} finally {
  for (const organizationId of organizationIds) await cleanupOrganization(organizationId).catch(() => undefined);
  if (app) await app.close().catch(() => undefined);
  await pool.end();
  rmSync(workspace, { recursive: true, force: true });
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(command, args, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000);
  const exit = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (status, signal) => resolve({ status, signal }));
  });
  clearTimeout(timeout);
  if (exit.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed status=${exit.status} signal=${exit.signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  process.stdout.write(stdout);
}

async function runTsAgent(env: NodeJS.ProcessEnv): Promise<void> {
  await run(process.execPath, ["node_modules/tsx/dist/cli.mjs", "examples/reference-agents/typescript-agent.ts"], env);
}

async function seedIdentities(suffix: string) {
  const organization = await pool.query<{ id: string }>("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [`e2e-${suffix}`]);
  const organizationId = organization.rows[0]!.id;
  const humanA = await pool.query<{ id: string }>("INSERT INTO human_users (organization_id, display_name) VALUES ($1, $2) RETURNING id", [organizationId, "TypeScript Owner"]);
  const humanB = await pool.query<{ id: string }>("INSERT INTO human_users (organization_id, display_name) VALUES ($1, $2) RETURNING id", [organizationId, "Python Owner"]);
  const initiator = await pool.query<{ id: string }>("INSERT INTO agents (organization_id, human_owner_id, name) VALUES ($1, $2, $3) RETURNING id", [organizationId, humanA.rows[0]!.id, "typescript-reference-agent"]);
  const counterparty = await pool.query<{ id: string }>("INSERT INTO agents (organization_id, human_owner_id, name) VALUES ($1, $2, $3) RETURNING id", [organizationId, humanB.rows[0]!.id, "python-reference-agent"]);
  return { organizationId, initiatorAgentId: initiator.rows[0]!.id, counterpartyAgentId: counterparty.rows[0]!.id };
}

async function cleanupOrganization(organizationId: string): Promise<void> {
  await pool.query("DELETE FROM audit_events WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM idempotency_keys WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM lobbies WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM agent_credentials WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM agents WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM human_users WHERE organization_id = $1", [organizationId]);
  await pool.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
}
