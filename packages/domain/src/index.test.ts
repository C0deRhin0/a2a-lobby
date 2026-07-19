import { describe, expect, it } from "vitest";
import { agentCardSchema, lobbySchema } from "./index.js";

describe("domain schemas", () => {
  it("requires exactly the declared Agent Lobby A2A extensions", () => {
    const result = agentCardSchema.safeParse({
      protocolVersion: "1.0.1",
      name: "Agent Lobby",
      description: "Governed A2A lobby",
      url: "http://localhost:3000",
      preferredTransport: "JSONRPC",
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: true
      },
      authentication: { schemes: ["Bearer"] },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: [{ id: "lobby", name: "Lobby", description: "Two-party lobby", tags: ["a2a"] }],
      extensions: [
        { uri: "https://agent-lobby.invalid/extensions/two-party-lobby/v1", description: "Two party", required: true, version: "v1" },
        { uri: "https://agent-lobby.invalid/extensions/human-approval/v1", description: "Approval", required: true, version: "v1" },
        { uri: "https://agent-lobby.invalid/extensions/bilateral-agreement/v1", description: "Agreement", required: true, version: "v1" }
      ]
    });

    expect(result.success).toBe(true);
  });

  it("rejects plaintext message retention by default invariant", () => {
    const result = lobbySchema.safeParse({
      id: "6f0d2325-51c6-41b2-8e69-7f8ecfc29302",
      organizationId: "3b154d04-ad8d-4ebb-997b-ad70868e2262",
      purpose: "Coordinate a bounded two-agent task",
      limits: { maxMessages: 100 },
      status: "active",
      retentionPolicy: {
        messageTtlDays: 30,
        auditTtlDays: 365,
        plaintextMessageStorage: true
      },
      approvalPolicy: {
        requiresHumanApprovalFor: ["final_agreement"],
        blockingByDefault: true
      },
      expiresAt: "2026-08-01T00:00:00.000Z",
      closeReason: null
    });

    expect(result.success).toBe(false);
  });
});
