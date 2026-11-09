-- VERTIGO OS Plugin V0 — backend transaction store.
-- This store holds ACTIVE TRANSACTION MECHANICS ONLY. It is never a second source of VERTIGO business
-- or runtime truth (PDEC-007). Notion remains canonical.

CREATE TABLE IF NOT EXISTS principals (
  principal_id      TEXT PRIMARY KEY,
  status            TEXT NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED')),
  allowed_projects  TEXT[] NOT NULL DEFAULT '{}',
  allowed_lanes     TEXT[] NOT NULL DEFAULT '{}',
  rep_identity_key  TEXT,
  meta_authority    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bindings (
  binding_id                  TEXT PRIMARY KEY,
  handle_hash                 TEXT NOT NULL UNIQUE,
  principal_id                TEXT NOT NULL REFERENCES principals(principal_id),
  project                     TEXT NOT NULL,
  lane                        TEXT NOT NULL CHECK (lane IN ('META','SALES')),
  runtime_logical_key         TEXT NOT NULL,
  runtime_id                  TEXT NOT NULL,
  runtime_generation          TEXT NOT NULL,
  binding_mode                TEXT NOT NULL DEFAULT 'BUSINESS',
  install_phase               TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',
  resolved_manifest_ref       TEXT NOT NULL,
  governing_versions_snapshot JSONB NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN ('BOUND','STALE','REVOKED','EXPIRED')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at                  TIMESTAMPTZ NOT NULL,
  last_seen_at                TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS bindings_principal_idx ON bindings(principal_id, status);

CREATE TABLE IF NOT EXISTS plans (
  plan_id                    TEXT PRIMARY KEY,
  plan_kind                  TEXT NOT NULL DEFAULT 'BUSINESS',
  principal_id               TEXT NOT NULL REFERENCES principals(principal_id),
  binding_id                 TEXT NOT NULL REFERENCES bindings(binding_id),
  project                    TEXT NOT NULL,
  lane                       TEXT NOT NULL,
  runtime_logical_key        TEXT NOT NULL,
  runtime_id                 TEXT NOT NULL,
  runtime_generation         TEXT NOT NULL,
  governing_spec_version     TEXT NOT NULL,
  governing_schema_version   TEXT NOT NULL,
  governing_control_version  TEXT NOT NULL,
  run_mode                   TEXT NOT NULL CHECK (run_mode IN ('OPEN_NEW','RESUME_EXISTING','RECOVER_EXISTING')),
  run_ref                    TEXT,
  execution_attempt_id       TEXT NOT NULL,
  baseline_runtime_revision  TEXT NOT NULL,
  stage1_writes              JSONB NOT NULL,
  finalization_writes        JSONB NOT NULL,
  state_last_write           JSONB NOT NULL,
  install_context_fingerprint TEXT,
  plan_state                 TEXT NOT NULL CHECK (plan_state IN (
                               'AWAITING_STAGE1_WRITES','TARGET_VERIFIED','AWAITING_FINAL_VERIFY','FINAL_VERIFIED',
                               'HOLD','EXPIRED','ABORTED','SUPERSEDED')),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at                 TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_runtime_state_idx ON plans(project, lane, runtime_generation, plan_state);

CREATE TABLE IF NOT EXISTS plan_operations (
  operation_id            TEXT PRIMARY KEY,
  plan_id                 TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
  ordinal                 INTEGER NOT NULL,
  logical_resource_key    TEXT NOT NULL,
  physical_target_ref     TEXT,
  target_parent_ref       TEXT,
  target_data_source_ref  TEXT,
  natural_key             TEXT,
  idempotency_key         TEXT NOT NULL,
  operation               TEXT NOT NULL CHECK (operation IN ('CREATE','UPDATE','UPSERT')),
  baseline_revision       TEXT,
  compared_fields         TEXT[] NOT NULL,
  before_values           JSONB NOT NULL,
  expected_values         JSONB NOT NULL,
  before_hash             TEXT,
  expected_hash           TEXT,
  UNIQUE (plan_id, ordinal)
);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id          TEXT PRIMARY KEY,
  type                TEXT NOT NULL CHECK (type IN ('TARGET','FINAL')),
  plan_id             TEXT NOT NULL REFERENCES plans(plan_id),
  principal_id        TEXT NOT NULL,
  runtime_id          TEXT NOT NULL,
  runtime_generation  TEXT NOT NULL,
  run_ref             TEXT,
  target_receipt_id   TEXT REFERENCES receipts(receipt_id),
  observed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  observations        JSONB NOT NULL,
  expires_at          TIMESTAMPTZ,
  status              TEXT NOT NULL CHECK (status IN ('VALID','EXPIRED','CONSUMED','INVALID'))
);

CREATE TABLE IF NOT EXISTS runtime_leases (
  project             TEXT NOT NULL,
  lane                TEXT NOT NULL,
  runtime_generation  TEXT NOT NULL,
  -- No FK to plans: the lease is acquired atomically BEFORE the plan row exists (a busy runtime must never
  -- leave a half-created plan behind). The holder plan_id is reconciled through plans.plan_state on takeover.
  plan_id             TEXT NOT NULL,
  acquired_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project, lane, runtime_generation)
);

CREATE TABLE IF NOT EXISTS transaction_events (
  event_id      BIGSERIAL PRIMARY KEY,
  principal_id  TEXT,
  binding_id    TEXT,
  plan_id       TEXT,
  receipt_id    TEXT,
  runtime_id    TEXT,
  event_type    TEXT NOT NULL,
  result        TEXT NOT NULL,
  detail        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transaction_events_plan_idx ON transaction_events(plan_id, created_at);

-- Re-runnable: drop the historical lease→plan FK if an earlier schema created it.
ALTER TABLE runtime_leases DROP CONSTRAINT IF EXISTS runtime_leases_plan_id_fkey;

-- PV0-012: CREATE results are located by natural key at TARGET verification.
ALTER TABLE plan_operations ADD COLUMN IF NOT EXISTS natural_key_property TEXT;

-- PV0-015: recovery plans continue the Run / ledger rows of the interrupted plan they recover.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS recovers_plan_id TEXT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS plan_kind TEXT NOT NULL DEFAULT 'BUSINESS';

-- Principals are authorized from the deployment registry file (PRINCIPALS_FILE), never from this database;
-- a foreign key to the principals table only breaks the first os_bind on a durable store (found by the
-- PV0-020 HTTP smoke test). The table stays for compatibility; the linkage is by id only.
ALTER TABLE bindings DROP CONSTRAINT IF EXISTS bindings_principal_id_fkey;
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_principal_id_fkey;

-- Dedicated Personal SALES provisioning authorization. Existing bindings stay BUSINESS.
ALTER TABLE bindings ADD COLUMN IF NOT EXISTS binding_mode TEXT NOT NULL DEFAULT 'BUSINESS';
ALTER TABLE bindings ADD COLUMN IF NOT EXISTS install_phase TEXT NOT NULL DEFAULT 'NOT_APPLICABLE';

-- Additive, named constraints cover both fresh installs and databases upgraded from a pre-provisioning schema.
DO $$ BEGIN
  ALTER TABLE bindings ADD CONSTRAINT bindings_binding_mode_check
    CHECK (binding_mode IN ('BUSINESS','INSTALL_ONLY'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE bindings ADD CONSTRAINT bindings_install_phase_check
    CHECK (install_phase IN ('NOT_APPLICABLE','INSTALL_PENDING'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE plans ADD CONSTRAINT plans_plan_kind_check
    CHECK (plan_kind IN ('BUSINESS','INSTALL_MAPPING','INSTALL_PROMOTION'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Promotion is bound to ONE mapping proof (plan + FINAL receipt), never to "any" final mapping of the same
-- runtime generation. Both columns are additive and NULL for every pre-existing plan.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS install_mapping_plan_id TEXT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS install_mapping_final_receipt_id TEXT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS install_context_fingerprint TEXT;

DO $$ BEGIN
  ALTER TABLE plans ADD CONSTRAINT plans_install_promotion_proof_check
    CHECK (plan_kind <> 'INSTALL_PROMOTION'
           OR (install_mapping_plan_id IS NOT NULL AND install_mapping_final_receipt_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE plans ADD CONSTRAINT plans_install_mapping_proof_absent_check
    CHECK (plan_kind = 'INSTALL_PROMOTION'
           OR (install_mapping_plan_id IS NULL AND install_mapping_final_receipt_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE plans ADD CONSTRAINT plans_install_mapping_plan_fk
    FOREIGN KEY (install_mapping_plan_id) REFERENCES plans(plan_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE plans ADD CONSTRAINT plans_install_mapping_receipt_fk
    FOREIGN KEY (install_mapping_final_receipt_id) REFERENCES receipts(receipt_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Receipt issuance is idempotent and concurrency-safe: at most ONE VALID receipt per (plan, phase) may exist,
-- so two concurrent os_verify calls cannot mint two live TARGET receipts (or two FINAL receipts) for one plan.
-- A CONSUMED/EXPIRED receipt is excluded from the index, which is what allows a legitimate re-issue later.
--
-- Upgrade safety: pre-index deployments could already contain duplicate VALID rows. Deterministically keep the
-- oldest receipt (receipt_id breaks timestamp ties) and invalidate every later duplicate BEFORE creating the
-- unique index. Rows are retained for audit and foreign-key continuity; no historical evidence is deleted.
WITH ranked_valid_receipts AS (
  SELECT receipt_id,
         row_number() OVER (PARTITION BY plan_id, type ORDER BY observed_at, receipt_id) AS ordinal
    FROM receipts
   WHERE status = 'VALID'
)
UPDATE receipts AS r
   SET status = 'INVALID'
  FROM ranked_valid_receipts AS ranked
 WHERE r.receipt_id = ranked.receipt_id
   AND ranked.ordinal > 1;

CREATE UNIQUE INDEX IF NOT EXISTS receipts_one_valid_per_plan_phase_uq
  ON receipts (plan_id, type) WHERE status = 'VALID';
