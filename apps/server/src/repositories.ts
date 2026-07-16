import type { Pool, PoolClient } from "pg";
import { newPairingCode, sha256, stableJson } from "./crypto.js";
import type { Principal } from "./auth.js";


type Db = Pool | PoolClient;

export interface LobbyRecord {
  id: string;
  organizationId: string;
  purpose: string;
  limits: Record<string, unknown>;
  retentionPolicy: Record<string, unknown>;
  approvalPolicy: Record<string, unknown>;
  status: string;
  expiresAt: string;
  closeReason: string | null;
}

export interface CreateLobbyInput {
  purpose: string;
  limits: Record<string, unknown>;
  retentionPolicy: Record<string, unknown>;
  approvalPolicy: Record<string, unknown>;
  expiresAt: string;
}

export class ForbiddenError extends Error {}
export class ConflictError extends Error {}
export class BadRequestError extends Error {}

export interface MessageRecord {
  id: string;
  lobbyId: string;
  senderAgentId: string;
  recipientAgentId: string;
  sequence: number;
  contentDigest: string;
  acknowledgedAt: string | null;
  acknowledgedByAgentId: string | null;
}

export async function createLobby(pool: Pool, principal: Principal, input: CreateLobbyInput, idempotencyKey?: string): Promise<{ lobby: LobbyRecord; replayed: boolean }> {
  const requestHash = sha256(stableJson(input));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (idempotencyKey) {
      const existing = await client.query<{ response_body: { lobby: LobbyRecord }; request_hash: string }>(
        "SELECT request_hash, response_body FROM idempotency_keys WHERE organization_id = $1 AND agent_id = $2 AND idempotency_key = $3 FOR UPDATE",
        [principal.organizationId, principal.agentId, idempotencyKey]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw new ConflictError("idempotency key payload mismatch");
        await client.query("COMMIT");
        return { lobby: existing.rows[0].response_body.lobby, replayed: true };
      }
    }

    const lobbyResult = await client.query(
      `INSERT INTO lobbies (organization_id, purpose, limits, retention_policy, approval_policy, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, organization_id AS "organizationId", purpose, limits, retention_policy AS "retentionPolicy", approval_policy AS "approvalPolicy", status, expires_at AS "expiresAt", close_reason AS "closeReason"`,
      [principal.organizationId, input.purpose, input.limits, input.retentionPolicy, input.approvalPolicy, input.expiresAt]
    );
    const lobby = normalizeLobby(lobbyResult.rows[0]);
    await client.query(
      "INSERT INTO lobby_participants (lobby_id, agent_id, human_owner_id, role) VALUES ($1, $2, $3, 'initiator')",
      [lobby.id, principal.agentId, principal.humanOwnerId]
    );
    await client.query("UPDATE lobbies SET current_turn_agent_id = $2 WHERE id = $1", [lobby.id, principal.agentId]);
    await audit(client, principal.organizationId, lobby.id, "lobby.created", "agent", principal.agentId, { role: "initiator" });
    if (idempotencyKey) {
      await client.query(
        "INSERT INTO idempotency_keys (organization_id, agent_id, idempotency_key, request_hash, status_code, response_body) VALUES ($1, $2, $3, $4, 201, $5)",
        [principal.organizationId, principal.agentId, idempotencyKey, requestHash, { lobby }]
      );
    }
    await client.query("COMMIT");
    return { lobby, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}


export async function sendLobbyMessage(pool: Pool, principal: Principal, lobbyId: string, content: unknown, idempotencyKey?: string): Promise<{ message: MessageRecord; replayed: boolean }> {
  if (!idempotencyKey) throw new BadRequestError("idempotency-key is required");
  const requestHash = sha256(stableJson(content));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lobby = await client.query<{ current_turn_agent_id: string; next_sequence: string }>(
      `SELECT l.current_turn_agent_id, l.next_sequence
         FROM lobbies l JOIN lobby_participants p ON p.lobby_id = l.id AND p.agent_id = $2 AND p.left_at IS NULL
        WHERE l.id = $1 AND l.organization_id = $3 AND l.status = 'active' FOR UPDATE OF l`,
      [lobbyId, principal.agentId, principal.organizationId]
    );
    if (!lobby.rows[0]) throw new ForbiddenError("lobby not found or not authorized");

    const existing = await client.query<{ id: string; content_digest: string }>("SELECT id, content_digest FROM messages WHERE lobby_id = $1 AND sender_agent_id = $2 AND idempotency_key = $3", [lobbyId, principal.agentId, idempotencyKey]);
    if (existing.rows[0]) {
      if (existing.rows[0].content_digest !== requestHash) throw new ConflictError("idempotency key payload mismatch");
      await client.query("COMMIT");
      return { message: await getMessage(client, lobbyId, existing.rows[0].id), replayed: true };
    }

    const pending = await client.query("SELECT id FROM messages WHERE lobby_id = $1 AND acknowledged_at IS NULL FOR UPDATE", [lobbyId]);
    if (pending.rows[0]) throw new ConflictError("recipient acknowledgement is required before next message");
    if (lobby.rows[0].current_turn_agent_id !== principal.agentId) throw new ConflictError("agent does not own the current turn");
    const recipient = await client.query<{ agent_id: string }>("SELECT agent_id FROM lobby_participants WHERE lobby_id = $1 AND agent_id <> $2 AND left_at IS NULL", [lobbyId, principal.agentId]);
    if (!recipient.rows[0]) throw new ConflictError("lobby requires a recipient");
    const seq = Number(lobby.rows[0].next_sequence);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO messages (lobby_id, sender_agent_id, recipient_agent_id, sequence, content_digest, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [lobbyId, principal.agentId, recipient.rows[0].agent_id, seq, requestHash, idempotencyKey]
    );
    await client.query("UPDATE lobbies SET next_sequence = next_sequence + 1, updated_at = now() WHERE id = $1", [lobbyId]);
    await audit(client, principal.organizationId, lobbyId, "message.created", "agent", principal.agentId, { messageId: inserted.rows[0]!.id, sequence: seq, contentDigest: requestHash });
    const message = await getMessage(client, lobbyId, inserted.rows[0]!.id);
    await client.query("COMMIT");
    return { message, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function acknowledgeMessage(pool: Pool, principal: Principal, lobbyId: string, messageId: string, sequence: number): Promise<MessageRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const msg = await client.query<{ sequence: string; recipient_agent_id: string; acknowledged_at: Date | null }>(
      `SELECT m.sequence, m.recipient_agent_id, m.acknowledged_at
         FROM messages m JOIN lobbies l ON l.id = m.lobby_id
        WHERE m.id = $1 AND m.lobby_id = $2 AND l.organization_id = $3 FOR UPDATE OF m`,
      [messageId, lobbyId, principal.organizationId]
    );
    if (!msg.rows[0]) throw new ForbiddenError("message not found or not authorized");
    if (msg.rows[0].recipient_agent_id !== principal.agentId) throw new ForbiddenError("only the recipient can acknowledge delivery");
    if (Number(msg.rows[0].sequence) !== sequence) throw new ConflictError("acknowledgement sequence mismatch");
    if (!msg.rows[0].acknowledged_at) {
      await client.query("UPDATE messages SET acknowledged_at = now(), acknowledged_by_agent_id = $3 WHERE id = $1 AND lobby_id = $2", [messageId, lobbyId, principal.agentId]);
      await client.query("UPDATE lobbies SET current_turn_agent_id = $2, updated_at = now() WHERE id = $1", [lobbyId, principal.agentId]);
      await audit(client, principal.organizationId, lobbyId, "message.acknowledged", "agent", principal.agentId, { messageId, sequence });
    }
    const message = await getMessage(client, lobbyId, messageId);
    await client.query("COMMIT");
    return message;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function proposeAgreement(pool: Pool, principal: Principal, lobbyId: string, content: unknown, agreementId?: string): Promise<Record<string, unknown>> {
  const canonical = stableJson(content);
  const hash = sha256(canonical);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await getAuthorizedLobby(client, principal, lobbyId);
    let result;
    if (agreementId) {
      const latest = await client.query<{ version: number }>("SELECT version FROM agreements WHERE lobby_id = $1 AND id = $2 ORDER BY version DESC LIMIT 1 FOR UPDATE", [lobbyId, agreementId]);
      if (!latest.rows[0]?.version) throw new ForbiddenError("agreement not found");
      const version = latest.rows[0].version + 1;
      result = await client.query("INSERT INTO agreements (id, lobby_id, version, canonical_hash, structured_content, proposed_by_agent_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, version, canonical_hash AS \"canonicalHash\", structured_content AS content", [agreementId, lobbyId, version, hash, content, principal.agentId]);
      await client.query("UPDATE agreement_human_approvals SET invalidated_at = now() WHERE agreement_id = $1 AND lobby_id = $2 AND invalidated_at IS NULL", [agreementId, lobbyId]);
    } else {
      result = await client.query("INSERT INTO agreements (lobby_id, version, canonical_hash, structured_content, proposed_by_agent_id) VALUES ($1, 1, $2, $3, $4) RETURNING id, version, canonical_hash AS \"canonicalHash\", structured_content AS content", [lobbyId, hash, content, principal.agentId]);
    }
    await audit(client, principal.organizationId, lobbyId, "agreement.version_proposed", "agent", principal.agentId, { agreementId: result.rows[0]!.id, version: result.rows[0]!.version, canonicalHash: hash });
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function approveAgreement(pool: Pool, principal: Principal, lobbyId: string, agreementId: string, input: { version: number; canonicalHash: string }): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await getAuthorizedLobby(client, principal, lobbyId);
    const latest = await client.query<{ version: number; canonical_hash: string }>("SELECT version, canonical_hash FROM agreements WHERE lobby_id = $1 AND id = $2 ORDER BY version DESC LIMIT 1 FOR UPDATE", [lobbyId, agreementId]);
    if (!latest.rows[0]) throw new ForbiddenError("agreement not found");
    if (latest.rows[0].version !== input.version || latest.rows[0].canonical_hash !== input.canonicalHash) throw new ConflictError("agreement version/hash mismatch or stale approval");
    await client.query(
      `INSERT INTO agreement_human_approvals (agreement_id, agreement_version, lobby_id, human_owner_id, canonical_hash, approved_by_agent_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (agreement_id, agreement_version, human_owner_id) DO UPDATE SET canonical_hash = EXCLUDED.canonical_hash, approved_by_agent_id = EXCLUDED.approved_by_agent_id, invalidated_at = NULL, created_at = now()`,
      [agreementId, input.version, lobbyId, principal.humanOwnerId, input.canonicalHash, principal.agentId]
    );
    const count = await client.query<{ count: number }>("SELECT count(DISTINCT human_owner_id)::int AS count FROM agreement_human_approvals WHERE lobby_id = $1 AND agreement_id = $2 AND agreement_version = $3 AND canonical_hash = $4 AND invalidated_at IS NULL", [lobbyId, agreementId, input.version, input.canonicalHash]);
    const fullyApproved = (count.rows[0]?.count ?? 0) >= 2;
    if (fullyApproved) await client.query("UPDATE lobbies SET status = 'closed', close_reason = 'agreement_approved', updated_at = now() WHERE id = $1", [lobbyId]);
    await audit(client, principal.organizationId, lobbyId, "agreement.approved", "human", principal.humanOwnerId, { agreementId, version: input.version, canonicalHash: input.canonicalHash, fullyApproved });
    await client.query("COMMIT");
    return { agreementId, version: input.version, canonicalHash: input.canonicalHash, fullyApproved };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listAuthorizedLobbies(pool: Pool, principal: Principal): Promise<LobbyRecord[]> {
  const result = await pool.query(
    `SELECT l.id, l.organization_id AS "organizationId", l.purpose, l.limits, l.retention_policy AS "retentionPolicy",
            l.approval_policy AS "approvalPolicy", l.status, l.expires_at AS "expiresAt", l.close_reason AS "closeReason"
       FROM lobbies l
       JOIN lobby_participants p ON p.lobby_id = l.id AND p.agent_id = $1 AND p.left_at IS NULL
      WHERE l.organization_id = $2
      ORDER BY l.updated_at DESC, l.created_at DESC
      LIMIT 100`,
    [principal.agentId, principal.organizationId]
  );
  return result.rows.map(normalizeLobby);
}

export async function cancelLobby(pool: Pool, principal: Principal, lobbyId: string, reason: string): Promise<LobbyRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await getAuthorizedLobby(client, principal, lobbyId);
    const result = await client.query(
      `UPDATE lobbies SET status = 'cancelled', close_reason = $4, updated_at = now()
        WHERE id = $1 AND organization_id = $2 AND status <> ALL($3)
        RETURNING id, organization_id AS "organizationId", purpose, limits, retention_policy AS "retentionPolicy", approval_policy AS "approvalPolicy", status, expires_at AS "expiresAt", close_reason AS "closeReason"`,
      [lobbyId, principal.organizationId, ["closed", "cancelled", "expired"], reason.slice(0, 200)]
    );
    if (!result.rows[0]) throw new ConflictError("lobby is already terminal");
    await audit(client, principal.organizationId, lobbyId, "lobby.cancelled", "agent", principal.agentId, { reason });
    await client.query("COMMIT");
    return normalizeLobby(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listAuditEvents(pool: Pool, principal: Principal, lobbyId: string, sinceId?: string): Promise<Array<Record<string, unknown>>> {
  await getAuthorizedLobby(pool, principal, lobbyId);
  const result = await pool.query(
    `SELECT id, event_type AS "type", actor_type AS "actorType", actor_id AS "actorId", metadata, created_at AS "createdAt"
       FROM audit_events
      WHERE lobby_id = $1
        AND organization_id = $2
        AND ($3::uuid IS NULL OR (created_at, id) > (SELECT created_at, id FROM audit_events WHERE id = $3::uuid))
      ORDER BY created_at ASC, id ASC
      LIMIT 200`,
    [lobbyId, principal.organizationId, sinceId ?? null]
  );
  return result.rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt).toISOString() }));
}

async function getMessage(db: Db, lobbyId: string, messageId: string): Promise<MessageRecord> {
  const result = await db.query(
    `SELECT id, lobby_id AS "lobbyId", sender_agent_id AS "senderAgentId", recipient_agent_id AS "recipientAgentId", sequence::int,
            content_digest AS "contentDigest", acknowledged_at AS "acknowledgedAt", acknowledged_by_agent_id AS "acknowledgedByAgentId"
       FROM messages WHERE lobby_id = $1 AND id = $2`,
    [lobbyId, messageId]
  );
  if (!result.rows[0]) throw new ForbiddenError("message not found");
  const row = result.rows[0];
  return { ...row, acknowledgedAt: row.acknowledgedAt ? new Date(row.acknowledgedAt).toISOString() : null };
}

export async function getAuthorizedLobby(db: Db, principal: Principal, lobbyId: string): Promise<LobbyRecord> {
  const result = await db.query(
    `SELECT l.id, l.organization_id AS "organizationId", l.purpose, l.limits, l.retention_policy AS "retentionPolicy",
            l.approval_policy AS "approvalPolicy", l.status, l.expires_at AS "expiresAt", l.close_reason AS "closeReason"
       FROM lobbies l
       JOIN lobby_participants p ON p.lobby_id = l.id AND p.agent_id = $2 AND p.left_at IS NULL
      WHERE l.id = $1 AND l.organization_id = $3`,
    [lobbyId, principal.agentId, principal.organizationId]
  );
  const row = result.rows[0];
  if (!row) throw new ForbiddenError("lobby not found or not authorized");
  return normalizeLobby(row);
}

export async function createInvitation(pool: Pool, principal: Principal, lobbyId: string, input: { role: "counterparty"; expiresAt: string }): Promise<{ id: string; pairingCode: string; expiresAt: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await getAuthorizedLobby(client, principal, lobbyId);
    await client.query(
      "UPDATE lobby_invitations SET revoked_at = now() WHERE lobby_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL",
      [lobbyId]
    );
    const pairingCode = newPairingCode();
    const tokenHash = sha256(pairingCode);
    const result = await client.query<{ id: string; expiresAt: string }>(
      `INSERT INTO lobby_invitations (organization_id, lobby_id, created_by_agent_id, role, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, expires_at AS "expiresAt"`,
      [principal.organizationId, lobbyId, principal.agentId, input.role, tokenHash, input.expiresAt]
    );
    await audit(client, principal.organizationId, lobbyId, "invitation.created", "agent", principal.agentId, { invitationId: result.rows[0]!.id, role: input.role });
    await client.query("COMMIT");
    return { id: result.rows[0]!.id, pairingCode, expiresAt: new Date(result.rows[0]!.expiresAt).toISOString() };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function joinLobby(pool: Pool, principal: Principal, lobbyId: string, pairingCode: string): Promise<LobbyRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lobby = await client.query<{ organization_id: string; status: string }>("SELECT organization_id, status FROM lobbies WHERE id = $1 FOR UPDATE", [lobbyId]);
    if (!lobby.rows[0] || lobby.rows[0].organization_id !== principal.organizationId) throw new ForbiddenError("lobby not found or not authorized");

    const activeCount = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM lobby_participants WHERE lobby_id = $1 AND left_at IS NULL", [lobbyId]);
    if ((activeCount.rows[0]?.count ?? 0) >= 2) throw new ConflictError("lobby already has exactly two active participants");

    const invitation = await client.query<{ id: string; role: "counterparty" }>(
      `UPDATE lobby_invitations
          SET consumed_at = now(), consumed_by_agent_id = $3
        WHERE lobby_id = $1 AND token_hash = $2 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        RETURNING id, role`,
      [lobbyId, sha256(pairingCode), principal.agentId]
    );
    if (!invitation.rows[0]) throw new ConflictError("invitation is invalid, expired, revoked, or already consumed");

    await client.query(
      "INSERT INTO lobby_participants (lobby_id, agent_id, human_owner_id, role) VALUES ($1, $2, $3, $4)",
      [lobbyId, principal.agentId, principal.humanOwnerId, invitation.rows[0].role]
    );
    await client.query("UPDATE lobbies SET status = 'active', updated_at = now() WHERE id = $1", [lobbyId]);
    await audit(client, principal.organizationId, lobbyId, "invitation.consumed", "agent", principal.agentId, { invitationId: invitation.rows[0].id });
    await audit(client, principal.organizationId, lobbyId, "lobby.joined", "agent", principal.agentId, { role: invitation.rows[0].role });
    const updated = await getAuthorizedLobby(client, principal, lobbyId);
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string }).code === "23505") throw new ConflictError("participant role already filled");
    throw error;
  } finally {
    client.release();
  }
}

async function audit(db: Db, organizationId: string, lobbyId: string, eventType: string, actorType: "agent" | "human" | "system", actorId: string | null, metadata: Record<string, unknown>): Promise<void> {
  await db.query(
    "INSERT INTO audit_events (organization_id, lobby_id, event_type, actor_type, actor_id, metadata) VALUES ($1, $2, $3, $4, $5, $6)",
    [organizationId, lobbyId, eventType, actorType, actorId, metadata]
  );
}

function normalizeLobby(row: any): LobbyRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    purpose: row.purpose,
    limits: row.limits,
    retentionPolicy: row.retentionPolicy,
    approvalPolicy: row.approvalPolicy,
    status: row.status,
    expiresAt: new Date(row.expiresAt).toISOString(),
    closeReason: row.closeReason
  };
}

function normalizeApproval(row: any): Record<string, unknown> {
  return {
    id: row.id,
    lobbyId: row.lobbyId,
    requestedByAgentId: row.requestedByAgentId,
    targetAgentId: row.targetAgentId,
    humanOwnerId: row.humanOwnerId,
    state: row.state,
    type: row.type,
    question: row.question,
    reason: row.reason,
    expiresAt: new Date(row.expiresAt).toISOString()
  };
}
