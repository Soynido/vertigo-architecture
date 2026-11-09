/**
 * os_verify(FINAL) — the only completion authority (PV0-014, PG5).
 *
 * Requires a plan that passed TARGET and still holds a VALID target receipt (server-side; the caller never
 * names a receipt). Fresh-reads the Run, every ledger row, every target, the State/Manifest cursor and the
 * governing versions, and proves: target stability since TARGET, ledger VERIFIED with THIS plan's receipt id
 * (no narrative VERIFIED, no foreign receipt), Run COMPLETED with exact counts, control-owned fields untouched
 * (gate validity), State/Manifest pointing at this Run and written LAST, no incompatible concurrent cursor
 * change, no version change. Success stores a backend-only FINAL receipt, consumes the target receipt and
 * returns TRANSACTION_VERIFIED; a repeat returns the stored terminal result.
 */
import type { BindingRecord } from "../binding/store.ts";
import type { HoldCode } from "../errors/codes.ts";
import type { NotionReadClient } from "../notion/readClient.ts";
import { normalizeId, propMentions, propText, type Page } from "../notion/shapes.ts";
import { checkTargetReceipt, expireIfDue, issueFinalReceipt, transition } from "../plans/service.ts";
import { isReadoption, linkageId, type Plan } from "../plans/store.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import { discoverControlPlane, readCapabilitySnapshot, readControlPlane } from "../resume/readers.ts";
import { isForeignRunImport } from "../resume/foreignRuns.ts";
import { isExternalEventPlan } from "../effects/eventWrite.ts";
import { isSourceEnrollmentPlan } from "../resume/sourceEnrollment.ts";
import { evaluateCapabilityCompleteness } from "../resume/capabilities.ts";
import { readManifestBlockers } from "../resume/admission.ts";
import type { HarnessDeps } from "../tools/handlers.ts";
import type { ReceiptRecord } from "./engine.ts";
import { compareFields, observedFingerprint } from "./target.ts";
import { redact as redactValue } from "../gtm/semantics.ts";

export type FinalOutcome =
  | { readonly kind: "VERIFIED"; readonly receipt: ReceiptRecord; readonly target_receipt: ReceiptRecord; readonly observations: Readonly<Record<string, unknown>>; readonly warnings: readonly string[]; readonly repeated: boolean }
  | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly safe_action: string; readonly warnings?: readonly string[]; readonly observations?: Readonly<Record<string, unknown>>; readonly drift?: boolean };

function hold(code: HoldCode, evidence: string[], safe_action: string, extra: Partial<Extract<FinalOutcome, { kind: "HOLD" }>> = {}): FinalOutcome {
  return { kind: "HOLD", code, evidence, safe_action, ...extra };
}

async function queryAll(client: NotionReadClient, dsId: string, filter: unknown): Promise<Page[]> {
  const out: Page[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const q = (await client.queryDataSource(dsId, filter, cursor)) as { results: readonly Page[]; has_more?: boolean; next_cursor?: string | null };
    out.push(...q.results.filter((p) => !p.archived && !p.in_trash));
    if (!q.has_more || !q.next_cursor) return out;
    cursor = q.next_cursor;
  }
  return out;
}

const num = (p: Page, name: string): number | undefined => { const v = propText(p, name); return v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v); };
const later = (a: string | undefined, b: string | undefined): boolean => typeof a === "string" && typeof b === "string" && Date.parse(a) > Date.parse(b);

