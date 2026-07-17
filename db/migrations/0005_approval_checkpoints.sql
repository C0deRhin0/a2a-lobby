-- Make the approval control plane explicit and durable.  Keep legacy enum
-- values so previously-applied 0004 rows remain readable during upgrade.
ALTER TYPE approval_proposal_state ADD VALUE IF NOT EXISTS 'requested';
ALTER TYPE approval_proposal_state ADD VALUE IF NOT EXISTS 'awaiting_both_owners';
ALTER TYPE approval_proposal_state ADD VALUE IF NOT EXISTS 'partially_approved';
ALTER TYPE approval_proposal_state ADD VALUE IF NOT EXISTS 'approved';
ALTER TYPE approval_proposal_state ADD VALUE IF NOT EXISTS 'rejected';
ALTER TYPE approval_proposal_state ADD VALUE IF NOT EXISTS 'changes_requested';

DO $$
BEGIN
  CREATE TYPE approval_checkpoint_state AS ENUM ('suspended', 'awaiting_approval', 'resumable', 'rejected', 'expired', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS approval_checkpoints (
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

CREATE INDEX IF NOT EXISTS approval_checkpoints_lobby_state_idx ON approval_checkpoints(lobby_id, state);

-- PostgreSQL is the durable fallback when Redis is unavailable.  Attempts are
-- retained as an audit-friendly, bounded-window rate-limit ledger.
CREATE TABLE approval_activation_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL REFERENCES agent_credentials(id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX approval_activation_attempts_window_idx ON approval_activation_attempts(credential_id, proposal_id, created_at DESC);
