-- Separate mutable approval proposals from immutable final agreements.
CREATE TYPE approval_proposal_state AS ENUM ('pending', 'requested', 'awaiting_both_owners', 'partially_approved', 'approved', 'rejected', 'changes_requested', 'resolved', 'resumable', 'superseded', 'expired', 'cancelled');
CREATE TYPE approval_target_state AS ENUM ('pending', 'approved', 'rejected', 'changes_requested', 'superseded', 'expired', 'cancelled');
CREATE TYPE approval_checkpoint_state AS ENUM ('suspended', 'awaiting_approval', 'resumable', 'rejected', 'expired', 'cancelled');

CREATE TABLE approval_proposals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lobby_id uuid NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  canonical_hash text NOT NULL CHECK (canonical_hash ~ '^sha256:[a-f0-9]{64}$'),
  structured_content jsonb NOT NULL,
  requested_by_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  state approval_proposal_state NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  superseded_at timestamptz,
  resolved_at timestamptz,
  resumable_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, revision),
  UNIQUE (lobby_id, id, revision)
);

CREATE TABLE approval_decision_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL,
  proposal_revision integer NOT NULL,
  target_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  human_owner_id uuid NOT NULL REFERENCES human_users(id) ON DELETE RESTRICT,
  state approval_target_state NOT NULL DEFAULT 'pending',
  decided_at timestamptz,
  decision_idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, proposal_revision, target_agent_id),
  FOREIGN KEY (proposal_id, proposal_revision) REFERENCES approval_proposals(id, revision) ON DELETE CASCADE
);

CREATE TABLE approval_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lobby_id uuid NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL,
  proposal_revision integer NOT NULL,
  state approval_checkpoint_state NOT NULL DEFAULT 'suspended',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  FOREIGN KEY (proposal_id, proposal_revision) REFERENCES approval_proposals(id, revision) ON DELETE CASCADE,
  UNIQUE (proposal_id, proposal_revision)
);

CREATE TABLE approval_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL,
  proposal_revision integer NOT NULL,
  target_id uuid NOT NULL REFERENCES approval_decision_targets(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^sha256:[a-f0-9]{64}$'),
  code_issued_at timestamptz NOT NULL DEFAULT now(),
  code_consumed_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz NOT NULL,
  session_hash text UNIQUE CHECK (session_hash IS NULL OR session_hash ~ '^sha256:[a-f0-9]{64}$'),
  csrf_hash text CHECK (csrf_hash IS NULL OR csrf_hash ~ '^sha256:[a-f0-9]{64}$'),
  session_expires_at timestamptz,
  FOREIGN KEY (proposal_id, proposal_revision) REFERENCES approval_proposals(id, revision) ON DELETE CASCADE,
  UNIQUE (target_id)
);

CREATE INDEX approval_proposals_lobby_state_idx ON approval_proposals(lobby_id, state, expires_at);
CREATE INDEX approval_decision_targets_pending_idx ON approval_decision_targets(target_agent_id, human_owner_id) WHERE state = 'pending';
CREATE INDEX approval_checkpoints_lobby_state_idx ON approval_checkpoints(lobby_id, state);
CREATE INDEX approval_activations_session_idx ON approval_activations(session_hash) WHERE session_hash IS NOT NULL;