export async function verifyFinal(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, plan: Plan, now: Date): Promise<FinalOutcome> {
  const store = deps.store;
  const client = deps.notion;
  const warnings: string[] = [];

  // 0. Terminal result and the historical "FINAL inserted, plan transition not written" crash window are both
  // idempotent. Running issueFinalReceipt against an incumbent invokes the atomic convergence primitive; it does
  // not mint a second receipt.
  let fresh = (await store.plans.get(plan.plan_id)) ?? plan;
  const incumbentFinal = (await store.receipts.findByPlan(plan.plan_id, "FINAL")).find((r) => r.status === "VALID");
  if (incumbentFinal?.target_receipt_id) {
    const target = await store.receipts.get(incumbentFinal.target_receipt_id);
    if (target) {
      const stored = await issueFinalReceipt(store, fresh, target, incumbentFinal.observations, now);
      return { kind: "VERIFIED", receipt: stored, target_receipt: target, observations: stored.observations, warnings: [fresh.plan_state === "FINAL_VERIFIED" ? "repeated: stored terminal result returned; no new durable effect" : "recovery: an existing FINAL receipt was reconciled with the plan, lease and audit log"], repeated: true };
    }
  }

  // 1. Preconditions: TARGET passed and its receipt is valid, plan alive, runtime and versions unchanged.
  const targetReceipts = await store.receipts.findByPlan(plan.plan_id, "TARGET");
  const consumedCrash = targetReceipts.find((r) => r.status === "CONSUMED");
  // A consumed TARGET without FINAL can only be left by the former non-atomic FINAL sequence. Do not expire that
  // recovery attempt before revalidating all canonical state below; the atomic primitive will close it safely.
  if (!consumedCrash) await expireIfDue(store, fresh, now);
  fresh = (await store.plans.get(plan.plan_id)) ?? fresh;
  if (fresh.plan_state === "EXPIRED" || fresh.plan_state === "ABORTED" || fresh.plan_state === "SUPERSEDED") return hold("HOLD_PLAN_EXPIRED", [`plan ${plan.plan_id} is ${fresh.plan_state}`, "durable writes may exist; recovery required before any replay"], "call os_resume and recover the incomplete durable work");
  if (fresh.plan_state === "HOLD") return hold("HOLD_PLAN_REPLAY_INVALID", [`plan ${plan.plan_id} is on HOLD after a detected divergence`], "call os_resume and reconcile before any further verification");
  if (fresh.plan_state !== "TARGET_VERIFIED" && fresh.plan_state !== "AWAITING_FINAL_VERIFY") return hold("HOLD_FINAL_WITHOUT_TARGET_VERIFICATION", [`plan_state=${fresh.plan_state}; TARGET readback has not passed`], "execute stage-1, call os_verify(TARGET), then finalize");
  const valid = targetReceipts.find((r) => r.status === "VALID");
  if (!valid && !consumedCrash) {
    const expired = targetReceipts.find((r) => r.status === "EXPIRED" || (r.expires_at !== undefined && r.expires_at <= now));
    if (expired) return hold("HOLD_TARGET_RECEIPT_EXPIRED", [`target receipt ${expired.receipt_id} expired at ${expired.expires_at?.toISOString() ?? "UNKNOWN"}`], "call os_verify(TARGET) again to re-verify the target, then finalize within the receipt TTL");
    return hold("HOLD_TARGET_RECEIPT_INVALID", [targetReceipts.length === 0 ? "no target receipt exists for this plan" : `target receipt(s) ${targetReceipts.map((r) => `${r.receipt_id}:${r.status}`).join(", ")} are not valid`], "call os_verify(TARGET) again");
  }
  let targetReceipt: ReceiptRecord;
  if (valid) {
    const chk = await checkTargetReceipt(store, fresh, valid.receipt_id, now);
    if (!chk.ok) return hold(chk.reason === "EXPIRED" ? "HOLD_TARGET_RECEIPT_EXPIRED" : "HOLD_TARGET_RECEIPT_INVALID", [`target receipt ${valid.receipt_id}: ${chk.reason}`], "call os_verify(TARGET) again");
    targetReceipt = chk.receipt;
  } else {
    targetReceipt = consumedCrash as ReceiptRecord;
    if (targetReceipt.plan_id !== fresh.plan_id || targetReceipt.principal_id !== fresh.principal_id || targetReceipt.runtime_generation !== fresh.runtime_generation) {
      return hold("HOLD_TARGET_RECEIPT_INVALID", [`consumed target receipt ${targetReceipt.receipt_id} has the wrong plan, principal or runtime generation`], "stop and inspect the backend receipt lineage");
    }
    warnings.push("recovery: TARGET was already consumed by an interrupted historical FINAL; canonical state is being fully reverified before convergence");
  }
  if (fresh.runtime_generation !== binding.runtime_generation || fresh.runtime_id !== runtime.runtime_id) return hold("HOLD_PLAN_RUNTIME_MISMATCH", [`plan prepared for ${fresh.runtime_generation}/${fresh.runtime_id}; binding is ${binding.runtime_generation}/${runtime.runtime_id}`], "bind again and prepare a new plan");
  const gov = runtime.versions;
  const nowV = { spec: gov.governing_spec === "UNKNOWN" ? "UNKNOWN" : gov.governing_spec.value, schema: gov.governing_schema === "UNKNOWN" ? "UNKNOWN" : gov.governing_schema.value, control: gov.governing_control === "UNKNOWN" ? "UNKNOWN" : gov.governing_control.value };
  const changed = [["spec", fresh.governing_spec_version, nowV.spec], ["schema", fresh.governing_schema_version, nowV.schema], ["control", fresh.governing_control_version, nowV.control]].filter(([, a, b]) => a !== b).map(([k, a, b]) => `governing ${k}: plan=${a} now=${b}`);
  if (changed.length > 0) return hold("HOLD_FINAL_VERSION_CONFLICT", [...changed, "the transaction crossed a governing version boundary; its semantics are not reinterpreted under the new version"], "stop; reconcile the durable writes under the new governing version by hand, then bind and prepare again", { drift: true });
  const graphHold = await (await import("../resume/b7DryRun.ts")).verifyB7Graph(deps, binding, runtime, fresh);
  if (graphHold) return graphHold;

  const capabilityProofResource = runtime.adapter.capabilities?.capabilityProofResource;
  const capabilityRemediation = capabilityProofResource !== undefined && fresh.operations.every((o) => o.logical_resource_key === capabilityProofResource);
  // ADMISSION-SALES-001: FINAL re-reads the Manifest. A blocker declared there since prepare is a concurrent
  // runtime-authority change, exactly like a cursor moved elsewhere. Bounded recovery and capability-proof
  // remediation are exempt for the same reasons as at TARGET.
  if (fresh.run_mode !== "RECOVER_EXISTING" && !capabilityRemediation) {
    const manifest = await readManifestBlockers(client, runtime);
    if ("unreadable" in manifest) return hold("HOLD_FINAL_RUNTIME_CONFLICT", [manifest.unreadable, "the runtime's admission cannot be established without its Manifest"], "restore read access to the Manifest, then call os_resume");
    if (manifest.blockers.length > 0) return hold("HOLD_FINAL_RUNTIME_CONFLICT", [...manifest.blockers, "FINAL never overwrites or ignores a concurrent runtime authority change"], "call os_resume; resolve the Manifest blocker (rebind / install / recovery) before this transaction can complete");
  }
  if (runtime.adapter.capabilities?.operatingModeRequirements && !capabilityRemediation && !isSourceEnrollmentPlan(runtime, fresh)) {
    const root = isForeignRunImport(fresh) ? fresh : fresh.recovers_plan_id && !isExternalEventPlan(fresh) ? await store.plans.get(fresh.recovers_plan_id) : undefined;
    const narrow = root && isForeignRunImport(root) ? await readCapabilitySnapshot(client, runtime) : undefined;
    const snapshot = narrow ?? await readControlPlane(client, runtime);
    if (!("hold" in snapshot)) {
      const capability = evaluateCapabilityCompleteness(runtime, snapshot);
      if (capability && !capability.complete) {
        const evidence = capability.comparisons.filter((c) => c.requirement === "REQUIRED" && !c.satisfied).map((c) => `${c.capability}=${c.state}: ${c.reason}`);
        return hold("HOLD_REQUIRED_CAPABILITY_INCOMPLETE", evidence, capability.next_human_action, { observations: { capability_completeness: capability } });
      }
    }
  }

  // 2. Control plane.
  const g = runtime.adapter.controlPlane;
  const wp = g.writeProps;
  const rp = g.runProps;
  const lp = g.ledgerProps;
  if (!wp?.runHarnessPlanId || !wp.ledgerHarnessPlanId || !wp.ledgerIdempotencyKey || !wp.ledgerTargetReceiptId) return hold("HOLD_SCHEMA_MISMATCH", ["adapter grammar declares no harness linkage fields"], "adopt a grammar with harness linkage");
  const dbs = await discoverControlPlane(client, runtime.root_ref, g);
  if (!dbs.runs || !dbs.ledger) return hold("HOLD_REQUIRED_RESOURCE_MISSING", ["control-plane databases missing"], "restore the runtime control plane");
  const link = linkageId(fresh);
  const runRows = (await queryAll(client, dbs.runs, { property: wp.runHarnessPlanId, rich_text: { equals: link } })).filter((p) => propText(p, wp.runHarnessPlanId as string)?.trim() === link);
  if (runRows.length !== 1) return hold("HOLD_RUN_INCOMPLETE", [`expected exactly one Run carrying ${wp.runHarnessPlanId} = ${link}, found ${runRows.length}`], "reconcile the Run rows by hand");
  const run = runRows[0] as Page;
  const runRef = normalizeId(run.id) as string;
  const runStatus = propText(run, rp.status);
  if (runStatus !== "COMPLETED") return hold("HOLD_RUN_INCOMPLETE", [`Run ${runRef} is ${runStatus ?? "UNKNOWN"}, not COMPLETED`], "execute the FINALIZE_RUN action, then call os_verify(FINAL) again");
  const n = fresh.operations.length;
  const mc = num(run, rp.mutationCount);
  const vc = num(run, rp.verifiedMutationCount);
  if (mc !== n || vc !== n) return hold("HOLD_RUN_COUNT_MISMATCH", [`Run ${runRef}: ${rp.mutationCount}=${mc ?? "UNKNOWN"}, ${rp.verifiedMutationCount}=${vc ?? "UNKNOWN"}; plan has ${n} operation(s)`], "correct the Run counts to the actual verified ledger rows, then call os_verify(FINAL) again");
  const gateBefore = propText(run, rp.gateBefore);
  const gateExpected = propText(run, rp.gateAfterExpected);
  const gateObserved = propText(run, rp.gateAfterObserved);
  if ((gateObserved ?? "") !== (gateExpected ?? "")) return hold("HOLD_FINAL_GATE_INVALID", [`Run ${runRef}: ${rp.gateAfterObserved}=${gateObserved ?? "EMPTY"} differs from ${rp.gateAfterExpected}=${gateExpected ?? "EMPTY"} (before: ${gateBefore ?? "EMPTY"})`, "a gate transition that the plan did not derive cannot be blessed"], "revert the Run's observed gate to the expected value; gate transitions are governed by the control contract, never narrated");

  // Receipts that prove harness verification of THIS transaction: the current target receipt, or (recovery) a
  // backend receipt issued to the recovered plan for the same principal and runtime generation (never INVALID).
  const lineage = new Set<string>([targetReceipt.receipt_id]);
  if (fresh.recovers_plan_id) for (const r of await store.receipts.findByPlan(fresh.recovers_plan_id, "TARGET")) if (r.status !== "INVALID" && r.principal_id === plan.principal_id && r.runtime_generation === plan.runtime_generation) lineage.add(r.receipt_id);
  const ledgerAll = (await queryAll(client, dbs.ledger, { property: wp.ledgerHarnessPlanId, rich_text: { equals: link } })).filter((p) => propText(p, wp.ledgerHarnessPlanId as string)?.trim() === link);
  const ledgerRefs: string[] = [];
  let newestLedger: string | undefined;
  for (const op of fresh.operations) {
    const rows = ledgerAll.filter((p) => propText(p, wp.ledgerIdempotencyKey as string)?.trim() === op.idempotency_key);
    if (rows.length !== 1) return hold("HOLD_LEDGER_NOT_VERIFIED", [`expected exactly one ledger row for operation ${op.ordinal} (${op.idempotency_key}), found ${rows.length}`], "restore the ledger row for this operation, then call os_verify(FINAL) again");
    const row = rows[0] as Page;
    const rowRef = normalizeId(row.id) as string;
    if (!propMentions(row, lp.runRef).includes(runRef) && !(propText(row, lp.runRef) ?? "").includes(runRef)) return hold("HOLD_LEDGER_NOT_VERIFIED", [`ledger row ${rowRef} does not reference Run ${runRef}`], "fix the ledger row's Run reference");
    const st = propText(row, lp.status);
    if (st !== "VERIFIED") return hold("HOLD_LEDGER_NOT_VERIFIED", [`ledger row ${rowRef} is ${st ?? "UNKNOWN"}, not VERIFIED`], "execute the LEDGER_VERIFIED action for this operation, then call os_verify(FINAL) again");
    const rid = (propText(row, wp.ledgerTargetReceiptId) ?? "").trim();
    if (!lineage.has(rid)) {
      const other = rid ? await store.receipts.get(rid) : undefined;
      if (other && (other.plan_id !== plan.plan_id || other.principal_id !== plan.principal_id || other.runtime_generation !== plan.runtime_generation)) {
        await store.events.append({ event_type: "RECEIPT_REPLAY_REJECTED", result: "FOREIGN_RECEIPT", principal_id: plan.principal_id, plan_id: plan.plan_id, receipt_id: rid, runtime_id: plan.runtime_id, created_at: now });
        return hold("HOLD_TARGET_RECEIPT_REPLAY", [`ledger row ${rowRef} carries receipt ${rid}, which belongs to plan ${other.plan_id} (principal ${other.principal_id}, generation ${other.runtime_generation})`, "an opaque receipt is scoped to one plan, principal and runtime generation"], "write this plan's own target receipt id into the ledger row, then call os_verify(FINAL) again");
      }
      return hold("HOLD_LEDGER_RECEIPT_MISMATCH", [`ledger row ${rowRef} carries ${wp.ledgerTargetReceiptId}=${rid || "EMPTY"}; this plan's target receipt is ${targetReceipt.receipt_id}`, "a VERIFIED status without the harness receipt is narrative, not proof"], "write the target receipt id returned by os_verify(TARGET) into the ledger row, then call os_verify(FINAL) again");
    }
    ledgerRefs.push(rowRef);
    if (!newestLedger || later(row.last_edited_time, newestLedger)) newestLedger = row.last_edited_time;
  }

  // 3. Targets stable since TARGET (values and control-owned fields).
  const snapshot = (targetReceipt.observations["targets"] as Array<{ ordinal: number; target_ref: string; protected?: Record<string, string | null>; last_edited?: string }> | undefined) ?? [];
  let newestTarget: string | undefined;
  for (const op of fresh.operations) {
    const snap = snapshot.find((t) => t.ordinal === op.ordinal);
    const ref = op.physical_target_ref ?? snap?.target_ref;
    if (!ref) return hold("HOLD_TARGET_RECEIPT_INVALID", [`target receipt carries no record for operation ${op.ordinal}`], "call os_verify(TARGET) again");
    let page: Page;
    try { page = (await client.retrievePage(ref)) as Page; } catch (err) { return hold("HOLD_TARGET_CHANGED_AFTER_TARGET_VERIFY", [`target ${ref} unreadable: ${(err as Error).message}`], "the verified record vanished; reconcile before any retry", { drift: true }); }
    const redactValues = g.resources?.[op.logical_resource_key]?.redactValues === true;
    const cmp = compareFields(op, page, redactValues, { OPEN_RUN: runRef }, fresh.state_last_write.operation_property_ids?.[String(op.ordinal)]);
    if (!cmp.ok) return hold("HOLD_TARGET_CHANGED_AFTER_TARGET_VERIFY", [...cmp.evidence, `target ${ref} no longer matches what TARGET verified`], "the target drifted after TARGET; the receipt is invalidated. Call os_resume, reconcile, then re-prepare", { drift: true, observations: { target_ref: ref, observed: redactValues ? Object.fromEntries(Object.keys(cmp.observed).map((k) => [k, redactValue(cmp.observed[k])])) : cmp.observed } });
    for (const [f, v] of Object.entries(snap?.protected ?? {})) {
      // A value-carrying resource stores its control-owned snapshot as a one-way token, so the comparison is made
      // between tokens: the backend keeps no business value and the check stays exact.
      const raw = propText(page, f) ?? null;
      const seen = redactValues ? redactValue(raw) : raw;
      if (seen !== v) return hold("HOLD_FINAL_GATE_INVALID", [`control-owned field "${f}" of ${ref} changed after TARGET: ${redactValues ? String(v) : JSON.stringify(v)} → ${redactValues ? String(seen) : JSON.stringify(seen)}`, "control-owned state (gate status, confirmation, pass attribution) is never advanced by a plugin transaction"], "revert the control-owned field; gate transitions follow the governing control contract", { drift: true });
    }
    // PV-FW-001: no legitimate write touches a target between TARGET and FINAL, so its revision must be the one
    // TARGET recorded. Values alone would miss an edit of an uncompared field or a same-value rewrite. The one
    // exception is a target that IS the cursor row (a derived cursor transition): STATE_LAST edits it after
    // TARGET by design, and step 4 below verifies that row by its pointers and ordering instead.
    if (ref !== fresh.state_last_write.target_ref && snap?.last_edited && snap.last_edited !== "UNKNOWN" && page.last_edited_time && page.last_edited_time !== snap.last_edited) return hold("HOLD_TARGET_CHANGED_AFTER_TARGET_VERIFY", [`target ${ref} was edited at ${page.last_edited_time}, after TARGET recorded it at ${snap.last_edited}`, "a record edited after its TARGET verification is not the record that was verified"], "the target drifted after TARGET; the receipt is invalidated. Call os_resume, reconcile, then re-prepare", { drift: true });
    // The state-last write must follow every write THIS transaction made. A re-adoption made none on this row:
    // its revision is the foreign edit's own, which says nothing about this transaction's ordering.
    if (!isReadoption(op) && (!newestTarget || later(page.last_edited_time, newestTarget))) newestTarget = page.last_edited_time;
  }

  // 4. State/Manifest LAST: points at this Run and its last mutation, and was written after every journal write.
  const cursorRef = fresh.state_last_write.target_ref;
  let cursor: Page;
  try { cursor = (await client.retrievePage(cursorRef)) as Page; } catch (err) { return hold("HOLD_STATE_LAST_NOT_PROVEN", [`State/Manifest ${cursorRef} unreadable: ${(err as Error).message}`], "restore the cursor row"); }
  const cp = g.stateCursor ?? g.manifestCursor;
  const lastRunIds = cp.lastRunRef ? propMentions(cursor, cp.lastRunRef) : [];
  const lastRunText = cp.lastRunRef ? (propText(cursor, cp.lastRunRef) ?? "") : "";
  const pointsAtRun = lastRunIds.includes(runRef) || lastRunText.includes(runRef);
  // A cursor untouched since the plan baseline is an ABSENT state-last write; one moved elsewhere is a concurrent conflict.
  const untouchedSinceBaseline = cursor.last_edited_time !== undefined && cursor.last_edited_time === fresh.baseline_runtime_revision;
  const pointsElsewhere = lastRunIds.length > 0 && !lastRunIds.includes(runRef) && !untouchedSinceBaseline;
  const recovery = cp.recoveryRequired ? propText(cursor, cp.recoveryRequired) === "true" : false;
  const persistence = cp.persistenceHealth ? propText(cursor, cp.persistenceHealth) : undefined;
  if (pointsElsewhere || recovery || (persistence ?? "").startsWith("HOLD")) {
    return hold("HOLD_FINAL_RUNTIME_CONFLICT", [pointsElsewhere ? `State/Manifest ${cursorRef} references Run ${lastRunIds[0]} instead of this transaction's Run ${runRef}: another actor advanced runtime authority` : `State/Manifest ${cursorRef} declares ${recovery ? "Recovery Required" : `persistence ${persistence}`}`, "FINAL never overwrites or ignores a concurrent runtime authority change"], "call os_resume; reconcile the concurrent change by hand before this transaction can complete");
  }
  if (!pointsAtRun) return hold("HOLD_STATE_LAST_NOT_PROVEN", [`State/Manifest ${cursorRef} does not reference Run ${runRef}: the state-last write is absent`], "execute state_last_action LAST (after every finalization action), then call os_verify(FINAL) again");
  const lastMutIds = cp.lastVerifiedMutation ? propMentions(cursor, cp.lastVerifiedMutation) : [];
  const lastMutText = cp.lastVerifiedMutation ? (propText(cursor, cp.lastVerifiedMutation) ?? "") : "";
  const lastLedger = ledgerRefs[ledgerRefs.length - 1] as string;
  if (cp.lastVerifiedMutation && !lastMutIds.includes(lastLedger) && !lastMutText.includes(lastLedger)) return hold("HOLD_STATE_LAST_NOT_PROVEN", [`State/Manifest ${cp.lastVerifiedMutation} does not reference the last verified ledger row ${lastLedger}`], "execute the state_last_action exactly as rendered, then call os_verify(FINAL) again");
  const cursorEdited = cursor.last_edited_time;
  const lateWrites = [["Run", run.last_edited_time], ["ledger", newestLedger], ["target", newestTarget]].filter(([, t]) => later(t as string | undefined, cursorEdited));
  if (lateWrites.length > 0) return hold("HOLD_STATE_LAST_NOT_PROVEN", [`State/Manifest was edited at ${cursorEdited ?? "UNKNOWN"} but ${lateWrites.map(([k, t]) => `${k} at ${t}`).join(", ")} came later: state advanced before the journal was complete`], "re-execute state_last_action after all finalization writes so it is the last edit, then call os_verify(FINAL) again");

  // 5. Terminal: final receipt, target receipt consumed, plan FINAL_VERIFIED, lease released.
  const cursorSpec = Object.values(g.resources ?? {}).find(s => s.backendDerivedOnly && s.naturalKeyProperty in cursor.properties);
  const cursor_observed = cursorSpec ? Object.fromEntries((cursorSpec.writableProperties ?? []).filter(f => cursor.properties[f]).map(f => [f, observedFingerprint(cursor, f)])) : undefined;
  const observations = { run_ref: runRef, ledger_refs: ledgerRefs, cursor_ref: cursorRef, cursor_last_edited: cursorEdited ?? "UNKNOWN", ...(cursor_observed ? { cursor_observed } : {}), target_receipt_id: targetReceipt.receipt_id, verified_at: now.toISOString(), governing: nowV };
  const receipt = await issueFinalReceipt(store, fresh, targetReceipt, observations, now);
  return { kind: "VERIFIED", receipt, target_receipt: targetReceipt, observations, warnings, repeated: false };
}

/** Drift after TARGET: invalidate the target receipt and park the plan. */
export async function parkOnDrift(deps: HarnessDeps, plan: Plan, now: Date, reason: string): Promise<string[]> {
  const notes: string[] = [];
  for (const r of await deps.store.receipts.findByPlan(plan.plan_id, "TARGET")) if (r.status === "VALID") { await deps.store.receipts.setStatus(r.receipt_id, "INVALID"); notes.push(`target receipt ${r.receipt_id} invalidated: ${reason}`); }
  const fresh = await deps.store.plans.get(plan.plan_id);
  if (fresh && (fresh.plan_state === "TARGET_VERIFIED" || fresh.plan_state === "AWAITING_FINAL_VERIFY")) { await transition(deps.store, plan.plan_id, "HOLD", now, { reason }); notes.push(`plan ${plan.plan_id} moved to HOLD`); }
  return notes;
}
