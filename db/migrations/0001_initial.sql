-- Agent Lobby initial durable authority schema.
-- PostgreSQL is the source of truth; Redis is reserved for ephemeral coordination.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE lobby_status AS ENUM ('pending', 'active', 'blocked', 'closed', 'cancelled', 'expired');
CREATE TYPE participant_role AS ENUM ('initiator', 'counterparty');
CREATE TYPE approval_state AS ENUM ('requested', 'approved', 'rejected', 'expired', 'cancelled');

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE human_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  human_owner_id uuid NOT NULL REFERENCES human_users(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lobbies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 8 AND 500),
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  retention_policy jsonb NOT NULL,
  approval_policy jsonb NOT NULL,
  status lobby_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  close_reason text CHECK (close_reason IS NULL OR length(close_reason) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((retention_policy ->> 'plaintextMessageStorage')::boolean IS FALSE),
  CHECK ((approval_policy ->> 'blockingByDefault')::boolean IS TRUE)
);

CREATE TABLE lobby_participants (
  lobby_id uuid NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  human_owner_id uuid NOT NULL REFERENCES human_users(id) ON DELETE RESTRICT,
  role participant_role NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  PRIMARY KEY (lobby_id, agent_id),
  UNIQUE (lobby_id, role)
);

CREATE UNIQUE INDEX lobby_participants_max_two_active_idx
  ON lobby_participants(lobby_id, role)
  WHERE left_at IS NULL;

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lobby_id uuid NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  sender_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  sequence bigint NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  content_ciphertext bytea,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  UNIQUE (lobby_id, sequence),
  UNIQUE (lobby_id, sender_agent_id, idempotency_key)
);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lobby_id uuid NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  requested_by_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  human_owner_id uuid NOT NULL REFERENCES human_users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  state approval_state NOT NULL DEFAULT 'requested',
  agreement_id uuid,
  agreement_version integer,
  agreement_hash text CHECK (agreement_hash IS NULL OR agreement_hash ~ '^sha256:[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agreements (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lobby_id uuid NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  canonical_hash text NOT NULL CHECK (canonical_hash ~ '^sha256:[a-f0-9]{64}$'),
  structured_content jsonb NOT NULL,
  proposed_by_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version),
  UNIQUE (lobby_id, id, version)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  lobby_id uuid REFERENCES lobbies(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 200),
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
  actor_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX lobbies_org_status_idx ON lobbies(organization_id, status);
CREATE INDEX messages_lobby_sequence_idx ON messages(lobby_id, sequence);
CREATE INDEX approvals_lobby_state_idx ON approvals(lobby_id, state);
CREATE INDEX audit_events_lobby_created_idx ON audit_events(lobby_id, created_at DESC);
