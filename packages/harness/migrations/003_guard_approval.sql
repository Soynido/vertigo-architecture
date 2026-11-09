-- PV-WRITE-001 / W3.1 — operator approval of a Sales Production Guard Index (Sales 0.5.11 candidate, NOT ADOPTED).
-- Re-runnable: every statement is idempotent, and nothing here alters or deletes an existing row.
-- Identifiers and the digest only: no rule, configuration value or other business text is ever stored here.
CREATE TABLE IF NOT EXISTS guard_approvals (
  binding_id            TEXT PRIMARY KEY,
  runtime_id            TEXT NOT NULL,
  runtime_generation    TEXT NOT NULL,
  guard_schema_version  TEXT NOT NULL,
  index_page_id         TEXT NOT NULL,
  digest_sha256         TEXT NOT NULL CHECK (digest_sha256 ~ '^[0-9a-f]{64}$'),
  approved_at           TIMESTAMPTZ NOT NULL,
  operator_id           TEXT NOT NULL
);
