#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Pool } from "pg";
import { createBearerCredential } from "./auth.js";
import { loadConfig } from "./config.js";
import { runMigrations } from "./migrations.js";

const args = parseArgs(process.argv.slice(2));

if (!args.owner || !args.agent || !args.out) {
  throw new Error("usage: npm run provision:pilot-identity -w @agent-lobby/server -- --owner <display-name> --agent <agent-name> --out <0600-json-path> [--organization <name>] [--ttl-hours <hours>]");
}

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });

try {
  await runMigrations(pool);
  const organizationName = args.organization ?? "pilot-operator";
  const ttlHours = Number(args.ttlHours ?? "720");
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) throw new Error("--ttl-hours must be a positive number");

  const existingOrganization = await pool.query<{ id: string }>(
    "SELECT id FROM organizations WHERE name = $1 ORDER BY created_at ASC LIMIT 1",
    [organizationName]
  );
  const organization = existingOrganization.rows[0]
    ? existingOrganization
    : await pool.query<{ id: string }>("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [organizationName]);
  const organizationId = organization.rows[0]!.id;
  const owner = await pool.query<{ id: string }>(
    "INSERT INTO human_users (organization_id, display_name) VALUES ($1, $2) RETURNING id",
    [organizationId, args.owner]
  );
  const agent = await pool.query<{ id: string }>(
    "INSERT INTO agents (organization_id, human_owner_id, name) VALUES ($1, $2, $3) RETURNING id",
    [organizationId, owner.rows[0]!.id, args.agent]
  );
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60_000);
  const credential = await createBearerCredential(pool, { organizationId, agentId: agent.rows[0]!.id, expiresAt });

  const output = {
    organizationId,
    humanOwnerId: owner.rows[0]!.id,
    agentId: agent.rows[0]!.id,
    expiresAt: expiresAt.toISOString(),
    bearerToken: credential.token
  };
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, organizationId, humanOwnerId: output.humanOwnerId, agentId: output.agentId, credentialWrittenTo: args.out, expiresAt: output.expiresAt }));
} finally {
  await pool.end();
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item?.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${item}`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}
