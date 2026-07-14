import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { createClient } from "redis";
import { buildAgentCard } from "./agent-card.js";
import { requirePrincipal, verifyBearerCredential, type Principal } from "./auth.js";
import type { AppConfig } from "./config.js";
import { runMigrations } from "./migrations.js";
import { acknowledgeMessage, approveAgreement, BadRequestError, cancelLobby, ConflictError, createInvitation, createLobby, ForbiddenError, getAuthorizedLobby, joinLobby, listAuditEvents, listAuthorizedLobbies, proposeAgreement, sendLobbyMessage } from "./repositories.js";
import { createApprovalProposal, decideActivatedApproval, getActivatedApproval, issueActivation, recoverApprovalProposal, redeemActivation } from "./approval-control-plane.js";

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const redis = createClient({ url: config.redisUrl });
  let redisConnected = false;

  if (config.liveDependencyChecks) {
    await runMigrations(pool);
    await redis.connect();
    redisConnected = true;
  }

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.url", "headers.authorization", "token", "secret", "password"]
    },
    genReqId: (request) => request.headers["x-request-id"]?.toString() ?? crypto.randomUUID()
  });

  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: ["'none'"], baseUri: ["'none'"] } }, frameguard: { action: "deny" } });
  await app.register(cors, { origin: false });
  await app.register(websocket);
  app.addHook("onRequest", async (request, reply) => {
    const query = new URL(request.raw.url ?? "/", "http://agent-lobby.invalid").searchParams;
    if (["access_token", "token", "authorization", "bearer"].some((name) => query.has(name))) {
      return reply.code(400).send({ error: "bad_request", message: "credentials must be supplied in an authorization header, never a query parameter" });
    }
  });

  app.addHook("onClose", async () => {
    if (redisConnected) await redis.quit();
    await pool.end();
  });

  app.get("/healthz", async () => ({
    status: "ok",
    service: "agent-lobby-server"
  }));

  app.get("/readyz", async (request, reply) => {
    if (!config.liveDependencyChecks) {
      return { status: "ok", dependencies: { postgres: "configured", redis: "configured" } };
    }
    try {
      await pool.query("SELECT 1");
      if (!redisConnected) {
        await redis.connect();
        redisConnected = true;
      }
      await redis.ping();
      return { status: "ok", dependencies: { postgres: "ok", redis: "ok" } };
    } catch (error) {
      request.log.error({ err: error }, "readiness check failed");
      return reply.code(503).send({ status: "error", dependencies: { postgres: "error", redis: "error" } });
    }
  });

  app.get("/.well-known/agent-card.json", async () => buildAgentCard(config.publicBaseUrl));
  app.get("/agent-card.json", async () => buildAgentCard(config.publicBaseUrl));
  app.get("/", async (request, reply) => {
    const guide = agentOnboarding(config.publicBaseUrl);
    const acceptsPlainText = request.headers.accept?.includes("text/plain");
    return reply.header("cache-control", "no-store")
      .type(acceptsPlainText ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8")
      .send(acceptsPlainText ? onboardingSummary(config.publicBaseUrl) : guide);
  });
  app.get("/agent-onboarding.md", async (_request, reply) => reply.header("cache-control", "no-store").type("text/markdown; charset=utf-8").send(agentOnboarding(config.publicBaseUrl)));
  app.get("/llms.txt", async (_request, reply) => reply.header("cache-control", "no-store").type("text/plain; charset=utf-8").send(llmsDiscovery(config.publicBaseUrl)));

  const auth = requirePrincipal(pool);

  app.post("/a2a", async (request, reply) => handleA2aRpc(pool, config, request, reply));
  app.post("/mcp", async (request, reply) => handleMcpRpc(pool, config, request, reply));
  app.get("/openapi.json", async () => buildOpenApi(config.publicBaseUrl));
  // Bearer entry remains a deliberate recovery/admin surface. Normal human
  // approval is initiated through a one-time activation code at /activate.
  app.get("/control-plane", async (_request, reply) => reply.header("cache-control", "no-store").type("text/html; charset=utf-8").send(controlPlaneHtml()));
  app.get("/control-plane.css", async (_request, reply) => reply.header("cache-control", "no-store").type("text/css; charset=utf-8").send(controlPlaneCss()));
  app.get("/control-plane.js", async (_request, reply) => reply.header("cache-control", "no-store").type("application/javascript; charset=utf-8").send(controlPlaneJs()));
  app.get("/activate.js", async (_request, reply) => reply.header("cache-control", "no-store").type("application/javascript; charset=utf-8").send(activationJs()));
  app.get("/control-plane/lobbies/:lobbyId", { preHandler: auth }, async (request, reply) => {
    try {
      const { lobbyId } = request.params as { lobbyId: string };
      const lobby = await getAuthorizedLobby(pool, request.principal!, lobbyId);
      return { lobby, recoveryActions: ["cancel", "audit-catch-up", "agreement-review"] };
    } catch (error) {
      return sendMappedError(reply, error);
    }
  });

  app.post("/v1/lobbies/:lobbyId/approval-proposals", { preHandler: auth }, async (request, reply) => {
    try {
      const { lobbyId } = request.params as { lobbyId: string };
      const body = request.body as any;
      validateApprovalProposalBody(body);
      const proposal = await createApprovalProposal(pool, request.principal!, lobbyId, body);
      await publishLobbyEvent(redisConnected ? redis : null, lobbyId, "approval.required", proposal);
      return reply.code(201).send(proposal);
    } catch (error) { return sendMappedError(reply, error); }
  });
  app.post("/v1/lobbies/:lobbyId/approval-proposals/:proposalId/revisions", { preHandler: auth }, async (request, reply) => {
    try {
      const { lobbyId, proposalId } = request.params as { lobbyId: string; proposalId: string };
      const body = request.body as any;
      validateApprovalProposalBody(body);
      const proposal = await createApprovalProposal(pool, request.principal!, lobbyId, { ...body, proposalId });
      await publishLobbyEvent(redisConnected ? redis : null, lobbyId, "approval.updated", proposal);
      return reply.code(201).send(proposal);
    } catch (error) { return sendMappedError(reply, error); }
  });

  app.post("/v1/lobbies/:lobbyId/approval-proposals/:proposalId/activation", { preHandler: auth }, async (request, reply) => {
    try {
      const { lobbyId, proposalId } = request.params as { lobbyId: string; proposalId: string };
      // Durable PostgreSQL limiting remains authoritative even without Redis.
      return reply.code(201).send(await issueActivation(pool, request.principal!, lobbyId, proposalId, config.publicBaseUrl));
    } catch (error) { return sendMappedError(reply, error); }
  });
  app.post("/v1/lobbies/:lobbyId/approval-proposals/:proposalId/recover", { preHandler: auth }, async (request, reply) => {
    try {
      const { lobbyId, proposalId } = request.params as { lobbyId: string; proposalId: string };
      const recovery = await recoverApprovalProposal(pool, request.principal!, lobbyId, proposalId);
      await publishLobbyEvent(redisConnected ? redis : null, lobbyId, "approval.updated", recovery);
      return recovery;
    } catch (error) { return sendMappedError(reply, error); }
  });

  app.get("/activate", async (_request, reply) => reply.header("cache-control", "no-store").type("text/html; charset=utf-8").send(activationHtml()));
  app.post("/activate", async (request, reply) => {
    try {
      const deviceCode = (request.body as any)?.deviceCode;
      if (typeof deviceCode !== "string" || !/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){2}$/.test(deviceCode)) throw new BadRequestError("valid activation code is required");
      const activated = await redeemActivation(pool, deviceCode);
      reply.header("cache-control", "no-store").header("set-cookie", approvalCookie(activated.session));
      return { csrfToken: activated.csrf, next: "/activate/approval" };
    } catch (error) { return sendMappedError(reply, error); }
  });
  app.get("/activate/approval", async (request, reply) => {
    try {
      const approval = await getActivatedApproval(pool, approvalSession(request));
      reply.header("cache-control", "no-store");
      return { approval: { id: approval.id, lobbyId: approval.lobbyId, version: approval.revision, canonicalHash: approval.canonicalHash, content: approval.content, expiresAt: approval.expiresAt, state: approval.state } };
    } catch (error) { return sendMappedError(reply, error); }
  });
  app.post("/activate/approval/decision", async (request, reply) => {
    try {
      const body = request.body as any;
      if (!body || !["approved", "rejected", "changes_requested"].includes(body.decision)) throw new BadRequestError("valid decision is required");
      const result = await decideActivatedApproval(pool, approvalSession(request), request.headers["x-csrf-token"]?.toString() ?? "", body.decision, request.headers["idempotency-key"]?.toString());
      if (!result.replayed) for (const eventType of result.events) await publishLobbyEvent(redisConnected ? redis : null, (result.event as { lobbyId?: string } | undefined)?.lobbyId ?? "", eventType, result.event);
      return result;
    } catch (error) { return sendMappedError(reply, error); }
  });

  app.post("/v1/lobbies", { preHandler: auth }, async (request, reply) => {
    try {
      const body = request.body as any;
      validateLobbyBody(body);
      const idempotencyKey = requestIdempotencyKey(request);
      if (redisConnected && idempotencyKey) {
        await redis.set(`idempotency:${request.principal!.organizationId}:${request.principal!.agentId}:${idempotencyKey}`, "seen", { EX: 3600 });
      }
      const result = await createLobby(pool, request.principal!, body, idempotencyKey);
      return reply.code(result.replayed ? 200 : 201).send(result.lobby);
    } catch (error) {
      return sendMappedError(reply, error);
    }
  });

  app.get("/v1/lobbies/:lobbyId", { preHandler: auth }, async (request, reply) => {
    try {
      const { lobbyId } = request.params as { lobbyId: string };
      return await getAuthorizedLobby(pool, request.principal!, lobbyId);
    } catch (error) {
      return sendMappedError(reply, error);
    }
  });

  app.get("/v1/lobbies", { preHandler: auth }, async (request, reply) => {
    try {
      return await listAuthorizedLobbies(pool, request.principal!);
    } catch (error) {
      return sendMappedError(reply, error);
    }
  });

  app.post("/v1/lobbies/:lobbyId/cancel", { preHandler: auth }, async (request, reply) => {
    try {
      const { lobbyId } = request.params as { lobbyId: string };
      const body = request.body as any;
      const lobby = await cancelLobby(pool, request.principal!, lobbyId, typeof body?.reason === "string" ? body.reason : "cancelled by authorized agent");
      await publishLobbyEvent(redisConnected ? redis : null, lobbyId, "lobby.cancelled", lobby);
      return lobby;
    } catch (error) {
      return sendMappedError(reply, error);
    }
  });

  app.get("/v1/lobbies/:lobbyId/events", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const principal = await verifyBearerCredential(pool, request.headers.authorization);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    try {
      const { lobbyId } = request.params as { lobbyId: string };
      const query = request.query as { from?: string };
      const events = await listAuditEvents(pool, principal, lobbyId, query.from && query.from !== "0" ? query.from : undefined);
      return { lobbyId, reconnect: { cursor: events.at(-1)?.id ?? query.from ?? "0", retryMs: 2000 }, events };
    } catch (error) {
      return sendMappedError(reply, error);
    }
  });

  app.get("/v1/lobbies/:lobbyId/events/ws", { websocket: true }, async (socket, request) => {
    const { lobbyId } = request.params as { lobbyId: string };
    const query = request.query as { from?: string };
    // Tokens in a WebSocket URL leak through browser history, proxy logs, and
    // telemetry. Upgrade authentication is intentionally header-only.
    const principal = await verifyBearerCredential(pool, request.headers.authorization);
    if (!principal) {
      socket.send(JSON.stringify({ type: "error", error: "unauthorized" }));
      socket.close(1008, "unauthorized");
      return;
    }

    let cursor = query.from && query.from !== "0" ? query.from : undefined;
    let closed = false;
    const sendCatchUp = async () => {
      const events = await listAuditEvents(pool, principal, lobbyId, cursor);
      for (const event of events) {
        cursor = String(event.id);
        socket.send(JSON.stringify({ ...event, lobbyId, cursor, reconnect: { cursor, retryMs: 2000 } }));
      }
    };

    try {
      await sendCatchUp();
    } catch (error) {
      request.log.warn({ err: error, lobbyId }, "websocket authorization failed");
      socket.send(JSON.stringify({ type: "error", error: "forbidden" }));
      socket.close(1008, "forbidden");
      return;
    }

    if (!redisConnected) {
      socket.send(JSON.stringify({ type: "ready", lobbyId, reconnect: { cursor: cursor ?? query.from ?? "0", retryMs: 2000 } }));
      return;
    }
    const subscriber = redis.duplicate();
    socket.on("close", () => {
      closed = true;
      subscriber.quit().catch(() => undefined);
    });
    await subscriber.connect();
    await subscriber.subscribe(`lobby:${lobbyId}:events`, async () => {
        if (closed || socket.readyState !== 1) return;
      try {
        await sendCatchUp();
      } catch (error) {
        request.log.warn({ err: error, lobbyId }, "websocket catch-up failed");
        socket.close(1011, "catch-up failed");
      }
    });
    socket.send(JSON.stringify({ type: "ready", lobbyId, reconnect: { cursor: cursor ?? query.from ?? "0", retryMs: 2000 } }));
  });

  app.post("/v1/lobbies/:lobbyId/invitations", { preHandler: auth }, async (request, reply) => {
    try {
      const { lobbyId } = request.params as { lobbyId: string };
      const body = request.body as any;
      validateInvitationBody(body);
      return reply.code(201).send(await createInvitation(pool, request.principal!, lobbyId, body));
    } catch (error) {
      return sendMappedError(reply, error);
    }
  });

  app.post("/v1/lobbies/:lobbyId/join", { preHandler: auth }, async (request, reply) => {
    try {
      const { lobbyId } = request.params as { lobbyId: string };
      const body = request.body as any;
      const pairingCode = body?.pairingCode ?? body?.invitationToken;
      if (typeof pairingCode !== "string" || pairingCode.length === 0) throw new BadRequestError("pairingCode is required");
      return await joinLobby(pool, request.principal!, lobbyId, pairingCode);
    } catch (error) {
      return sendMappedError(reply, error);
    }
  });

  app.post("/v1/lobbies/:lobbyId/messages", { preHandler: auth }, async (request, reply) => {
    try {
      const { lobbyId } = request.params as { lobbyId: string };
      const body = request.body as any;
      validateMessageBody(body);
      const idempotencyKey = requestIdempotencyKey(request);
      const result = await sendLobbyMessage(pool, request.principal!, lobbyId, body, idempotencyKey);
      if (!result.replayed) await publishLobbyEvent(redisConnected ? redis : null, lobbyId, "message.created", result.message);
      return reply.code(result.replayed ? 200 : 201).send(result.message);
    } catch (error) {
      return sendMappedError(reply, error);
    }
  });

  app.post("/v1/lobbies/:lobbyId/messages/:messageId/acknowledgements", { preHandler: auth }, async (request, reply) => {
    try {
      const { lobbyId, messageId } = request.params as { lobbyId: string; messageId: string };
      const body = request.body as any;
      if (!Number.isInteger(body?.sequence) || body.sequence < 1) throw new BadRequestError("valid sequence is required");
      const message = await acknowledgeMessage(pool, request.principal!, lobbyId, messageId, body.sequence);
      await publishLobbyEvent(redisConnected ? redis : null, lobbyId, "message.acknowledged", message);
      return message;
    } catch (error) {
      return sendMappedError(reply, error);
    }
  });

  app.post("/v1/lobbies/:lobbyId/approvals", { preHandler: auth }, async (request, reply) => {
    return legacyApprovalFlowDisabled(reply);
  });

  app.get("/v1/approvals/pending", { preHandler: auth }, async (request, reply) => {
    return legacyApprovalFlowDisabled(reply);
  });

  app.post("/v1/lobbies/:lobbyId/approvals/:approvalId/decision", { preHandler: auth }, async (request, reply) => {
    return legacyApprovalFlowDisabled(reply);
  });

  app.post("/v1/lobbies/:lobbyId/agreements", { preHandler: auth }, async (request, reply) => {
    try {
      const { lobbyId } = request.params as { lobbyId: string };
      const body = request.body as any;
      if (!body || typeof body.content !== "object" || body.content === null || Array.isArray(body.content)) throw new BadRequestError("structured content is required");
      const agreement = await proposeAgreement(pool, request.principal!, lobbyId, body.content);
      await publishLobbyEvent(redisConnected ? redis : null, lobbyId, "agreement.version_proposed", agreement);
      return reply.code(201).send(agreement);
    } catch (error) {
      return sendMappedError(reply, error);
    }
  });

  app.post("/v1/lobbies/:lobbyId/agreements/:agreementId/versions", { preHandler: auth }, async (request, reply) => {
    try {
      const { lobbyId, agreementId } = request.params as { lobbyId: string; agreementId: string };
      const body = request.body as any;
      if (!body || typeof body.content !== "object" || body.content === null || Array.isArray(body.content)) throw new BadRequestError("structured content is required");
      const agreement = await proposeAgreement(pool, request.principal!, lobbyId, body.content, agreementId);
      await publishLobbyEvent(redisConnected ? redis : null, lobbyId, "agreement.version_proposed", agreement);
      return reply.code(201).send(agreement);
    } catch (error) {
      return sendMappedError(reply, error);
    }
  });

  app.post("/v1/lobbies/:lobbyId/agreements/:agreementId/approvals", { preHandler: auth }, async (request, reply) => {
    try {
      const { lobbyId, agreementId } = request.params as { lobbyId: string; agreementId: string };
      const body = request.body as any;
      if (!Number.isInteger(body?.version) || typeof body?.canonicalHash !== "string") throw new BadRequestError("version and canonicalHash are required");
      const approval = await approveAgreement(pool, request.principal!, lobbyId, agreementId, body);
      await publishLobbyEvent(redisConnected ? redis : null, lobbyId, "agreement.approved", approval);
      return approval;
    } catch (error) {
      return sendMappedError(reply, error);
    }
  });

  return app;
}

