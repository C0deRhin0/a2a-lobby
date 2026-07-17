ALTER TABLE lobbies
  ADD COLUMN IF NOT EXISTS current_turn_agent_id uuid REFERENCES agents(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS next_sequence bigint NOT NULL DEFAULT 1;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS recipient_agent_id uuid REFERENCES agents(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS acknowledged_by_agent_id uuid REFERENCES agents(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS approval_surfaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lobby_id uuid NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  human_owner_id uuid NOT NULL REFERENCES human_users(id) ON DELETE RESTRICT,
  adapter text NOT NULL CHECK (adapter IN ('terminal', 'messaging', 'mock')),
  surface_id text NOT NULL CHECK (length(surface_id) BETWEEN 1 AND 300),
  display_name text CHECK (display_name IS NULL OR length(display_name) <= 300),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lobby_id, agent_id)
);

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS approval_type text NOT NULL DEFAULT 'external_action',
  ADD COLUMN IF NOT EXISTS question text NOT NULL DEFAULT 'Approval requested',
  ADD COLUMN IF NOT EXISTS target_agent_id uuid REFERENCES agents(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS surface_id uuid REFERENCES approval_surfaces(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decision_token_hash text CHECK (decision_token_hash IS NULL OR decision_token_hash ~ '^sha256:[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS decision_token_consumed_at timestamptz;

CREATE TABLE IF NOT EXISTS agreement_human_approvals (
  agreement_id uuid NOT NULL,
  agreement_version integer NOT NULL,
  lobby_id uuid NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  human_owner_id uuid NOT NULL REFERENCES human_users(id) ON DELETE RESTRICT,
  canonical_hash text NOT NULL CHECK (canonical_hash ~ '^sha256:[a-f0-9]{64}$'),
  approved_by_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agreement_id, agreement_version, human_owner_id),
  FOREIGN KEY (agreement_id, agreement_version) REFERENCES agreements(id, version) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS approval_surfaces_lobby_agent_idx ON approval_surfaces(lobby_id, agent_id) WHERE active;
CREATE INDEX IF NOT EXISTS agreement_human_approvals_lobby_idx ON agreement_human_approvals(lobby_id, agreement_id, agreement_version) WHERE invalidated_at IS NULL;
