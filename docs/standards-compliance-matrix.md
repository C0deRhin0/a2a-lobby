# Standards Compliance Matrix

| Surface | Standard | Status | Implementation |
| --- | --- | --- | --- |
| A2A Agent Card | A2A v1.0.1 | Implemented | `GET /.well-known/agent-card.json`, `POST /a2a` method `AgentCard` advertise JSON-RPC, bearer auth, streaming, and state history. |
| A2A task methods | A2A v1.0.1 | Implemented | `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask` map lobby state to task state and preserve governance errors. |
| A2A errors | JSON-RPC 2.0 / A2A v1.0.1 | Implemented | Error objects include `code`, `message`, and `data.standard = A2A-1.0.1` with HTTP status metadata. |
| MCP transport | MCP 2025-11-25 Streamable HTTP | Implemented | `POST /mcp` supports `initialize`, `tools/list`, `tools/call`, and `mcp-session-id` response/header continuity. |
| MCP tools | MCP 2025-11-25 | Implemented | Scoped tools cover lobby create/get/list/cancel, message send/ack, approval request, `approval.activation.issue`, agreement propose/approve, and audit list. Public MCP does not expose approval-surface registration or approval decision tools. |
| Event reconnect | Secure catch-up stream | Implemented | `GET /v1/lobbies/{lobbyId}/events?from=<cursor>` is bearer-authenticated, `no-store`, object-authorized, and returns reconnect cursor metadata. |
| Client SDKs | Reference connectors | Implemented | TypeScript and Python SDKs preserve local session to lobby/task/MCP-session/cursor mappings. |
| Web approval UI | Scoped web activation | Implemented | `GET/POST /activate` redeems an adapter-issued one-time code into a short-lived `HttpOnly; Secure; SameSite=Strict` session. CSRF-protected decisions are bound to the durable proposal revision and target owner; codes, session secrets, and credential-like query parameters are rejected from URLs. `/control-plane` is recovery/admin only. |
| OpenAPI | OpenAPI 3.1 | Implemented | `GET /openapi.json` and `docs/openapi.json` describe standards surfaces. |
| CI | Build/test gate | Implemented | `.github/workflows/ci.yml` runs install, typecheck, and tests. |
