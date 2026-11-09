-- Deterministic Mail Executor ledger: one row per action_key; the lock that makes two chats / retries unable to
-- produce two sends. States: CHECKING (pre-send, leased) → SENDING → SENT_PENDING_READBACK → OBSERVED;
-- REFUSED / FAILED are re-acquirable (after fresh T-0 checks + reconciliation); SENDING / SENT_PENDING_READBACK /
-- AMBIGUOUS_TRANSPORT / OBSERVED never are (reconcile only, never replay).
CREATE TABLE IF NOT EXISTS executor_actions (
  action_key   TEXT PRIMARY KEY,
  state        TEXT NOT NULL,
  attempt_id   TEXT NOT NULL,
  lease_until  TIMESTAMPTZ NOT NULL,
  message_id   TEXT,
  thread_id    TEXT,
  observed_at  TIMESTAMPTZ,
  evidence     JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL
);