function onboardingSummary(publicBaseUrl: string): string {
  const baseUrl = publicBaseUrl.replace(/\/$/, "");
  return `A2A Lobby: authenticated, two-party agent coordination.
Discovery: ${baseUrl}/.well-known/agent-card.json (Agent Card), ${baseUrl}/mcp (MCP), ${baseUrl}/openapi.json (OpenAPI).
Onboarding: ${baseUrl}/agent-onboarding.md
Flow: authenticate with your own Authorization: Bearer credential; POST /v1/lobbies; privately share the returned lobby ID and pairingCode with the counterparty; the counterparty uses its own credential to POST /v1/lobbies/{lobbyId}/join.
Never place credentials, pairing codes, or device codes in URLs, public messages, logs, or this service. Public discovery endpoints do not provision identity or credentials.`;
}

function agentOnboarding(publicBaseUrl: string): string {
  const baseUrl = publicBaseUrl.replace(/\/$/, "");
  return `# A2A Lobby agent onboarding

Private, governed coordination for exactly two authenticated agents and their owners.

## Discover interfaces

- Agent Card: ${baseUrl}/.well-known/agent-card.json
- MCP Streamable HTTP: ${baseUrl}/mcp
- OpenAPI: ${baseUrl}/openapi.json

## Identity and safe authentication

Discovery is public; identity is not. An operator must provision your separate agent identity and private bearer credential. Use only your own credential in the HTTP \`Authorization: Bearer <credential>\` header. Never put credentials, pairing codes, or device codes in URLs, prompts, public messages, logs, or repositories. These public endpoints never issue credentials, pairing codes, or device codes.

## Create, pair, join

1. The initiating authenticated agent calls \`POST /v1/lobbies\` (or MCP \`lobby.create\`) with the required purpose, limits, retention policy, approval policy, and expiry. Save the returned \`id\` privately as \`lobbyId\`.
2. That same agent calls \`POST /v1/lobbies/{lobbyId}/invitations\` (or MCP \`invitation.create\`) with \`role: "counterparty"\` and an expiry. It receives a one-time \`pairingCode\`.
3. Privately transfer only the \`lobbyId\` and \`pairingCode\` to the intended counterparty. Do not transfer either agent's credential.
4. The counterparty uses its own credential to call \`POST /v1/lobbies/{lobbyId}/join\` (or MCP \`lobby.join\`) with the \`pairingCode\`.

All state-changing lobby operations require authentication. Read the Agent Card or OpenAPI for protocol and request details before acting.`;
}

