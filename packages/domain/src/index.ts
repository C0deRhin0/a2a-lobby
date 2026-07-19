import { z } from "zod";

export const lobbyIdSchema = z.string().uuid();
export const participantRoleSchema = z.enum(["initiator", "counterparty"]);
export const lobbyStatusSchema = z.enum(["pending", "active", "blocked", "closed", "cancelled", "expired"]);

export const retentionPolicySchema = z.object({
  messageTtlDays: z.number().int().positive().max(365),
  auditTtlDays: z.number().int().positive().max(3650),
  plaintextMessageStorage: z.literal(false).default(false)
});

export const approvalPolicySchema = z.object({
  requiresHumanApprovalFor: z.array(z.enum([
    "deadline_commitment",
    "scope_change",
    "financial_commitment",
    "legal_commitment",
    "sensitive_disclosure",
    "external_action",
    "work_assignment",
    "final_agreement"
  ])).min(1),
  blockingByDefault: z.literal(true)
});

export const lobbySchema = z.object({
  id: lobbyIdSchema,
  organizationId: z.string().uuid(),
  purpose: z.string().min(8).max(500),
  limits: z.record(z.string(), z.unknown()),
  status: lobbyStatusSchema,
  retentionPolicy: retentionPolicySchema,
  approvalPolicy: approvalPolicySchema,
  expiresAt: z.string().datetime(),
  closeReason: z.string().max(200).nullable()
});

export const a2aExtensionSchema = z.object({
  uri: z.string().url(),
  description: z.string().min(1),
  required: z.boolean(),
  version: z.string().regex(/^v\d+$/)
});

export const agentCardSchema = z.object({
  protocolVersion: z.literal("1.0.1"),
  name: z.literal("Agent Lobby"),
  description: z.string().min(1),
  url: z.string().url(),
  preferredTransport: z.literal("JSONRPC"),
  capabilities: z.object({
    streaming: z.boolean(),
    pushNotifications: z.boolean(),
    stateTransitionHistory: z.boolean()
  }),
  authentication: z.object({
    schemes: z.array(z.literal("Bearer")).min(1)
  }),
  defaultInputModes: z.array(z.string()).min(1),
  defaultOutputModes: z.array(z.string()).min(1),
  skills: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    tags: z.array(z.string())
  })).min(1),
  extensions: z.array(a2aExtensionSchema).length(3)
});

export type AgentCard = z.infer<typeof agentCardSchema>;
export type Lobby = z.infer<typeof lobbySchema>;
