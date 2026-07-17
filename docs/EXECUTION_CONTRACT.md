# Agent Lobby Production Implementation /goal

> **For Hermes:** Treat this as the execution contract for a long-running `/goal`. Continue until every completion criterion is verified or an external prerequisite requiring Paulo's input/approval blocks progress. Do not replace verified implementation evidence with a plan or simulated output.

**Goal:** Build, test, document, and prepare for approved public deployment of a production-grade, self-hosted Agent Lobby platform: an A2A-first, MCP-enabled governance layer for two independent AI agents.

**Workspace and profile:**
- Use the current `default` Hermes profile only; do not create or use a separate Hermes profile for this project.
- Project root: `/srv/workspaces/Github/agent-lobby-server/`
- Source repository: `/srv/workspaces/Github/agent-lobby-server/codebase/`
- Local harness: `/srv/workspaces/Github/agent-lobby-server/.opencode/`
- Initialize a local git repository if absent. Do not push or create a remote repository without Paulo's explicit approval.

**Product definition:**
Agent Lobby is a self-hosted, production-grade coordination and governance platform where exactly two independent agents retain their local private context but coordinate through authenticated, durable, standards-based task and message workflows. The platform provides A2A interoperability, MCP tools, human approval checkpoints, immutable bilateral agreements, auditability, and a human web dashboard.

---

## Mandatory technology and protocol decisions

- Server: TypeScript on current supported Node.js LTS, Fastify, strict TypeScript, schema-first APIs.
- Web dashboard: TypeScript web application with authenticated approval, agreement, cancellation, and audit views.
- Durable authority: PostgreSQL. No in-memory state is authoritative.
- Ephemeral/distributed state: Redis for presence, Pub/Sub, locks, rate limits, idempotency coordination, queues, and reconnect/event fan-out.
- Packaging/deployment: Docker Compose, private Docker network, Caddy with automatic TLS, health/readiness checks, migrations, backup and restore tooling.
- A2A: implement against the current verified A2A release, initially pinning the implementation and contract tests to A2A v1.0.1 unless the official specification/repository at build time documents a newer stable release. Record the exact version and source URLs in `docs/standards.md`.
- MCP: use Streamable HTTP and implement against the exact current official MCP release verified at build time. Pin that release in source/docs and add compatibility tests. Do not use a draft or silently-following `latest` URL as a production dependency.
- Native governance: define versioned Agent Lobby extensions as A2A extensions, declared in the Agent Card. Use a project-owned HTTPS URI namespace under the final deployment hostname. Until the hostname is provided, use a documented non-production placeholder and block production deployment.
- Cryptographic agreement hash: RFC 8785 JSON Canonicalization Scheme (JCS) plus SHA-256, prefixed `sha256:`. Bind each approval decision to agreement ID, immutable version, and canonical-content hash.

## Required standards and governance behavior

### A2A-first interoperability

- Publish a conformant Agent Card at the A2A-defined discovery location.
- Implement the applicable A2A task, message, streaming/asynchronous update, artifact, error, authentication, version-negotiation, and idempotency requirements.
- Ensure ordinary A2A task/message operations cannot bypass participant, lobby, approval, retention, or agreement authorization.
- Define and document versioned Agent Lobby extensions for: `two-party-lobby`, `human-approval`, and `bilateral-agreement`.
- Declare extension support and whether each is required in the Agent Card. Use metadata/extensions without mutating A2A core types.
- Create contract tests using independently implemented/reference-compatible A2A clients where feasible; do not label internal JSON merely shaped like A2A as compliant.

### MCP platform interface

Expose MCP tools with JSON Schema input/output and lobby-scoped authorization:

`lobby_create`, `lobby_join`, `lobby_get_state`, `lobby_get_messages`, `lobby_send`, `lobby_acknowledge`, `lobby_request_approval`, `lobby_get_approval`, `lobby_propose_agreement`, `lobby_get_agreement`, `lobby_approve_agreement`, `lobby_leave`.

- MCP tools are an agent-to-platform interface; A2A remains the primary inter-agent task/message standard.
- Implement MCP Streamable HTTP session/resume/security behavior according to the pinned specification.
- Test MCP authorization isolation: a tool invocation scoped to one lobby never exposes another lobby.

### Governance invariants

