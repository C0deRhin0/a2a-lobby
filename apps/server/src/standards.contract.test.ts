import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const testConfig = {
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgres://agent_lobby:agent_lobby_dev@localhost:5432/agent_lobby",
  redisUrl: "redis://localhost:6379",
  publicBaseUrl: "http://localhost:3000/"
};

describe("standards client surfaces", () => {
  it("serves an A2A v1.0.1 JSON-RPC endpoint with Agent Card and standards-shaped errors", async () => {
    const app = await buildApp(testConfig);

    const card = await app.inject({ method: "POST", url: "/a2a", payload: { jsonrpc: "2.0", id: "card", method: "AgentCard" } });
    const unknown = await app.inject({ method: "POST", url: "/a2a", payload: { jsonrpc: "2.0", id: "bad", method: "Nope" } });

    expect(card.statusCode).toBe(200);
    expect(card.json()).toMatchObject({ jsonrpc: "2.0", id: "card", result: { protocolVersion: "1.0.1", preferredTransport: "JSONRPC" } });
    expect(card.json().result.capabilities).toMatchObject({ streaming: true, stateTransitionHistory: true });
    expect(unknown.json()).toMatchObject({ jsonrpc: "2.0", id: "bad", error: { code: -32601, data: { standard: "A2A-1.0.1" } } });

    await app.close();
  });

  it("exposes MCP Streamable HTTP initialize, tools/list, tools/call, and session behavior", async () => {
    const app = await buildApp(testConfig);

    const init = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "contract", version: "0" } } } });
    expect(init.statusCode).toBe(200);
    expect(init.headers["mcp-session-id"]).toEqual(expect.any(String));
    expect(init.json()).toMatchObject({ result: { protocolVersion: "2025-11-25", serverInfo: { name: "agent-lobby-server" } } });

    const sessionId = init.headers["mcp-session-id"] as string;
    const tools = await app.inject({ method: "POST", url: "/mcp", headers: { "mcp-session-id": sessionId }, payload: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    const toolNames = tools.json().result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual([
      "lobby.create",
      "lobby.get",
      "lobby.list",
      "lobby.cancel",
      "lobby.join",
      "invitation.create",
      "message.send",
      "message.acknowledge",
      "approval.activation.issue",
      "approval.recover",
      "agreement.propose",
      "agreement.approve",
      "audit.list"
    ]);
    expect(toolNames).not.toContain("approval.surface.put");
    expect(toolNames).not.toContain("approval.decide");
    const toolsByName = Object.fromEntries(tools.json().result.tools.map((tool: { name: string }) => [tool.name, tool]));
    expect(toolsByName["lobby.create"].inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["purpose", "limits", "retentionPolicy", "approvalPolicy", "expiresAt"],
      properties: {
        purpose: { type: "string", description: expect.any(String), examples: [expect.any(String)] },
        expiresAt: { type: "string", format: "date-time" }
      }
    });
    expect(toolsByName["invitation.create"].inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["lobbyId", "role", "expiresAt"],
      properties: {
        role: { enum: ["counterparty"], description: expect.any(String), examples: ["counterparty"] }
      }
    });
    expect(toolsByName["lobby.join"].inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["lobbyId", "pairingCode"],
      properties: { pairingCode: { description: expect.any(String), examples: ["ABCD-EFGH-JKLM"] } }
    });

    const unauthCall = await app.inject({ method: "POST", url: "/mcp", headers: { "mcp-session-id": sessionId }, payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lobby.list", arguments: {} } } });
    expect(unauthCall.json()).toMatchObject({ error: { code: -32001, data: { standard: "MCP-2025-11-25", httpStatus: 401 } } });

    await app.close();
  });

  it("serves reconnect/catch-up metadata, control-plane fallback UI, OpenAPI, docs, and SDK sources", async () => {
    const app = await buildApp(testConfig);

    const events = await app.inject({ method: "GET", url: "/v1/lobbies/00000000-0000-0000-0000-000000000000/events?from=0" });
    const ui = await app.inject({ method: "GET", url: "/control-plane" });
    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });

    expect(events.statusCode).toBe(401);
    expect(events.headers["cache-control"]).toBe("no-store");
    const controlPlaneCss = await app.inject({ method: "GET", url: "/control-plane.css" });
    const controlPlaneJs = await app.inject({ method: "GET", url: "/control-plane.js" });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers["cache-control"]).toBe("no-store");
    expect(ui.body).toContain('href="/control-plane.css"');
    expect(ui.body).toContain('src="/control-plane.js"');
    expect(ui.body).not.toContain("<style>");
    expect(ui.body).not.toContain("<script type=");
    expect(controlPlaneCss.statusCode).toBe(200);
    expect(controlPlaneCss.headers["content-type"]).toContain("text/css");
    expect(controlPlaneCss.body).not.toContain("gradient");
    expect(controlPlaneCss.body).not.toContain("clamp(");
    expect(controlPlaneCss.body).toContain("Arial");
    expect(controlPlaneJs.statusCode).toBe(200);
    expect(controlPlaneJs.headers["content-type"]).toContain("application/javascript");
    expect(controlPlaneJs.body).toContain("sessionStorage");
    expect(controlPlaneJs.body).not.toContain("/v1/approvals/pending");
    expect(controlPlaneJs.body).not.toContain("/approvals/");
    expect(openapi.json()).toMatchObject({ openapi: "3.1.0", info: { title: "Agent Lobby Server API" } });
    const openApiPaths = openapi.json().paths;
    expect(openApiPaths["/v1/lobbies"].post).toMatchObject({
      requestBody: {
        required: true,
        content: { "application/json": { schema: { required: ["purpose", "limits", "retentionPolicy", "approvalPolicy", "expiresAt"] }, examples: expect.any(Object) } }
      },
      responses: {
        "201": { description: expect.any(String), content: { "application/json": { schema: { required: ["id", "organizationId", "purpose", "limits", "retentionPolicy", "approvalPolicy", "status", "expiresAt", "closeReason"] }, examples: expect.any(Object) } } }
      }
    });
    expect(openApiPaths["/v1/lobbies/{lobbyId}/invitations"].post).toMatchObject({
      requestBody: {
        required: true,
        content: { "application/json": { schema: { required: ["role", "expiresAt"], properties: { role: { enum: ["counterparty"] } } }, examples: expect.any(Object) } }
      },
      responses: {
        "201": { content: { "application/json": { schema: { required: ["id", "pairingCode", "expiresAt"] }, examples: expect.any(Object) } } }
      }
    });
    expect(openApiPaths["/v1/lobbies/{lobbyId}/join"].post).toMatchObject({
      requestBody: {
        required: true,
        content: { "application/json": { schema: { required: ["pairingCode"] }, examples: expect.any(Object) } }
      },
      responses: {
        "200": { content: { "application/json": { schema: { required: ["id", "organizationId", "purpose", "limits", "retentionPolicy", "approvalPolicy", "status", "expiresAt", "closeReason"] }, examples: expect.any(Object) } } }
      }
    });
    expect(Object.keys(openapi.json().paths).sort()).toEqual([
      "/a2a",
      "/activate",
      "/control-plane",
      "/mcp",
      "/v1/lobbies",
      "/v1/lobbies/{lobbyId}",
      "/v1/lobbies/{lobbyId}/agreements",
      "/v1/lobbies/{lobbyId}/agreements/{agreementId}/approvals",
      "/v1/lobbies/{lobbyId}/agreements/{agreementId}/versions",
      "/v1/lobbies/{lobbyId}/approval-proposals",
      "/v1/lobbies/{lobbyId}/approval-proposals/{proposalId}/activation",
      "/v1/lobbies/{lobbyId}/approval-proposals/{proposalId}/recover",
      "/v1/lobbies/{lobbyId}/approval-proposals/{proposalId}/revisions",
      "/v1/lobbies/{lobbyId}/cancel",
      "/v1/lobbies/{lobbyId}/events",
      "/v1/lobbies/{lobbyId}/invitations",
      "/v1/lobbies/{lobbyId}/join",
      "/v1/lobbies/{lobbyId}/messages",
      "/v1/lobbies/{lobbyId}/messages/{messageId}/acknowledgements"
    ]);
    expect(Object.keys(openapi.json().paths)).not.toContain("/v1/lobbies/{lobbyId}/approval-surface");
    expect(Object.keys(openapi.json().paths)).not.toContain("/v1/lobbies/{lobbyId}/approvals");
    expect(Object.keys(openapi.json().paths)).not.toContain("/v1/lobbies/{lobbyId}/approvals/{approvalId}/decision");
    expect(controlPlaneJs.body).not.toContain("/approvals/");

    const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    await expect(readFile(join(root, "docs/standards-compliance-matrix.md"), "utf8")).resolves.toContain("A2A v1.0.1");
    await expect(readFile(join(root, "apps/server/src/app.ts"), "utf8")).resolves.toContain("Bearer credential");
    await expect(readFile(join(root, "packages/sdk-ts/src/index.ts"), "utf8")).resolves.toContain("class AgentLobbyClient");
    await expect(readFile(join(root, "packages/sdk-python/agent_lobby/client.py"), "utf8")).resolves.toContain("class AgentLobbyClient");

    await app.close();
  });
});
