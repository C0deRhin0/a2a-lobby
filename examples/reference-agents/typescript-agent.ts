#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname } from "node:path";

type Json = Record<string, any>;

const env = process.env;
const baseUrl = required("AGENT_LOBBY_BASE_URL").replace(/\/$/, "");
const token = required("AGENT_LOBBY_TOKEN");
const storePath = required("AGENT_LOBBY_SESSION_STORE");
const handoffPath = required("AGENT_LOBBY_HANDOFF");
const stage = env.AGENT_LOBBY_STAGE ?? "initiator-create";

const store = readJson(storePath, { sessions: {} });
const handoff = readJson(handoffPath, {});

if (stage === "initiator-create") {
  const card = await get("/.well-known/agent-card.json");
  const lobby = await post("/v1/lobbies", {
    purpose: "Executable product proof between TypeScript and Python reference agents",
    limits: { maxMessages: 10 },
    retentionPolicy: { messageTtlDays: 7, auditTtlDays: 365, plaintextMessageStorage: false },
    approvalPolicy: { requiresHumanApprovalFor: ["external_action", "final_agreement"], blockingByDefault: true },
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString()
  }, { "idempotency-key": `ts-create-${Date.now()}` });
  const invite = await post(`/v1/lobbies/${lobby.id}/invitations`, { role: "counterparty", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
  store.sessions.initiator = { localSessionId: "ts-reference", lobbyId: lobby.id, taskId: lobby.id, lastEventCursor: "0", discoveredAgentCard: card.url };
  Object.assign(handoff, { lobbyId: lobby.id, pairingCode: invite.pairingCode });
  writeJson(storePath, store);
  writeJson(handoffPath, handoff);
  console.log(JSON.stringify({ stage, lobbyId: lobby.id, discovered: card.protocolVersion }));
} else if (stage === "initiator-message-approval-agreement") {
  const lobbyId = requiredHandoff("lobbyId");
  const message = await post(`/v1/lobbies/${lobbyId}/messages`, { kind: "agent_message", text: "TypeScript agent requests a human-gated external action before final agreement." }, { "idempotency-key": `ts-msg-${lobbyId}` });
  const approval = await post(`/v1/lobbies/${lobbyId}/approval-proposals`, {
    type: "external_action",
    question: "Allow the Python reference agent to acknowledge completion of the external-action proof?",
    reason: "End-to-end product proof requires a blocking human decision through authenticated web approval.",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    content: { action: "reference-agent-proof", consequence: "acknowledge completion", approvalPolicy: "all_required" }
  });
  const initiatorDecision = await activateAndDecide(lobbyId, approval.id);
  store.sessions.initiator.lastEventCursor = String((await get(`/v1/lobbies/${lobbyId}/events?from=${encodeURIComponent(store.sessions.initiator.lastEventCursor ?? "0")}`)).reconnect.cursor);
  Object.assign(handoff, { messageId: message.id, messageSequence: message.sequence, approvalId: approval.id, initiatorDecision });
  writeJson(storePath, store);
  writeJson(handoffPath, handoff);
  console.log(JSON.stringify({ stage, messageId: message.id, approvalId: approval.id }));
} else if (stage === "initiator-finalize") {
  const lobbyId = requiredHandoff("lobbyId");
  const agreement = await post(`/v1/lobbies/${lobbyId}/agreements`, { content: { title: "Executable two-agent product proof", deliverables: ["A2A discovery", "lobby flow", "human approval", "bilateral agreement"], financialCommitmentCents: 0, final: true } });
  const approval = await post(`/v1/lobbies/${lobbyId}/agreements/${agreement.id}/approvals`, { version: agreement.version, canonicalHash: agreement.canonicalHash });
  Object.assign(handoff, { agreementId: agreement.id, agreementVersion: agreement.version, canonicalHash: agreement.canonicalHash, initiatorAgreementApproval: approval });
  writeJson(handoffPath, handoff);
  console.log(JSON.stringify({ stage, agreementId: agreement.id, canonicalHash: agreement.canonicalHash }));
} else {
  throw new Error(`unknown AGENT_LOBBY_STAGE ${stage}`);
}

async function get(path: string): Promise<Json> {
  return requestJson("GET", path);
}

async function post(path: string, body: Json, extraHeaders: Record<string, string> = {}): Promise<Json> {
  return requestJson("POST", path, body, extraHeaders);
}

async function requestJson(method: string, path: string, body?: Json, extraHeaders: Record<string, string> = {}): Promise<Json> {
  return (await requestJsonResponse(method, path, body, extraHeaders)).body;
}

async function requestJsonResponse(method: string, path: string, body?: Json, extraHeaders: Record<string, string> = {}): Promise<{ body: Json; headers: Record<string, string | string[] | undefined> }> {
  const url = new URL(`${baseUrl}${path}`);
  const payload = body ? JSON.stringify(body) : undefined;
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = transport(url, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        connection: "close",
        ...(payload ? { "content-length": Buffer.byteLength(payload).toString() } : {}),
        ...extraHeaders
      }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed = text ? JSON.parse(text) as Json : {};
        if ((res.statusCode ?? 500) >= 400) reject(new Error(`${method} ${path} failed ${res.statusCode}: ${text}`));
        else resolve({ body: parsed, headers: res.headers });
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function activateAndDecide(lobbyId: string, proposalId: string): Promise<Json> {
  const activation = await post(`/v1/lobbies/${lobbyId}/approval-proposals/${proposalId}/activation`, {});
  if (typeof activation.portalUrl !== "string" || !activation.portalUrl.endsWith("/activate")) throw new Error("activation did not return a safe approval portal URL");
  const redeemed = await requestJsonResponse("POST", new URL(activation.portalUrl).pathname, { deviceCode: activation.deviceCode });
  const cookie = Array.isArray(redeemed.headers["set-cookie"]) ? redeemed.headers["set-cookie"][0] : redeemed.headers["set-cookie"];
  if (!cookie) throw new Error("activation did not return an approval session cookie");
  return post("/activate/approval/decision", { decision: "approved" }, { cookie, "x-csrf-token": redeemed.body.csrfToken, "idempotency-key": `ts-approval-${proposalId}` });
}

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function requiredHandoff(name: string): any {
  if (handoff[name] === undefined) throw new Error(`handoff missing ${name}`);
  return handoff[name];
}

function readJson(path: string, fallback: Json): Json {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function writeJson(path: string, value: Json): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
