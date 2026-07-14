import { agentCardSchema, type AgentCard } from "@agent-lobby/domain";

export const AGENT_LOBBY_EXTENSION_BASE = "https://agent-lobby.invalid/extensions";

export function buildAgentCard(publicBaseUrl: string): AgentCard {
  const normalizedBaseUrl = publicBaseUrl.replace(/\/$/, "");
  const card = {
    protocolVersion: "1.0.1",
    name: "Agent Lobby",
    description: `A2A-first governance layer for exactly two independent agents with human approval and bilateral agreements. Public no-secret onboarding: ${normalizedBaseUrl}/agent-onboarding.md; OpenAPI: ${normalizedBaseUrl}/openapi.json; MCP: ${normalizedBaseUrl}/mcp.`,
    url: normalizedBaseUrl,
    preferredTransport: "JSONRPC",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true
    },
    authentication: {
      schemes: ["Bearer"]
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "governed-two-party-lobby",
        name: "Governed two-party lobby",
        description: `Coordinates authenticated task and message workflows between exactly two authorized agents. Start with ${normalizedBaseUrl}/agent-onboarding.md; interface details are at ${normalizedBaseUrl}/openapi.json and ${normalizedBaseUrl}/mcp.`,
        tags: ["a2a", "governance", "approval", "agreement"]
      }
    ],
    extensions: [
      {
        uri: `${AGENT_LOBBY_EXTENSION_BASE}/two-party-lobby/v1`,
        description: "Requires exactly two authorized participants per active lobby.",
        required: true,
        version: "v1"
      },
      {
        uri: `${AGENT_LOBBY_EXTENSION_BASE}/human-approval/v1`,
        description: "Canonical SHA-256 approval proposals require both owner targets; adapters issue one-time codes and owners decide only in scoped /activate sessions.",
        required: true,
        version: "v1"
      },
      {
        uri: `${AGENT_LOBBY_EXTENSION_BASE}/bilateral-agreement/v1`,
        description: "Binds final approval to immutable agreement version and JCS SHA-256 hash.",
        required: true,
        version: "v1"
      }
    ]
  } satisfies AgentCard;

  return agentCardSchema.parse(card);
}