- Exactly two authorized participants per active lobby; a third participant is rejected atomically.
- Every lobby has a purpose, limits, retention policy, expiry, cancellation path, approval policy, and close reason.
- Human approval is typed state only. Natural-language claims, timeouts, disconnections, silence, or a prior version's approval never prove approval.
- Blocking approval pauses only the applicable workflow and resumes only after an authorized human decision.
- Human approval is mandatory for deadline/scope/financial/legal commitments, sensitive disclosure, external action, work assignment/responsibility acceptance, and final agreement.
- Message text is untrusted data and cannot execute protocol commands, alter authorization, bypass approval, access another lobby, or cause code execution.
- Each client command is idempotent via authenticated request IDs. Messages/events are sequenced per lobby and support acknowledged delivery, reconnect, catch-up, and duplicate-safe processing.
- Define deterministic turn behavior: persist a message transactionally; recipient acknowledgment commits delivery; the recipient then owns the next turn. Define expiry and authorized recovery paths, and test them.
- Agreements are structured, immutable versions. Approval is valid only when both human owners approve the same agreement ID, version, and JCS/SHA-256 hash. A modification creates a new version and invalidates prior approvals.

### Security and privacy

- Separate and model human users, organizations, agents, connector instances, credentials, lobby participants, and active connections.
- Enforce object-level authorization on every data access and mutation.
- Use short-lived access tokens and lobby-scoped credentials. Store credential secrets only as secure hashes where possible; never log tokens, secrets, messages containing secret-like values, or private sessions.
- Implement one-time, expiring, revocable invitations with hashed-at-rest tokens and atomic consumption.
- Require TLS in production. PostgreSQL, Redis, admin APIs, backups, and metrics remain private-only.
- Implement rate limits across IP, principal, agent, connector, and lobby; use Redis-backed enforcement.
- Implement structured audit events that record security-relevant state transitions without storing private agent session histories or plaintext messages by default.
- Document the threat model, including replay, token theft, invitation theft, cross-lobby IDOR, injection, queue re-delivery, websocket reconnect, agreement-hash substitution, credential leakage, and compromised connector risks.
- Do not claim end-to-end encryption unless complete interoperable key lifecycle, authenticated key exchange, ciphertext handling, recovery constraints, and tests are implemented. If it cannot be fully verified, document it as intentionally out of scope rather than simulating it.

### Human approval delivery: authenticated web pilot

- The approved protected-action approval destination is the scoped `/activate` device-code flow, not native terminal/messaging/IDE delivery or `/control-plane`.
- `/control-plane` is bearer-authenticated recovery/admin UI only. The browser keeps a bearer credential only in `sessionStorage`; it must never appear in URLs, local storage, logs, or protected-action decision requests.
- The legacy pending-approval, request, and decision endpoints are disabled. They return a safe non-success response and are not published through OpenAPI or MCP.
- A durable protected-action decision is scoped, one-time, all-required, and accepted only after both owners complete separate device-code sessions. An initiator, third party, bearer control-plane credential, free-text claim, or unverified host-channel message is never sufficient proof of approval.
- If identity binding fails, the approval remains blocking; it must never downgrade to auto-approval or route to an arbitrary channel.

---

## Required deliverables

1. Production monorepo with documented architecture and project instructions.
2. PostgreSQL schema/migrations with constraints, indexes, transactions, and rollback-safe migration process.
3. Redis integration for distributed concerns; PostgreSQL remains the source of truth.
4. Auth/identity/lobby/invitation/authorization services.
5. A2A endpoint, Agent Card, extensions, streaming or asynchronous updates, and contract tests.
6. MCP Streamable HTTP server with the required scoped tool surface and protocol tests.
7. Native API and secure WebSocket/event-delivery service for SDKs/connectors/reconnect needs.
8. Authenticated web approval control plane, pending-approval API, one-time target-owner decisions, cancellation, agreement review, and authorized audit visibility. Public REST/MCP/OpenAPI flows must not expose the obsolete approval-surface adapter path.
9. Python and TypeScript SDKs plus reference connectors that map `lobby_id -> local_session_id` while retaining private context locally.
10. Docker Compose deployment, Caddy configuration/template, environment template, secret handling guidance, private-network boundaries, health/readiness endpoints, migrations job, backups and tested restore procedure.
11. Observability: structured JSON logs, metrics, request/event/lobby correlation IDs, tracing-ready boundaries, health/readiness endpoints, and operational runbook.
12. Complete docs: architecture, protocol/A2A extensions, MCP contract, API/OpenAPI, security/threat model, SDK use, deployment, operations, backup/restore, and interoperability tests.
13. Automated unit, integration, security, load/soak where practical, and end-to-end tests; CI workflow that runs the safe test/validation suite.

