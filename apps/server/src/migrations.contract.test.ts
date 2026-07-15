import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../db/migrations/0004_approval_control_plane.sql", import.meta.url), "utf8");

describe("fresh approval-control-plane migration", () => {
  it("defines the proposal and checkpoint states required before application code runs", () => {
    expect(migration).toContain("CREATE TYPE approval_proposal_state AS ENUM ('pending', 'requested', 'awaiting_both_owners', 'partially_approved', 'approved', 'rejected', 'changes_requested', 'resolved', 'resumable', 'superseded', 'expired', 'cancelled')");
    expect(migration).toContain("CREATE TYPE approval_checkpoint_state AS ENUM ('suspended', 'awaiting_approval', 'resumable', 'rejected', 'expired', 'cancelled')");
    expect(migration).toContain("CREATE TABLE approval_checkpoints");
    expect(migration).toContain("state approval_checkpoint_state NOT NULL DEFAULT 'suspended'");
    expect(migration).toContain("FOREIGN KEY (proposal_id, proposal_revision) REFERENCES approval_proposals(id, revision) ON DELETE CASCADE");
  });
});