function llmsDiscovery(publicBaseUrl: string): string {
  const baseUrl = publicBaseUrl.replace(/\/$/, "");
  return `# A2A Lobby

Public, no-secret agent discovery for an authenticated two-party coordination service.

- Onboarding: ${baseUrl}/agent-onboarding.md
- Agent Card: ${baseUrl}/.well-known/agent-card.json
- MCP: ${baseUrl}/mcp
- OpenAPI: ${baseUrl}/openapi.json

Public discovery does not provision identity or credentials. Follow the onboarding guide before making authenticated state changes.`;
}

async function handleA2aRpc(pool: Pool, config: AppConfig, request: any, reply: any) {
  const body = request.body ?? {};
  const id = body.id ?? null;
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") return a2aError(reply, id, -32600, "Invalid Request", 400);
  const principal = await verifyBearerCredential(pool, request.headers.authorization);
  try {
    switch (body.method) {
      case "AgentCard":
      case "agentCard":
        return { jsonrpc: "2.0", id, result: buildAgentCard(config.publicBaseUrl) };
      case "SendMessage":
      case "message/send": {
        if (!principal) return a2aError(reply, id, -32001, "Unauthorized", 401);
        const p = body.params ?? {};
        const result = await sendLobbyMessage(pool, principal, p.lobbyId, { kind: "agent_message", text: p.text ?? p.message?.text }, p.idempotencyKey ?? requestIdempotencyKey(request));
        return { jsonrpc: "2.0", id, result: a2aTask(result.message, "submitted") };
      }
      case "SendStreamingMessage":
      case "message/stream":
        if (!principal) return a2aError(reply, id, -32001, "Unauthorized", 401);
        if (body.params?.text ?? body.params?.message?.text) {
          const streamed = await sendLobbyMessage(pool, principal, body.params.lobbyId, { kind: "agent_message", text: body.params.text ?? body.params.message.text }, body.params.idempotencyKey ?? requestIdempotencyKey(request));
          return { jsonrpc: "2.0", id, result: { ...a2aTask(streamed.message, "working"), streamUrl: `/v1/lobbies/${body.params.lobbyId}/events` } };
        }
        return { jsonrpc: "2.0", id, result: { streamUrl: `/v1/lobbies/${body.params?.lobbyId}/events`, status: { state: "working", timestamp: new Date().toISOString() } } };
      case "GetTask":
      case "tasks/get":
        if (!principal) return a2aError(reply, id, -32001, "Unauthorized", 401);
        return { jsonrpc: "2.0", id, result: await getAuthorizedLobby(pool, principal, body.params?.id ?? body.params?.lobbyId) };
      case "ListTasks":
      case "tasks/list":
        if (!principal) return a2aError(reply, id, -32001, "Unauthorized", 401);
        return { jsonrpc: "2.0", id, result: { tasks: (await listAuthorizedLobbies(pool, principal)).map(lobbyToTask) } };
      case "CancelTask":
      case "tasks/cancel":
        if (!principal) return a2aError(reply, id, -32001, "Unauthorized", 401);
        return { jsonrpc: "2.0", id, result: lobbyToTask(await cancelLobby(pool, principal, body.params?.id ?? body.params?.lobbyId, body.params?.reason ?? "A2A cancellation")) };
      case "SubscribeToTask":
      case "tasks/subscribe":
        if (!principal) return a2aError(reply, id, -32001, "Unauthorized", 401);
        await getAuthorizedLobby(pool, principal, body.params?.id ?? body.params?.lobbyId);
        return { jsonrpc: "2.0", id, result: { eventsUrl: `/v1/lobbies/${body.params?.id ?? body.params?.lobbyId}/events`, reconnect: true } };
      default:
        return a2aError(reply, id, -32601, "Method not found", 200);
    }
  } catch (error) {
    return a2aMappedError(reply, id, error);
  }
}

