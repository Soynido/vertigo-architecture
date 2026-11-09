-- PV-WRITE-001 / W1.5 — the server's own Notion writes (decision PDEC-018 — CANDIDATE, NOT ADOPTED).
-- Re-runnable: every statement is idempotent, and nothing here alters or deletes an existing row.

-- One row per plan instruction. PENDING → SENT → DONE | OBSERVED | FAILED_FINAL; SENT → SENT is a resend of the
-- same payload. The payload hash and the stamped $now are fixed at the first send.
CREATE TABLE IF NOT EXISTS plan_writes (
  plan_id       TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
  symbol        TEXT NOT NULL,
  phase         TEXT NOT NULL CHECK (phase IN ('STAGE1','FINALIZATION','STATE_LAST')),
  ordinal       INTEGER NOT NULL,
  operation     TEXT NOT NULL CHECK (operation IN ('CREATE','UPDATE')),
  target_ref    TEXT NOT NULL,
  payload_hash  TEXT,
  stamped_now   TEXT,
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','DONE','OBSERVED','FAILED_FINAL')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_id    TEXT,
  last_error    TEXT,
  sent_at       TIMESTAMPTZ,
  done_at       TIMESTAMPTZ,
  PRIMARY KEY (plan_id, symbol)
);
CREATE INDEX IF NOT EXISTS plan_writes_plan_ordinal_idx ON plan_writes(plan_id, ordinal);

-- One executor per plan: an exclusive, expiring claim.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS exec_claim_token TEXT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS exec_claim_until TIMESTAMPTZ;

-- Why the backend holds the plan, and the plan that spawned it. Every pre-existing plan came from an intent.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS plan_origin TEXT NOT NULL DEFAULT 'INTENT';
ALTER TABLE plans ADD COLUMN IF NOT EXISTS parent_plan_id TEXT;
DO $$ BEGIN
  ALTER TABLE plans ADD CONSTRAINT plans_plan_origin_check
    CHECK (plan_origin IN ('INTENT','DERIVED_MOVE','AUTO_RECONCILE','AUTO_RECOVERY','INSTALL'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The live type of the natural-key property: plans read back from PostgreSQL used to lose it.
ALTER TABLE plan_operations ADD COLUMN IF NOT EXISTS natural_key_property_type TEXT;
