# Standards Pinning

This first vertical slice pins the A2A Agent Card shape used by the service to `protocolVersion: 1.0.1` per `docs/EXECUTION_CONTRACT.md`.

- A2A: v1.0.1 placeholder pending online verification of the current official release and schema before expanded contract compliance work.
- Agent Lobby extension namespace: `https://agent-lobby.invalid/extensions/...` is a non-production placeholder until Paulo provides and approves the final deployment hostname.
- MCP: implemented as Streamable HTTP pinned to `2025-11-25`; `approval.activation.issue` lets an authenticated adapter issue a one-time activation code plus a code-free `portalUrl`, and `approval.recover` reports/settles an expired durable checkpoint. Public tools intentionally exclude approval-surface registration and approval decision tools. Human decisions occur only through scoped `/activate` sessions.

## Approval control-plane contract

Approval proposals progress as `requested`, `awaiting_both_owners`, `partially_approved`, `approved`, `rejected`, `changes_requested`, `expired`, `cancelled`, or `superseded`. Each proposal revision creates a durable checkpoint: `suspended`, `awaiting_approval`, `resumable`, `rejected`, `expired`, or `cancelled`. A checkpoint is `resumable` only when both current decision targets approve the same revision. Rejections and change requests keep the lobby blocked. Revisions supersede every earlier decision target and revoke its activation/session.

Events are durable audit records and live notifications: `approval.required`, `approval.updated`, `approval.resolved`, and (only for bilateral approval) `checkpoint.resumable`. Their payloads include approval ID, revision, canonical hash, proposal state, and checkpoint state. WebSocket upgrades authenticate only with the `Authorization` header; clients attach listeners before awaiting `ready`. Query credentials receive an explicit HTTP 400 error.

Production deployment is blocked until official standards URLs, final hostname, DNS, TLS, and deployment scope are explicitly approved.