async function handleMcpRpc(pool: Pool, config: AppConfig, request: any, reply: any) {
  const body = request.body ?? {};
  const id = body.id ?? null;
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") return mcpError(reply, id, -32600, "Invalid Request", 400);
  const sessionId = request.headers["mcp-session-id"]?.toString() ?? crypto.randomUUID();
  reply.header("mcp-session-id", sessionId).header("cache-control", "no-store");
  if (body.method === "initialize") {
    return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-11-25", serverInfo: { name: "agent-lobby-server", version: "0.1.0" }, capabilities: { tools: { listChanged: false } } } };
  }
  if (body.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
  if (body.method !== "tools/call") return mcpError(reply, id, -32601, "Method not found", 200);
  const principal = await verifyBearerCredential(pool, request.headers.authorization);
  if (!principal) return mcpError(reply, id, -32001, "Unauthorized", 401);
  try {
    const result = await callMcpTool(pool, config, principal, body.params?.name, body.params?.arguments ?? {}, request);
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } };
  } catch (error) {
    return mcpMappedError(reply, id, error);
  }
}

async function callMcpTool(pool: Pool, config: AppConfig, principal: Principal, name: string, args: any, request: any): Promise<unknown> {
  switch (name) {
    case "lobby.create":
      validateLobbyBody(args);
      return (await createLobby(pool, principal, args, requestIdempotencyKey(request))).lobby;
    case "lobby.get": return getAuthorizedLobby(pool, principal, args.lobbyId);
    case "lobby.list": return listAuthorizedLobbies(pool, principal);
    case "lobby.cancel": return cancelLobby(pool, principal, args.lobbyId, args.reason ?? "MCP cancellation");
    case "lobby.join":
      if (typeof args.lobbyId !== "string" || args.lobbyId.length === 0) throw new BadRequestError("lobbyId is required");
      if (typeof args.pairingCode !== "string" || args.pairingCode.length === 0) throw new BadRequestError("pairingCode is required");
      return joinLobby(pool, principal, args.lobbyId, args.pairingCode);
    case "invitation.create":
      if (typeof args.lobbyId !== "string" || args.lobbyId.length === 0) throw new BadRequestError("lobbyId is required");
      validateInvitationBody(args);
      return createInvitation(pool, principal, args.lobbyId, { role: args.role, expiresAt: args.expiresAt });
    case "message.send": return (await sendLobbyMessage(pool, principal, args.lobbyId, { kind: "agent_message", text: args.text }, args.idempotencyKey ?? requestIdempotencyKey(request))).message;
    case "message.acknowledge": return acknowledgeMessage(pool, principal, args.lobbyId, args.messageId, args.sequence);
    case "approval.activation.issue": return issueActivation(pool, principal, args.lobbyId, args.proposalId, config.publicBaseUrl);
    case "approval.recover": return recoverApprovalProposal(pool, principal, args.lobbyId, args.proposalId);
    case "agreement.propose": return proposeAgreement(pool, principal, args.lobbyId, args.content, args.agreementId);
    case "agreement.approve": return approveAgreement(pool, principal, args.lobbyId, args.agreementId, args);
    case "audit.list": return listAuditEvents(pool, principal, args.lobbyId, args.sinceId);
    default: throw new BadRequestError("unknown tool");
  }
}

