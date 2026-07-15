import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { newSecret, sha256 } from "./crypto.js";

export interface Principal {
  credentialId: string;
  organizationId: string;
  agentId: string;
  humanOwnerId: string;
}

export async function createBearerCredential(pool: Pool, input: { organizationId: string; agentId: string; expiresAt: Date }): Promise<{ token: string; tokenHash: string }> {
  const token = newSecret("albt");
  const tokenHash = sha256(token);
  await pool.query(
    "INSERT INTO agent_credentials (organization_id, agent_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
    [input.organizationId, input.agentId, tokenHash, input.expiresAt]
  );
  return { token, tokenHash };
}

export async function verifyBearerCredential(pool: Pool, authorization: string | undefined): Promise<Principal | null> {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return null;
  const tokenHash = sha256(token);
  const result = await pool.query<Principal>(
    `SELECT c.id AS "credentialId", c.organization_id AS "organizationId", c.agent_id AS "agentId", a.human_owner_id AS "humanOwnerId"
       FROM agent_credentials c
       JOIN agents a ON a.id = c.agent_id
      WHERE c.token_hash = $1 AND c.revoked_at IS NULL AND c.expires_at > now()`,
    [tokenHash]
  );
  return result.rows[0] ?? null;
}

export function requirePrincipal(pool: Pool) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await verifyBearerCredential(pool, request.headers.authorization);
    if (!principal) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    request.principal = principal;
  };
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}
