/**
 * PT-GMAIL-013 — Current stricter Authority / invalid approval blocks protected send (ADVERSARIAL, blocking, PG9).
 * After planning, the current Authority becomes stricter; separately the HUMAN_APPROVAL context expires / is revoked /
 * mismatches. The executor is invoked with the original intent/action key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { strictest } from "../src/authority.ts";
import { execute } from "../src/engine.ts";
import { AUTH_CURRENT, AUTH_PIN, buildExecWorld, NOW, req } from "./executor-fixtures.ts";

test("PT-GMAIL-013/a: current stricter Authority wins over the looser pinned version", async () => {
  const w = await buildExecWorld();
  w.sales.authorities.set(AUTH_CURRENT, { version: AUTH_CURRENT, requires_human_approval: false, allowed_action_types: ["FOLLOW_UP"] });
  let d = await execute(w.deps, req("att-1"), NOW);
  assert.equal(d.code, "REFUSE_AUTHORITY", JSON.stringify(d));
  assert.match(d.evidence[0] ?? "", /OUTBOUND_STEP is not allowed/);
  w.sales.authorities.set(AUTH_CURRENT, { version: AUTH_CURRENT, requires_human_approval: false, allowed_action_types: "ANY", max_sequence_step: 1 });
  d = await execute(w.deps, req("att-2"), NOW);
  assert.equal(d.code, "REFUSE_AUTHORITY");
  assert.match(d.evidence[0] ?? "", /step 2 exceeds max 1/);
  w.sales.authorities.set(AUTH_CURRENT, { version: AUTH_CURRENT, requires_human_approval: false, allowed_action_types: "ANY", send_paused: true });
  assert.equal((await execute(w.deps, req("att-3"), NOW)).code, "REFUSE_AUTHORITY");
  w.sales.current = "UNAVAILABLE";
  assert.equal((await execute(w.deps, req("att-4"), NOW)).code, "REFUSE_STATE_UNAVAILABLE");
  w.sales.current = AUTH_CURRENT;
  w.sales.authorities.set(AUTH_CURRENT, { version: AUTH_CURRENT, requires_human_approval: false, allowed_action_types: "ANY" });
  w.sales.authorities.delete(AUTH_PIN);
  assert.equal((await execute(w.deps, req("att-5"), NOW)).code, "REFUSE_AUTHORITY_PIN_UNKNOWN", "an unknown pinned Authority is never assumed permissive");
  assert.equal(w.mailbox.sends, 0);
});

test("PT-GMAIL-013/b: a mid-run relaxation never silently broadens the original pinned authority", async () => {
  const pinned = { version: "TEST_AUTHORITY/1", requires_human_approval: true, allowed_action_types: ["FOLLOW_UP"] as const, max_sequence_step: 2 };
  const relaxed = { version: "TEST_AUTHORITY/3", requires_human_approval: false, allowed_action_types: "ANY" as const, max_sequence_step: 9 };
  assert.deepEqual(strictest(pinned, relaxed), { version: "TEST_AUTHORITY/1+TEST_AUTHORITY/3", requires_human_approval: true, allowed_action_types: ["FOLLOW_UP"], max_sequence_step: 2, send_paused: false });
  const w = await buildExecWorld();
  w.sales.authorities.set(AUTH_PIN, { version: AUTH_PIN, requires_human_approval: true, allowed_action_types: ["OUTBOUND_STEP"] });
  w.sales.authorities.set(AUTH_CURRENT, { version: AUTH_CURRENT, requires_human_approval: false, allowed_action_types: "ANY" });
  const d = await execute(w.deps, req(), NOW);
  assert.equal(d.code, "REFUSE_APPROVAL_INVALID", "pinned approval requirement still applies although the current Authority relaxed it");
  assert.equal(w.mailbox.sends, 0);
});

test("PT-GMAIL-013/c: expired, revoked or mismatched HUMAN_APPROVAL refuses; a valid one passes", async () => {
  const cases: Array<[string, Parameters<typeof buildExecWorld>[0] & { approval?: { state: string; expires_at?: string; context_hash?: string } }, string]> = [
    ["expired", { approval: { state: "APPROVED", expires_at: "2030-02-01T09:59:00.000Z", context_hash: "sha256:content-0001" } }, "REFUSE_APPROVAL_EXPIRED"],
    ["revoked", { approval: { state: "REVOKED", context_hash: "sha256:content-0001" } }, "REFUSE_APPROVAL_INVALID"],
    ["missing", {}, "REFUSE_APPROVAL_INVALID"],
    ["mismatched context", { approval: { state: "APPROVED", expires_at: "2030-02-01T12:00:00.000Z", context_hash: "sha256:content-OTHER" } }, "REFUSE_APPROVAL_CONTEXT_MISMATCH"],
  ];
  for (const [label, o, code] of cases) {
    const w = await buildExecWorld();
    w.sales.authorities.set(AUTH_CURRENT, { version: AUTH_CURRENT, requires_human_approval: true, allowed_action_types: "ANY" });
    w.sales.setIntent({ effect_status: "APPROVED", ...(o.approval ? { approval: o.approval } : {}) });
    const d = await execute(w.deps, req(), NOW);
    assert.equal(d.code, code, `${label}: ${JSON.stringify(d)}`);
    assert.equal(d.checks.at(-1)?.name, "APPROVAL");
    assert.equal(w.mailbox.sends, 0);
  }
  const w = await buildExecWorld();
  w.sales.authorities.set(AUTH_CURRENT, { version: AUTH_CURRENT, requires_human_approval: true, allowed_action_types: "ANY" });
  w.sales.setIntent({ effect_status: "APPROVED", approval: { state: "APPROVED", expires_at: "2030-02-01T12:00:00.000Z", context_hash: "sha256:content-0001" } });
  const ok = await execute(w.deps, req(), NOW);
  assert.equal(ok.decision, "SENT_AND_OBSERVED", JSON.stringify(ok));
  assert.equal(w.mailbox.sends, 1);
});