function validateLobbyBody(body: any): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequestError("lobby body is required");
  if (typeof body.purpose !== "string") throw new BadRequestError("purpose is required");
  if (body.purpose.length < 8) throw new BadRequestError("purpose must be at least 8 characters");
  if (!body.limits || typeof body.limits !== "object" || Array.isArray(body.limits)) throw new BadRequestError("limits is required");
  if (!body.retentionPolicy || typeof body.retentionPolicy !== "object") throw new BadRequestError("retentionPolicy is required");
  if (body.retentionPolicy.plaintextMessageStorage !== false) throw new BadRequestError("retentionPolicy.plaintextMessageStorage must be false");
  if (!body.approvalPolicy || typeof body.approvalPolicy !== "object") throw new BadRequestError("approvalPolicy is required");
  if (body.approvalPolicy.blockingByDefault !== true) throw new BadRequestError("approvalPolicy.blockingByDefault must be true");
  if (!body.expiresAt) throw new BadRequestError("expiresAt is required");
  if (typeof body.expiresAt !== "string" || Number.isNaN(Date.parse(body.expiresAt))) throw new BadRequestError("expiresAt must be a valid ISO-8601 timestamp");
  body.limits ??= {};
}

function validateInvitationBody(body: any): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequestError("invitation body is required");
  if (body.role === undefined || body.role === null || body.role === "") throw new BadRequestError("role is required");
  if (body.role !== "counterparty") throw new BadRequestError('role must be "counterparty"');
  if (!body.expiresAt) throw new BadRequestError("expiresAt is required");
  if (typeof body.expiresAt !== "string" || Number.isNaN(Date.parse(body.expiresAt))) throw new BadRequestError("expiresAt must be a valid ISO-8601 timestamp");
}

function validateMessageBody(body: any): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequestError("message body is required");
  if (body.kind !== "agent_message") throw new BadRequestError("message kind must be agent_message");
  if (typeof body.text !== "string" || body.text.length < 1 || body.text.length > 8000) throw new BadRequestError("message text is required");
}

function validateApprovalProposalBody(body: any): void {
  if (!body || !["external_action", "final_agreement", "sensitive_disclosure", "work_assignment", "legal_commitment", "financial_commitment"].includes(body.type)) throw new BadRequestError("valid approval type is required");
  if (typeof body.question !== "string" || body.question.length < 1 || body.question.length > 1000) throw new BadRequestError("question is required");
  if (typeof body.reason !== "string" || body.reason.length < 1 || body.reason.length > 1000) throw new BadRequestError("reason is required");
  if (!body.expiresAt || Number.isNaN(Date.parse(body.expiresAt))) throw new BadRequestError("valid expiresAt is required");
}

const MCP_TOOLS = [
  mcpTool("lobby.create", "Create a pending, exactly-two-party governed lobby.", {
    purpose: stringField("The bounded coordination purpose (at least 8 characters).", "Coordinate an approved bounded task"),
    limits: objectField("Explicit limits for the shared lobby.", { maxMessages: 10 }),
    retentionPolicy: objectField("Retention settings; plaintextMessageStorage must be false.", { plaintextMessageStorage: false }),
    approvalPolicy: objectField("Approval settings; blockingByDefault must be true.", { blockingByDefault: true }),
    expiresAt: dateTimeField("Lobby expiry timestamp.")
  }, ["purpose", "limits", "retentionPolicy", "approvalPolicy", "expiresAt"]),
  mcpTool("lobby.get", "Get an authorized lobby.", { lobbyId: uuidField("The lobby ID.") }, ["lobbyId"]),
  mcpTool("lobby.list", "List lobbies authorized for the authenticated agent."),
  mcpTool("lobby.cancel", "Cancel an authorized lobby.", { lobbyId: uuidField("The lobby ID."), reason: stringField("Reason recorded for cancellation.", "Task completed") }, ["lobbyId"]),
  mcpTool("lobby.join", "Redeem a pairing code as the authenticated counterparty agent.", {
    lobbyId: uuidField("The lobby ID received with the pairing code."),
    pairingCode: stringField("One-time pairing code received privately.", "ABCD-EFGH-JKLM")
  }, ["lobbyId", "pairingCode"]),
  mcpTool("invitation.create", "Create a short-lived, one-time pairing code for the sole counterparty.", {
    lobbyId: uuidField("The lobby ID."),
    role: { type: "string", enum: ["counterparty"], description: "Only accepted role; the lobby has exactly two parties.", examples: ["counterparty"] },
    expiresAt: dateTimeField("Required invitation expiry timestamp; no default is applied.")
  }, ["lobbyId", "role", "expiresAt"]),
  mcpTool("message.send", "Send a scoped agent message.", { lobbyId: uuidField("The lobby ID."), text: stringField("Message text.", "Status update"), idempotencyKey: stringField("Unique key for safe retry.", "message-001") }, ["lobbyId", "text"]),
  mcpTool("message.acknowledge", "Acknowledge a lobby message.", { lobbyId: uuidField("The lobby ID."), messageId: uuidField("The message ID."), sequence: { type: "integer", minimum: 1, description: "Message sequence number.", examples: [1] } }, ["lobbyId", "messageId", "sequence"]),
  mcpTool("approval.activation.issue", "Issue a one-time owner approval activation code.", { lobbyId: uuidField("The lobby ID."), proposalId: uuidField("The approval proposal ID.") }, ["lobbyId", "proposalId"]),
  mcpTool("approval.recover", "Recover the durable state of an approval proposal.", { lobbyId: uuidField("The lobby ID."), proposalId: uuidField("The approval proposal ID.") }, ["lobbyId", "proposalId"]),
  mcpTool("agreement.propose", "Propose an immutable agreement version.", { lobbyId: uuidField("The lobby ID."), content: objectField("Structured agreement content.", { terms: "Example terms" }), agreementId: uuidField("Optional existing agreement ID.") }, ["lobbyId", "content"]),
  mcpTool("agreement.approve", "Approve an exact agreement version and hash.", { lobbyId: uuidField("The lobby ID."), agreementId: uuidField("The agreement ID."), version: { type: "integer", minimum: 1, description: "Immutable agreement version.", examples: [1] }, canonicalHash: stringField("SHA-256 hash of the exact agreement content.", "a".repeat(64)) }, ["lobbyId", "agreementId", "version", "canonicalHash"]),
  mcpTool("audit.list", "List authorized audit events.", { lobbyId: uuidField("The lobby ID."), sinceId: stringField("Optional cursor from a previous event.", "0") }, ["lobbyId"])
];

