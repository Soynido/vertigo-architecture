/**
 * PT-GTM-010 — the six-tool protocol itself, on the candidate runtime (PV-GTM-002).
 * Evidence candidates only: no PT case is marked PASS here.
 *
 * A: a commit proves the exact resource, key and fields through native Notion writes, TARGET and FINAL; writing
 *    only the journal is never enough.
 * B: a mutation after TARGET is refused at FINAL, and nothing is claimed early.
 * C: a missing capability has no workaround; re-selecting and resuming preserves scope and idempotence.
 * D: an in-process reconstruction rehearsal — explicitly NOT cold-chat evidence, which lives outside this repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../../src/tools/handlers.ts";
import type { Plan } from "../../src/plans/store.ts";
import { handleOf } from "../unit/binding-fixtures.ts";
import { executeWrites, mutatePage } from "../unit/target-fixtures.ts";
import { buildGtmRuntimeWorld, G } from "./world.ts";
import { bindRep, commit, evidenceOf, exposureIntent, finalize, prepare, REP_CTX, resume, target } from "./drive.ts";

const textOf = (page: { properties: Record<string, unknown> }, prop: string): string =>
  ((page.properties[prop] as { rich_text?: Array<{ plain_text: string }> } | undefined)?.rich_text?.[0]?.plain_text) ?? "";

test("PT-GTM-010/A: the commit proves resource, key and fields; the journal alone is never enough", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  const intent = exposureIntent({ key: "EXP-PROOF", contact: "C01", message_ref: "MSG-C01" });

  // Journal-only: the Run and the ledger are written, the target is not. No receipt is issued.
  const prepared = await prepare(w, h, intent);
  const plan = prepared.plan as Plan;
  const skip = plan.stage1_writes.filter((x) => x.purpose === "WRITE_TARGET").map((x) => x.symbol);
  const journalOnly = await target(w, h, plan, { skip });
  assert.equal(journalOnly.envelope.code, "HOLD_TARGET_NOT_WRITTEN", JSON.stringify(journalOnly.envelope));
  assert.match(evidenceOf(journalOnly.envelope), /no target receipt issued/);
  assert.equal(w.rows(G.exposuresDs).length, 0);

  // The full transaction proves the exact record.
  const fresh = buildGtmRuntimeWorld();
  const handle = await bindRep(fresh);
  const { plan: committed, targetRef } = await commit(fresh, handle, intent);
  const op = committed.operations[0];
  assert.equal(op?.logical_resource_key, "SALES:EXPOSURES");
  assert.equal(op?.natural_key, "EXP-PROOF");
  assert.equal(op?.natural_key_property, "Exposure Key");
  const row = fresh.rows(G.exposuresDs).find((r) => r.id === targetRef);
  assert.ok(row);
  assert.equal(textOf(row, "Exposure Key"), "EXP-PROOF");
  assert.equal(textOf(row, "Message Ref"), "MSG-C01");
  assert.equal(textOf(row, "Communicated Offer"), "OFFER-STD");
});

test("PT-GTM-010/B: a mutation after TARGET is refused at FINAL and nothing is claimed early", async () => {
  const w = buildGtmRuntimeWorld();
  const h = await bindRep(w);
  const prepared = await prepare(w, h, exposureIntent({ key: "EXP-DRIFT", contact: "C01", message_ref: "MSG-C01" }));
  const plan = prepared.plan as Plan;
  const created = executeWrites(w, plan.stage1_writes, plan.plan_id, { now: "2030-01-03T00:30:00.000Z" });
  const t = await dispatch("os_verify", { binding_handle: h, plan_id: plan.plan_id, phase: "TARGET" }, REP_CTX, w.deps);
  assert.equal(t.code, "TARGET_VERIFIED", JSON.stringify(t));

  const write = plan.stage1_writes.find((x) => x.purpose === "WRITE_TARGET");
  mutatePage(w, created[(write as { symbol: string }).symbol] as string, { "Communicated Offer": "OFFER-CHANGED" }, "2030-01-03T00:35:00.000Z");
  const f = await finalize(w, h, plan, (t as { result: Record<string, unknown> }).result["target_receipt_id"] as string, (t.observations["symbols"] as Record<string, string>) ?? created);
  assert.equal(f.code, "HOLD_TARGET_CHANGED_AFTER_TARGET_VERIFY", JSON.stringify(f));
  assert.match(evidenceOf(f), /the change is NOT complete/);
  assert.equal(evidenceOf(f).includes("OFFER-CHANGED"), false, "the refusal never echoes the business value");
});

test("PT-GTM-010/C: a missing capability has no workaround, and resuming preserves scope and idempotence", async () => {
  const w = buildGtmRuntimeWorld();
  // Another rep, on the adopted line: no GTM resource, no GTM need, no workaround.
  const other = handleOf(await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, { principal_id: "p-rep-b" }, w.deps));
  const refused = await dispatch("os_prepare", { binding_handle: other, intent: exposureIntent({ key: "EXP-NO", contact: "C01", message_ref: "MSG-NO" }) }, { principal_id: "p-rep-b" }, w.deps);
  assert.equal(refused.code, "HOLD_RESOURCE_UNKNOWN");
  const otherResume = await resume(w, other, "SALES_GTM_CONTEXT", { principal_id: "p-rep-b" });
  const otherPack = otherResume.payload["contract_pack"] as { policy_version: string; completeness_reason: string; selected_pointers: unknown[] };
  assert.equal(otherPack.policy_version, "CONTRACT_PACK/0.1.0");
  assert.equal(otherPack.completeness_reason, "gtm_capability_absent");
  assert.deepEqual(otherPack.selected_pointers, []);

  // On the candidate runtime, re-selecting the same need twice yields the same pack, and re-issuing the same
  // intent replays one plan instead of forking a second.
  const h = await bindRep(w);
  const first = await resume(w, h, "SALES_GTM_CONTEXT");
  const second = await resume(w, h, "SALES_GTM_CONTEXT");
  assert.equal((first.payload["contract_pack"] as { pack_id: string }).pack_id, (second.payload["contract_pack"] as { pack_id: string }).pack_id);
  const intent = exposureIntent({ key: "EXP-IDEMPOTENT", contact: "C01", message_ref: "MSG-C01" });
  const p1 = await prepare(w, h, intent);
  const p2 = await prepare(w, h, intent);
  assert.equal((p1.envelope as { result: Record<string, unknown> }).result["plan_id"], (p2.envelope as { result: Record<string, unknown> }).result["plan_id"]);
  assert.equal((p2.envelope as { result: Record<string, unknown> }).result["replayed"], true);
});

test("PT-GTM-010/D: in-process reconstruction rehearsal (NOT cold-chat evidence, which is external to this repo)", async () => {
  const w = buildGtmRuntimeWorld();
  const intent = exposureIntent({ key: "EXP-REHEARSAL", contact: "C01", message_ref: "MSG-C01" });

  // First "session": nothing but the principal crosses in.
  const firstHandle = await bindRep(w);
  const firstResume = await resume(w, firstHandle, "SALES_GTM_CONTEXT");
  await commit(w, firstHandle, intent);

  // Second "session": a new binding, no handle, no plan id, no pack, no memory of what was said.
  const secondHandle = await bindRep(w);
  assert.notEqual(secondHandle, firstHandle);
  const secondResume = await resume(w, secondHandle, "SALES_GTM_CONTEXT");
  assert.equal(
    (firstResume.payload["contract_pack"] as { selected_pointers: Array<{ resource_key: string }> }).selected_pointers[0]?.resource_key,
    (secondResume.payload["contract_pack"] as { selected_pointers: Array<{ resource_key: string }> }).selected_pointers[0]?.resource_key,
  );
  const replay = await prepare(w, secondHandle, intent);
  assert.equal(replay.envelope.code, "HOLD_DUPLICATE", "the finished work is recognized from Notion, never redone");
  assert.equal(w.rows(G.exposuresDs).length, 1);
  // This is a deterministic in-process rehearsal of a cold start. It is NOT a cold-chat verdict.
});
