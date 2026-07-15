import type { Pool, PoolClient } from "pg";
import { newPairingCode, newSecret, sha256, stableJson } from "./crypto.js";
import type { Principal } from "./auth.js";
import { BadRequestError, ConflictError, ForbiddenError } from "./repositories.js";

type Db = Pool | PoolClient;
const SESSION_TTL_MS = 10 * 60_000;
const ACTIVATION_TTL_MS = 10 * 60_000;
const ACTIVATION_LIMIT = 3;
const ACTIVATION_WINDOW = "1 minute";
type Decision = "approved" | "rejected" | "changes_requested";

export async function createApprovalProposal(pool: Pool, principal: Principal, lobbyId: string, input: { type: string; question: string; reason: string; expiresAt: string; content?: Record<string, unknown>; proposalId?: string }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const participants = await client.query<{ agent_id: string; human_owner_id: string }>(`SELECT p.agent_id, p.human_owner_id FROM lobby_participants p JOIN lobbies l ON l.id = p.lobby_id WHERE p.lobby_id = $1 AND p.left_at IS NULL AND l.organization_id = $2 FOR UPDATE`, [lobbyId, principal.organizationId]);
    if (participants.rows.length !== 2 || new Set(participants.rows.map((p) => p.human_owner_id)).size !== 2 || !participants.rows.some((p) => p.agent_id === principal.agentId)) throw new ForbiddenError("a proposal requires exactly two participating agents with distinct owners");
    const current = input.proposalId
      ? await client.query<{ id: string; revision: number }>("SELECT id, revision FROM approval_proposals WHERE lobby_id = $1 AND id = $2 AND state NOT IN ('superseded', 'cancelled', 'expired') ORDER BY revision DESC LIMIT 1 FOR UPDATE", [lobbyId, input.proposalId])
      : await client.query<{ id: string; revision: number }>("SELECT id, revision FROM approval_proposals WHERE lobby_id = $1 AND state IN ('requested', 'awaiting_both_owners', 'partially_approved', 'pending') ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [lobbyId]);
    if (input.proposalId && !current.rows[0]) throw new ConflictError("approval proposal cannot be revised");
    if (current.rows[0]) await supersedeRevision(client, current.rows[0].id, current.rows[0].revision);
    const structuredContent = input.content ?? { type: input.type, question: input.question, reason: input.reason };
    const canonicalHash = sha256(stableJson(structuredContent));
    const revision = current.rows[0] ? current.rows[0].revision + 1 : 1;
    const proposal = await client.query<{ id: string; revision: number; canonical_hash: string; state: string; expires_at: string }>(`INSERT INTO approval_proposals (id, lobby_id, revision, canonical_hash, structured_content, requested_by_agent_id, expires_at, state) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, 'requested') RETURNING id, revision, canonical_hash, state, expires_at`, [current.rows[0]?.id ?? null, lobbyId, revision, canonicalHash, structuredContent, principal.agentId, input.expiresAt]);
    for (const participant of participants.rows) await client.query("INSERT INTO approval_decision_targets (proposal_id, proposal_revision, target_agent_id, human_owner_id) VALUES ($1, $2, $3, $4)", [proposal.rows[0]!.id, revision, participant.agent_id, participant.human_owner_id]);
    const checkpoint = await client.query<{ id: string; state: string }>("INSERT INTO approval_checkpoints (lobby_id, proposal_id, proposal_revision, state) VALUES ($1, $2, $3, 'awaiting_approval') RETURNING id, state", [lobbyId, proposal.rows[0]!.id, revision]);
    await client.query("UPDATE lobbies SET status = 'blocked', updated_at = now() WHERE id = $1", [lobbyId]);
    const formatted = formatProposal(proposal.rows[0]!, checkpoint.rows[0]!);
    await audit(client, principal.organizationId, lobbyId, "approval.required", "agent", principal.agentId, eventMetadata(formatted));
    await client.query("COMMIT");
    return formatted;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function issueActivation(pool: Pool, principal: Principal, lobbyId: string, proposalId: string, publicBaseUrl: string): Promise<{ activationId: string; deviceCode: string; expiresAt: string; portalUrl: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize the durable fallback limiter across concurrent server instances.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${principal.credentialId}:${proposalId}`]);
    const attempts = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM approval_activation_attempts WHERE credential_id = $1 AND proposal_id = $2 AND created_at > now() - $3::interval`, [principal.credentialId, proposalId, ACTIVATION_WINDOW]);
    if (attempts.rows[0]!.count >= ACTIVATION_LIMIT) throw new ConflictError("activation issuance rate limit exceeded");
    await client.query("INSERT INTO approval_activation_attempts (credential_id, proposal_id) VALUES ($1, $2)", [principal.credentialId, proposalId]);
    const target = await client.query<{ id: string; human_owner_id: string; expires_at: string; proposal_revision: number }>(`SELECT t.id, t.human_owner_id, p.expires_at, p.revision AS proposal_revision FROM approval_decision_targets t JOIN approval_proposals p ON p.id = t.proposal_id AND p.revision = t.proposal_revision JOIN approval_checkpoints c ON c.proposal_id = p.id AND c.proposal_revision = p.revision WHERE p.id = $1 AND p.lobby_id = $2 AND p.state IN ('requested', 'awaiting_both_owners', 'partially_approved') AND p.expires_at > now() AND c.state = 'awaiting_approval' AND t.target_agent_id = $3 AND t.human_owner_id = $4 AND t.state = 'pending' FOR UPDATE`, [proposalId, lobbyId, principal.agentId, principal.humanOwnerId]);
    if (!target.rows[0]) throw new ForbiddenError("no current pending approval target matches this adapter credential");
    const old = await client.query("SELECT id FROM approval_activations WHERE target_id = $1 FOR UPDATE", [target.rows[0].id]);
    if (old.rows[0]) throw new ConflictError("activation code was already issued for this target");
    const deviceCode = newPairingCode();
    const expiresAt = new Date(Math.min(Date.now() + ACTIVATION_TTL_MS, new Date(target.rows[0].expires_at).getTime())).toISOString();
    const inserted = await client.query<{ id: string }>("INSERT INTO approval_activations (proposal_id, proposal_revision, target_id, code_hash, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id", [proposalId, target.rows[0].proposal_revision, target.rows[0].id, sha256(deviceCode), expiresAt]);
    await audit(client, principal.organizationId, lobbyId, "approval.activation_issued", "agent", principal.agentId, { activationId: inserted.rows[0]!.id, approvalId: proposalId, revision: target.rows[0].proposal_revision, state: "awaiting_both_owners" });
    await client.query("COMMIT");
    return { activationId: inserted.rows[0]!.id, deviceCode, expiresAt, portalUrl: `${publicBaseUrl.replace(/\/$/, "")}/activate` };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function redeemActivation(pool: Pool, deviceCode: string): Promise<{ session: string; csrf: string }> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const activation = await client.query<{ id: string }>("SELECT id FROM approval_activations WHERE code_hash = $1 AND code_consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE", [sha256(deviceCode)]); if (!activation.rows[0]) throw new ForbiddenError("invalid or expired activation code"); const session = newSecret("als"); const csrf = newSecret("alcsrf"); await client.query("UPDATE approval_activations SET code_consumed_at = now(), session_hash = $2, csrf_hash = $3, session_expires_at = $4 WHERE id = $1", [activation.rows[0].id, sha256(session), sha256(csrf), new Date(Date.now() + SESSION_TTL_MS)]); await client.query("COMMIT"); return { session, csrf }; } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function getActivatedApproval(pool: Pool, session: string) {
  const result = await pool.query(`SELECT p.id, p.lobby_id AS "lobbyId", p.revision, p.canonical_hash AS "canonicalHash", p.structured_content AS content, p.state, p.expires_at AS "expiresAt", a.csrf_hash AS "csrfHash" FROM approval_activations a JOIN approval_decision_targets t ON t.id = a.target_id JOIN approval_proposals p ON p.id = a.proposal_id AND p.revision = a.proposal_revision JOIN approval_checkpoints c ON c.proposal_id = p.id AND c.proposal_revision = p.revision WHERE a.session_hash = $1 AND a.session_expires_at > now() AND a.revoked_at IS NULL AND p.state IN ('requested', 'awaiting_both_owners', 'partially_approved') AND p.expires_at > now() AND c.state = 'awaiting_approval' AND t.state = 'pending'`, [sha256(session)]);
  if (!result.rows[0]) throw new ForbiddenError("approval session is invalid or no longer pending"); return result.rows[0];
}

export async function decideActivatedApproval(pool: Pool, session: string, csrf: string, decision: Decision, idempotencyKey?: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ target_id: string; proposal_id: string; lobby_id: string; revision: number; organization_id: string; human_owner_id: string; state: string; csrf_hash: string; canonical_hash: string }>(`SELECT t.id AS target_id, p.id AS proposal_id, p.lobby_id, p.revision, l.organization_id, t.human_owner_id, t.state, a.csrf_hash, p.canonical_hash FROM approval_activations a JOIN approval_decision_targets t ON t.id = a.target_id JOIN approval_proposals p ON p.id = a.proposal_id AND p.revision = a.proposal_revision JOIN approval_checkpoints c ON c.proposal_id = p.id AND c.proposal_revision = p.revision JOIN lobbies l ON l.id = p.lobby_id WHERE a.session_hash = $1 AND a.session_expires_at > now() AND a.revoked_at IS NULL AND p.state IN ('requested', 'awaiting_both_owners', 'partially_approved') AND p.expires_at > now() AND c.state = 'awaiting_approval' FOR UPDATE`, [sha256(session)]);
    const row = current.rows[0];
    if (!row || row.csrf_hash !== sha256(csrf)) throw new ForbiddenError("invalid approval session or CSRF token");
    if (row.state !== "pending") { if (idempotencyKey) { await client.query("COMMIT"); return { state: row.state, replayed: true, events: [] as string[] }; } throw new ConflictError("approval target is already terminal"); }
    await client.query("UPDATE approval_decision_targets SET state = $2, decided_at = now(), decision_idempotency_key = $3 WHERE id = $1", [row.target_id, decision, idempotencyKey ?? null]);
    const states = await client.query<{ state: string }>("SELECT state FROM approval_decision_targets WHERE proposal_id = $1 AND proposal_revision = $2 FOR UPDATE", [row.proposal_id, row.revision]);
    const targetStates = states.rows.map((target) => target.state);
    const proposalState = targetStates.includes("rejected") ? "rejected" : targetStates.includes("changes_requested") ? "changes_requested" : targetStates.every((state) => state === "approved") ? "approved" : targetStates.includes("approved") ? "partially_approved" : "awaiting_both_owners";
    const checkpointState = proposalState === "approved" ? "resumable" : ["rejected", "changes_requested"].includes(proposalState) ? "rejected" : "awaiting_approval";
    await client.query("UPDATE approval_proposals SET state = $2::approval_proposal_state, resolved_at = CASE WHEN $2::approval_proposal_state IN ('approved', 'rejected', 'changes_requested') THEN now() ELSE NULL END, resumable_at = CASE WHEN $2::approval_proposal_state = 'approved' THEN now() ELSE NULL END WHERE id = $1 AND revision = $3", [row.proposal_id, proposalState, row.revision]);
    await client.query("UPDATE approval_checkpoints SET state = $2::approval_checkpoint_state, resolved_at = CASE WHEN $2::approval_checkpoint_state IN ('resumable', 'rejected') THEN now() ELSE NULL END WHERE proposal_id = $1 AND proposal_revision = $3", [row.proposal_id, checkpointState, row.revision]);
    if (checkpointState === "resumable") await client.query("UPDATE lobbies SET status = 'active', updated_at = now() WHERE id = $1", [row.lobby_id]);
    const metadata = { approvalId: row.proposal_id, lobbyId: row.lobby_id, revision: row.revision, canonicalHash: row.canonical_hash, state: proposalState, checkpointState, decision };
    await audit(client, row.organization_id, row.lobby_id, "approval.updated", "human", row.human_owner_id, metadata);
    const events = ["approval.updated"];
    if (["approved", "rejected", "changes_requested"].includes(proposalState)) { await audit(client, row.organization_id, row.lobby_id, "approval.resolved", "human", row.human_owner_id, metadata); events.push("approval.resolved"); }
    if (checkpointState === "resumable") { await audit(client, row.organization_id, row.lobby_id, "checkpoint.resumable", "human", row.human_owner_id, metadata); events.push("checkpoint.resumable"); }
    await client.query("COMMIT"); return { state: proposalState, checkpointState, replayed: false, events, event: metadata };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function recoverApprovalProposal(pool: Pool, principal: Principal, lobbyId: string, proposalId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const proposal = await client.query<{ revision: number; organization_id: string; canonical_hash: string; state: string; checkpoint_id: string; checkpoint_state: string }>(`SELECT p.revision, l.organization_id, p.canonical_hash, p.state, c.id AS checkpoint_id, c.state AS checkpoint_state FROM approval_proposals p JOIN lobbies l ON l.id = p.lobby_id JOIN approval_checkpoints c ON c.proposal_id = p.id AND c.proposal_revision = p.revision JOIN lobby_participants lp ON lp.lobby_id = p.lobby_id AND lp.agent_id = $3 AND lp.left_at IS NULL WHERE p.id = $1 AND p.lobby_id = $2 ORDER BY p.revision DESC LIMIT 1 FOR UPDATE`, [proposalId, lobbyId, principal.agentId]);
    const row = proposal.rows[0]; if (!row) throw new ForbiddenError("approval proposal is not available to this agent");
    if (["requested", "awaiting_both_owners", "partially_approved"].includes(row.state)) {
      const expired = await client.query("SELECT 1 FROM approval_proposals WHERE id = $1 AND revision = $2 AND expires_at <= now()", [proposalId, row.revision]);
      if (expired.rows[0]) { await client.query("UPDATE approval_decision_targets SET state = 'expired' WHERE proposal_id = $1 AND proposal_revision = $2 AND state = 'pending'", [proposalId, row.revision]); await client.query("UPDATE approval_activations SET revoked_at = now() WHERE proposal_id = $1 AND proposal_revision = $2 AND revoked_at IS NULL", [proposalId, row.revision]); await client.query("UPDATE approval_proposals SET state = 'expired', resolved_at = now() WHERE id = $1 AND revision = $2", [proposalId, row.revision]); await client.query("UPDATE approval_checkpoints SET state = 'expired', resolved_at = now() WHERE id = $1", [row.checkpoint_id]); row.state = "expired"; row.checkpoint_state = "expired"; }
    }
    const metadata = { approvalId: proposalId, revision: row.revision, canonicalHash: row.canonical_hash, state: row.state, checkpointState: row.checkpoint_state };
    await audit(client, row.organization_id, lobbyId, "approval.updated", "agent", principal.agentId, metadata);
    await client.query("COMMIT"); return metadata;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

async function supersedeRevision(client: PoolClient, proposalId: string, revision: number) {
  await client.query("UPDATE approval_proposals SET state = 'superseded', superseded_at = now() WHERE id = $1 AND revision = $2", [proposalId, revision]);
  await client.query("UPDATE approval_decision_targets SET state = 'superseded' WHERE proposal_id = $1 AND proposal_revision = $2 AND state NOT IN ('superseded', 'expired', 'cancelled')", [proposalId, revision]);
  await client.query("UPDATE approval_activations SET revoked_at = now() WHERE proposal_id = $1 AND proposal_revision = $2 AND revoked_at IS NULL", [proposalId, revision]);
  await client.query("UPDATE approval_checkpoints SET state = 'cancelled', resolved_at = now() WHERE proposal_id = $1 AND proposal_revision = $2 AND state NOT IN ('cancelled', 'expired')", [proposalId, revision]);
}
function formatProposal(row: { id: string; revision: number; canonical_hash: string; state: string; expires_at: string }, checkpoint: { id: string; state: string }) { return { id: row.id, version: row.revision, canonicalHash: row.canonical_hash, state: row.state, expiresAt: row.expires_at, decisionPolicy: "all_required", checkpoint: { id: checkpoint.id, state: checkpoint.state } }; }
function eventMetadata(proposal: ReturnType<typeof formatProposal>) { return { approvalId: proposal.id, revision: proposal.version, canonicalHash: proposal.canonicalHash, state: proposal.state, checkpointId: proposal.checkpoint.id, checkpointState: proposal.checkpoint.state }; }
async function audit(db: Db, organizationId: string, lobbyId: string, eventType: string, actorType: string, actorId: string, metadata: Record<string, unknown>) { await db.query("INSERT INTO audit_events (organization_id, lobby_id, event_type, actor_type, actor_id, metadata) VALUES ($1, $2, $3, $4, $5, $6)", [organizationId, lobbyId, eventType, actorType, actorId, metadata]); }