## Execution method

1. Inspect official current A2A and MCP specifications and their released schemas/SDKs before selecting libraries or writing protocol adapters. Record the exact versions and compliance matrix.
2. Seed the local project harness if missing and build the repository in `/srv/workspaces/Github/agent-lobby-server/codebase/`.
3. Use test-first implementation for state, authorization, agreement, protocol, and delivery invariants.
4. Keep implementation production-oriented but avoid speculative enterprise features not needed by this product definition (SSO/HA/multi-region may be explicitly documented as future work rather than partially built).
5. Run commands and tests continuously. Fix failures before advancing.
6. Do not use real secrets in fixtures or commit any secret, certificate private key, database dump, generated token, or `.env` file.
7. Before any public deployment, production firewall/proxy change, DNS modification, credential creation/rotation, certificate issuance, or remote push: stop and obtain Paulo's explicit confirmation with the exact hostname, deployment target, and scope. Build all deploy artifacts and preflight checks first.
8. If an external prerequisite is missing (hostname, DNS control, credentials, VPS approval, upstream standard ambiguity), continue all locally verifiable work and then report the exact blocker and the shortest required input. Do not invent access, endpoint responses, secrets, or successful deployment results.

## Completion criteria — do not declare completion until verified

### Local and containerized product proof

- A clean environment can start the full stack with PostgreSQL, Redis, platform services, dashboard, and reverse-proxy configuration using documented commands.
- Database migrations run successfully on a clean database and are verified by integration tests.
- Two independently running reference agents—one Python and one TypeScript—discover capabilities, authenticate, create/join an authorized lobby, and maintain distinct local session stores.
- The agents perform A2A-compatible task/message workflow, retrieve history, receive ordered events, acknowledge delivery, disconnect/reconnect, and resume safely from sequence checkpoints.
- A blocking approval is persisted, visible through authenticated web pending-approval listing only to the target owner/agent, pauses the relevant workflow, accepts only that owner's one-time authenticated approve/reject decision, rejects initiator/third-party/token-based decisions, notifies the correct agent, and resumes correctly.
- A structured agreement is proposed; canonical content/hash are independently verified; both human owners approve exactly the same version/hash; the lobby becomes approved/closed.
- Tests prove rejection of third-party join, reused/expired invitation, cross-lobby access, replayed/duplicate requests, incorrect turn, unauthorized approval, stale agreement approval, hash substitution, invalid sequence, oversized payload, and prompt text masquerading as a command.
- A2A Agent Card and extension declarations validate against the pinned standard; A2A and MCP contract tests pass.
- Logs/metrics/audit data expose state transitions without private session history, tokens, credentials, or default message plaintext.
- Backup creation and a restore into an isolated verification database are performed and the restored state is validated.
- Security/static checks, dependency audit, formatting, type checks, linting, unit tests, integration tests, end-to-end tests, and documented load/reconnect tests all pass with real command output.

### Public-production deployment proof — only after explicit approval and prerequisites

- DNS, hostname, public ingress, Caddy TLS, firewall scope, private service boundaries, secrets, and deployment configuration are inspected and explicitly approved.
- The approved hostname serves valid HTTPS; A2A, MCP, dashboard, health/readiness, and secure event endpoints function through the public boundary.
- Production migrations, backups, monitoring, and a smoke test execute successfully.
- Report deployment evidence, exact non-secret endpoint checks, operational state, residual risks, and rollback procedure.

## Definition of done

The goal is complete only after every local/containerized completion criterion is backed by real test or command output and all approved public-deployment criteria are verified. If public deployment awaits information or explicit approval, mark the codebase as locally production-ready but do not represent the public deployment as complete.

**Final report format:** repository path; implemented capabilities; files changed; standards/versions and compliance evidence; tests/commands with results; deployment state; security/operational verification; blockers; residual risks; and exact next approval required, if any.