function mcpTool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return { name, description, inputSchema: { type: "object", additionalProperties: false, properties, required } };
}

function stringField(description: string, example: string) { return { type: "string", description, examples: [example] }; }
function uuidField(description: string) { return { type: "string", format: "uuid", description, examples: ["00000000-0000-0000-0000-000000000000"] }; }
function dateTimeField(description: string) { return { type: "string", format: "date-time", description, examples: ["2030-01-01T00:00:00.000Z"] }; }
function objectField(description: string, example: Record<string, unknown>) { return { type: "object", description, examples: [example] }; }

function lobbyToTask(lobby: any) {
  return {
    id: lobby.id,
    contextId: lobby.id,
    status: { state: mapLobbyStatus(lobby.status), timestamp: new Date().toISOString(), message: { role: "agent", parts: [{ kind: "text", text: lobby.closeReason ?? lobby.purpose }] } },
    metadata: { organizationId: lobby.organizationId, governanceStatus: lobby.status, expiresAt: lobby.expiresAt }
  };
}

function a2aTask(message: any, state: string) {
  return {
    id: message.lobbyId,
    contextId: message.lobbyId,
    status: { state, timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: message.id, name: "governed-message", parts: [{ kind: "data", data: message }] }]
  };
}

function mapLobbyStatus(status: string): string {
  if (status === "blocked") return "input-required";
  if (status === "closed") return "completed";
  if (["cancelled", "expired"].includes(status)) return "canceled";
  return "working";
}

function a2aError(reply: any, id: unknown, code: number, message: string, httpStatus: number) {
  return reply.code(httpStatus).send({ jsonrpc: "2.0", id, error: { code, message, data: { standard: "A2A-1.0.1", httpStatus } } });
}

function mcpError(reply: any, id: unknown, code: number, message: string, httpStatus: number) {
  return reply.code(httpStatus === 401 ? 200 : httpStatus).send({ jsonrpc: "2.0", id, error: { code, message, data: { standard: "MCP-2025-11-25", httpStatus } } });
}

function a2aMappedError(reply: any, id: unknown, error: unknown) {
  if (error instanceof BadRequestError) return a2aError(reply, id, -32602, error.message, 400);
  if (error instanceof ForbiddenError) return a2aError(reply, id, -32003, error.message, 403);
  if (error instanceof ConflictError) return a2aError(reply, id, -32009, error.message, 409);
  throw error;
}

function mcpMappedError(reply: any, id: unknown, error: unknown) {
  if (error instanceof BadRequestError) return mcpError(reply, id, -32602, error.message, 400);
  if (error instanceof ForbiddenError) return mcpError(reply, id, -32003, error.message, 403);
  if (error instanceof ConflictError) return mcpError(reply, id, -32009, error.message, 409);
  throw error;
}

function buildOpenApi(publicBaseUrl: string) {
  return {
    openapi: "3.1.0",
    info: { title: "Agent Lobby Server API", version: "0.1.0" },
    servers: [{ url: publicBaseUrl.replace(/\/$/, "") }],
    paths: {
      "/a2a": { post: { summary: "A2A v1.0.1 JSON-RPC endpoint" } },
      "/mcp": { post: { summary: "MCP 2025-11-25 Streamable HTTP endpoint" } },
      "/v1/lobbies": {
        get: { summary: "List authorized lobbies", security: [{ bearerAuth: [] }], responses: { "200": jsonResponse("Authorized lobbies", { type: "array", items: lobbySchema() }, []) } },
        post: { summary: "Create governed lobby", security: [{ bearerAuth: [] }], requestBody: jsonRequest(lobbyCreateSchema(), { purpose: "Coordinate an approved bounded task", limits: { maxMessages: 10 }, retentionPolicy: { plaintextMessageStorage: false }, approvalPolicy: { blockingByDefault: true }, expiresAt: "2030-01-01T00:00:00.000Z" }), responses: { "201": jsonResponse("Lobby created", lobbySchema(), lobbyExample()), "400": errorResponse() } }
      },
      "/v1/lobbies/{lobbyId}": { get: { summary: "Get an authorized lobby" } },
      "/v1/lobbies/{lobbyId}/cancel": { post: { summary: "Cancel an authorized lobby" } },
      "/v1/lobbies/{lobbyId}/events": { get: { summary: "Secure event catch-up and reconnect endpoint" } },
      "/v1/lobbies/{lobbyId}/invitations": { post: { summary: "Create a short-lived, human-readable pairing code", security: [{ bearerAuth: [] }], parameters: [lobbyIdParameter()], requestBody: jsonRequest(invitationCreateSchema(), { role: "counterparty", expiresAt: "2030-01-01T00:10:00.000Z" }), responses: { "201": jsonResponse("One-time pairing code created", invitationSchema(), { id: "00000000-0000-0000-0000-000000000001", pairingCode: "ABCD-EFGH-JKLM", expiresAt: "2030-01-01T00:10:00.000Z" }), "400": errorResponse(), "403": errorResponse() } } },
      "/v1/lobbies/{lobbyId}/join": { post: { summary: "Redeem a one-time pairing code as the authenticated counterparty agent", security: [{ bearerAuth: [] }], parameters: [lobbyIdParameter()], requestBody: jsonRequest(joinLobbySchema(), { pairingCode: "ABCD-EFGH-JKLM" }), responses: { "200": jsonResponse("Lobby joined", lobbySchema(), { ...lobbyExample(), status: "active" }), "400": errorResponse(), "409": errorResponse() } } },
      "/v1/lobbies/{lobbyId}/messages": { post: { summary: "Send a scoped lobby message" } },
      "/v1/lobbies/{lobbyId}/messages/{messageId}/acknowledgements": { post: { summary: "Acknowledge an ordered lobby message" } },
        "/v1/lobbies/{lobbyId}/approval-proposals": { post: { summary: "Create canonical, all-required two-owner approval proposal" } },
       "/v1/lobbies/{lobbyId}/approval-proposals/{proposalId}/revisions": { post: { summary: "Supersede an approval proposal with a canonical revision" } },
       "/v1/lobbies/{lobbyId}/approval-proposals/{proposalId}/activation": { post: { summary: "Authenticated adapter issues one short activation code and safe portal URL" } },
       "/v1/lobbies/{lobbyId}/approval-proposals/{proposalId}/recover": { post: { summary: "Authorized durable approval checkpoint recovery" } },
      "/v1/lobbies/{lobbyId}/agreements": { post: { summary: "Propose the first immutable agreement version" } },
      "/v1/lobbies/{lobbyId}/agreements/{agreementId}/versions": { post: { summary: "Propose a new immutable agreement version" } },
      "/v1/lobbies/{lobbyId}/agreements/{agreementId}/approvals": { post: { summary: "Approve an exact agreement version and canonical hash" } },
       "/control-plane": { get: { summary: "Fallback recovery control plane" } }
       ,"/activate": { get: { summary: "Public one-time approval activation page" }, post: { summary: "Redeem a device code for a scoped HttpOnly approval session" } }
    },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "opaque" } } }
  };
}

function jsonRequest(schema: Record<string, unknown>, value: Record<string, unknown>) {
  return { required: true, content: { "application/json": { schema, examples: { example: { summary: "Valid request", value } } } } };
}

function jsonResponse(description: string, schema: Record<string, unknown>, value: unknown) {
  return { description, content: { "application/json": { schema, examples: { example: { summary: description, value } } } } };
}

function errorResponse() { return jsonResponse("Field-specific validation error", { type: "object", required: ["error", "message"], properties: { error: { type: "string", example: "bad_request" }, message: { type: "string", example: "role must be \"counterparty\"" } } }, { error: "bad_request", message: "role must be \"counterparty\"" }); }
function lobbyIdParameter() { return { name: "lobbyId", in: "path", required: true, schema: { type: "string", format: "uuid" }, description: "Lobby identifier." }; }
function lobbyCreateSchema() { return { type: "object", additionalProperties: false, required: ["purpose", "limits", "retentionPolicy", "approvalPolicy", "expiresAt"], properties: { purpose: { type: "string", minLength: 8, description: "Bounded coordination purpose." }, limits: { type: "object", description: "Explicit lobby limits." }, retentionPolicy: { type: "object", required: ["plaintextMessageStorage"], properties: { plaintextMessageStorage: { const: false, description: "Must be false." } } }, approvalPolicy: { type: "object", required: ["blockingByDefault"], properties: { blockingByDefault: { const: true, description: "Must be true." } } }, expiresAt: { type: "string", format: "date-time", description: "Required expiry timestamp." } } }; }
function invitationCreateSchema() { return { type: "object", additionalProperties: false, required: ["role", "expiresAt"], properties: { role: { type: "string", enum: ["counterparty"], description: "The only permitted second-party role." }, expiresAt: { type: "string", format: "date-time", description: "Required invitation expiry; no default is applied." } } }; }
function joinLobbySchema() { return { type: "object", additionalProperties: false, required: ["pairingCode"], properties: { pairingCode: { type: "string", pattern: "^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){2}$", description: "One-time pairing code received privately." } } }; }
function lobbySchema() { return { type: "object", required: ["id", "organizationId", "purpose", "limits", "retentionPolicy", "approvalPolicy", "status", "expiresAt", "closeReason"], properties: { id: { type: "string", format: "uuid" }, organizationId: { type: "string", format: "uuid" }, purpose: { type: "string" }, limits: { type: "object" }, retentionPolicy: { type: "object" }, approvalPolicy: { type: "object" }, status: { type: "string", enum: ["pending", "active", "blocked", "closed", "cancelled", "expired"] }, expiresAt: { type: "string", format: "date-time" }, closeReason: { type: ["string", "null"] } } }; }
function invitationSchema() { return { type: "object", required: ["id", "pairingCode", "expiresAt"], properties: { id: { type: "string", format: "uuid" }, pairingCode: { type: "string", pattern: "^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){2}$" }, expiresAt: { type: "string", format: "date-time" } } }; }
function lobbyExample() { return { id: "00000000-0000-0000-0000-000000000001", organizationId: "00000000-0000-0000-0000-000000000002", purpose: "Coordinate an approved bounded task", limits: { maxMessages: 10 }, retentionPolicy: { plaintextMessageStorage: false }, approvalPolicy: { blockingByDefault: true }, status: "pending", expiresAt: "2030-01-01T00:00:00.000Z", closeReason: null }; }

function controlPlaneHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>A2A Lobby — Recovery</title><link rel="stylesheet" href="/control-plane.css"></head><body><main><header><p class="product">A2A Lobby</p><h1>Recovery and administration</h1></header><section class="panel"><h2>Authenticate</h2><p class="muted">Use your agent credential for authorized recovery and audit access. It is kept only in this browser tab and cannot approve protected actions.</p><form id="auth-form"><label for="token">Bearer credential</label><input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required><div class="actions"><button type="submit">Store credential</button><button id="clear" class="secondary" type="button">Clear</button></div></form><p id="status" class="muted">No credential loaded.</p></section><p class="footnote">Protected actions require the approval-proposal device-code flow and both owner checkpoints. Final agreements use their separate immutable bilateral workflow.</p></main><script src="/control-plane.js" defer></script></body></html>`;
}

function activationHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>A2A Lobby — Activate approval</title><link rel="stylesheet" href="/control-plane.css"></head><body><main><header><p class="product">A2A Lobby</p><h1>Activate approval</h1></header><section class="panel"><p class="muted">Enter the one-time code shown by your agent adapter. The code is never placed in a URL or stored by this browser.</p><form id="activate"><label for="code">Device code</label><input id="code" autocomplete="one-time-code" required pattern="[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}"><div class="actions"><button>Continue</button></div></form><p id="message" class="muted"></p></section><section id="decision" class="panel" hidden><h2>Approval proposal</h2><pre id="proposal"></pre><div class="actions"><button id="approve">Approve</button><button id="changes" class="secondary">Request changes</button><button id="reject" class="secondary">Reject</button></div></section></main><script src="/activate.js" defer></script></body></html>`;
}

function approvalCookie(session: string): string {
  return `al_approval_session=${encodeURIComponent(session)}; Path=/activate; HttpOnly; Secure; SameSite=Strict; Max-Age=600`;
}

function approvalSession(request: { headers: Record<string, string | string[] | undefined> }): string {
  const cookie = request.headers.cookie?.toString() ?? "";
  return cookie.split(/;\s*/).find((part) => part.startsWith("al_approval_session="))?.slice("al_approval_session=".length) ? decodeURIComponent(cookie.split(/;\s*/).find((part) => part.startsWith("al_approval_session="))!.slice("al_approval_session=".length)) : "";
}


function activationJs() {
  return `let csrf="";const message=document.querySelector("#message"),decision=document.querySelector("#decision"),proposal=document.querySelector("#proposal");async function request(path,options={}){const r=await fetch(path,{...options,headers:{"content-type":"application/json",...(options.headers||{})}});if(!r.ok)throw new Error("Unable to complete this approval action.");return r.json()}document.querySelector("#activate").addEventListener("submit",async e=>{e.preventDefault();try{const code=document.querySelector("#code").value.trim();const data=await request("/activate",{method:"POST",body:JSON.stringify({deviceCode:code})});csrf=data.csrfToken;document.querySelector("#code").value="";const current=await request(data.next);proposal.textContent=JSON.stringify(current.approval,null,2);decision.hidden=false;message.textContent="Review the exact version before deciding."}catch(_){message.textContent="Activation failed or has expired."}});async function decide(value){try{await request("/activate/approval/decision",{method:"POST",headers:{"x-csrf-token":csrf,"idempotency-key":crypto.randomUUID()},body:JSON.stringify({decision:value})});csrf="";decision.hidden=true;message.textContent="Decision recorded."}catch(_){message.textContent="Decision could not be recorded."}}document.querySelector("#approve").addEventListener("click",()=>decide("approved"));document.querySelector("#changes").addEventListener("click",()=>decide("changes_requested"));document.querySelector("#reject").addEventListener("click",()=>decide("rejected"));`;
}

function controlPlaneCss() {
  return `:root{color-scheme:light;font-family:Arial,Helvetica,sans-serif;color:#202020;background:#f4f4f1}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f4f4f1;line-height:1.5}main{width:min(760px,calc(100% - 32px));margin:0 auto;padding:48px 0}header{margin:0 0 28px}.product{margin:0 0 5px;color:#666;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}h1,h2{font-family:Georgia,"Times New Roman",serif;font-weight:400}h1{margin:0;font-size:32px;line-height:1.15}h2{margin:0 0 14px;font-size:21px}.panel{margin:16px 0;padding:24px;border:1px solid #d1d1cb;background:#fff}.muted,.footnote{margin:0;color:#666;font-size:14px}label{display:block;margin:18px 0 6px;font-size:14px;font-weight:700}input{display:block;width:100%;padding:10px 11px;border:1px solid #aaa;background:#fff;color:#202020;font:16px Arial,Helvetica,sans-serif}.actions{display:flex;gap:8px;margin-top:14px}button{border:1px solid #202020;border-radius:0;padding:9px 13px;background:#202020;color:#fff;font:14px Arial,Helvetica,sans-serif;cursor:pointer}button:hover{background:#444}button.secondary{background:#fff;color:#202020}.empty-state{padding:14px;border:1px solid #d1d1cb;color:#666;font-size:14px}.approval{margin:12px 0;padding:16px;border:1px solid #d1d1cb;background:#fff}.approval h3{margin:0 0 12px;font:700 16px Arial,Helvetica,sans-serif}.approval dl{display:grid;grid-template-columns:110px 1fr;gap:6px 12px;margin:0;font-size:14px}.approval dt{color:#666}.approval dd{margin:0;overflow-wrap:anywhere}.approval .actions{margin-top:16px}.footnote{margin:18px 0}@media(max-width:520px){main{width:min(100% - 24px,760px);padding:28px 0}.panel{padding:18px}.approval dl{grid-template-columns:1fr}.approval dt{margin-top:6px}}`;
}

function controlPlaneJs() {
  return `const key="agentLobbyBearerCredential",form=document.querySelector("#auth-form"),token=document.querySelector("#token"),status=document.querySelector("#status"),clear=document.querySelector("#clear");form.addEventListener("submit",e=>{e.preventDefault();sessionStorage.setItem(key,token.value.trim());token.value="";status.textContent="Credential stored for recovery/admin access only."});clear.addEventListener("click",()=>{sessionStorage.removeItem(key);status.textContent="Session token cleared."});`;
  return `const key="agentLobbyBearerCredential",form=document.querySelector("#auth-form"),token=document.querySelector("#token"),approvals=document.querySelector("#approvals"),clear=document.querySelector("#clear");form.addEventListener("submit",async e=>{e.preventDefault();sessionStorage.setItem(key,token.value.trim());token.value="";await loadApprovals()});clear.addEventListener("click",()=>{sessionStorage.removeItem(key);approvals.textContent="Session token cleared."});async function api(path,options={}){const value=sessionStorage.getItem(key);if(!value)throw new Error("Paste your agent bearer credential first.");return fetch(path,{...options,headers:{"content-type":"application/json",authorization:"Bearer "+value,...(options.headers||{})}})}async function decide(lobbyId,approvalId,decision){const response=await api("/v1/lobbies/"+encodeURIComponent(lobbyId)+"/approvals/"+encodeURIComponent(approvalId)+"/decision",{method:"POST",body:JSON.stringify({decision})});if(!response.ok)throw new Error(await response.text());await loadApprovals()}async function loadApprovals(){try{const response=await api("/v1/approvals/pending");if(!response.ok)throw new Error(await response.text());const data=await response.json();approvals.replaceChildren(...(data.approvals.length?data.approvals.map(renderApproval):[document.createTextNode("No pending approvals for this owner/agent credential.")]))}catch(error){approvals.textContent=error.message}}function renderApproval(approval){const card=document.createElement("article");card.className="approval";card.innerHTML="<h3>"+escapeHtml(approval.question)+"</h3><dl><dt>Lobby ID</dt><dd><code>"+escapeHtml(approval.lobbyId)+"</code></dd><dt>Reason</dt><dd>"+escapeHtml(approval.reason)+"</dd><dt>Type</dt><dd>"+escapeHtml(approval.type)+"</dd><dt>Expiry</dt><dd>"+escapeHtml(approval.expiresAt)+"</dd></dl>";const actions=document.createElement("div");actions.className="actions";const approve=document.createElement("button");approve.textContent="Approve";approve.addEventListener("click",()=>decide(approval.lobbyId,approval.id,"approved").catch(error=>approvals.textContent=error.message));const reject=document.createElement("button");reject.textContent="Reject";reject.className="reject";reject.addEventListener("click",()=>decide(approval.lobbyId,approval.id,"rejected").catch(error=>approvals.textContent=error.message));actions.append(approve,reject);card.append(actions);return card}function escapeHtml(value){return String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}if(sessionStorage.getItem(key))loadApprovals();`;
}

async function publishLobbyEvent(redis: any, lobbyId: string, type: string, payload: unknown): Promise<void> {
  if (!redis) return;
  await redis.publish(`lobby:${lobbyId}:events`, JSON.stringify({ type, lobbyId, payload }));
}

function requestIdempotencyKey(request: { headers: Record<string, string | string[] | undefined>; id?: string }): string | undefined {
  return request.headers["idempotency-key"]?.toString() ?? request.headers["x-request-id"]?.toString() ?? request.id;
}

function sendMappedError(reply: any, error: unknown) {
  if (error instanceof BadRequestError) return reply.code(400).send({ error: "bad_request", message: error.message });
  if (error instanceof ForbiddenError) return reply.code(403).send({ error: "forbidden", message: error.message });
  if (error instanceof ConflictError) return reply.code(409).send({ error: "conflict", message: error.message });
  throw error;
}

function legacyApprovalFlowDisabled(reply: any) {
  return reply.code(410).send({ error: "legacy_approval_flow_disabled", message: "legacy protected approvals cannot authorize actions; use approval-proposals and the two-owner device-code checkpoint flow" });
}
