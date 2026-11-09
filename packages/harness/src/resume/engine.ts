/** os_resume engine: fresh control-plane read + deterministic derivation, for an owned, live binding. */
import type { BindingRecord } from "../binding/store.ts";
import type { HoldCode } from "../errors/codes.ts";
import type { NotionReadClient } from "../notion/readClient.ts";
import { StructureCache } from "../notion/structureCache.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import { deriveResumeState, type ResumeState } from "./derive.ts";
import { readControlPlane } from "./readers.ts";
import { evaluateCapabilityCompleteness } from "./capabilities.ts";
import { pendingStepInputs, unsatisfiedPendingStepInputs } from "./pendingInput.ts";
import type { BackendStore } from "../store/memory.ts";
import { buildVerificationIndex } from "./verificationIndex.ts";
import { pendingConfirmationFor, readForeignWrites, type ForeignWriteReport, type InFlightOp } from "./foreignWrites.ts";
import { lastProof, orphanConfirmationFor, readOrphanRows, type OrphanReport } from "./orphanRows.ts";
import type { Plan } from "../plans/store.ts";
import type { Intent } from "../plans/prepare.ts";
import { nativeCaptureMatches } from "../effects/eventWrite.ts";

export interface ResumeOutcomeOk { readonly kind: "OK"; readonly state: ResumeState; readonly warnings: readonly string[] }
export interface ResumeOutcomeHold { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly partial: Partial<ResumeState>; readonly warnings: readonly string[] }
export type ResumeOutcome = ResumeOutcomeOk | ResumeOutcomeHold;

const CONNECTOR_REMEDIATION = /capabilit|autoris|connect|gmail|calendar|agenda/i;

/** A completed profile must not leave a seller trapped on the connector sentence stored before the last proof. */
export function replaceCompletedCapabilityPrompt(runtime: ResolvedRuntime, state: ResumeState): ResumeState {
  const next = runtime.adapter.capabilities?.postCapabilityResume?.[String(state.gate.gate_key)];
  if (!next) return state;
  const connectorHold = state.effective_hold !== "NONE" && CONNECTOR_REMEDIATION.test(state.effective_hold.evidence.join(" "));
  const connectorPromptWithoutHold = state.effective_hold === "NONE" && CONNECTOR_REMEDIATION.test([state.next_safe_action, state.gate.formal_blocker, state.gate.formal_next_action, state.gate.formal_next_question].join(" "));
  if (!connectorHold && !connectorPromptWithoutHold) return state;
  return {
    ...state,
    effective_hold: "NONE",
    next_safe_action: next.nextAction,
    gate: { ...state.gate, formal_blocker: "NONE", formal_next_action: next.nextAction, formal_next_question: next.nextQuestion },
  };
}

/**
 * PV-FW-001: with a backend store in hand, every proved row of a guarded resource is re-read and compared with
 * its receipt. Without one (capability remediation, older callers) the check does not run and says so.
 */
async function foreignWriteCheck(client: NotionReadClient, runtime: ResolvedRuntime, read: { readonly state?: { readonly ref: string } }, store: BackendStore, index: ReadonlyMap<string, import("./verificationIndex.ts").VerifiedObject>, activePlans: readonly Plan[], captureObservation = false): Promise<ForeignWriteReport> {
  if (index.size === 0) return { foreign: [], coverage: { checked: 0, unknown: [], in_flight: [] } };
  const exclude = new Set<string>([runtime.manifest_ref, ...(read.state ? [read.state.ref] : [])]);
  const inFlight = new Map<string, InFlightOp>();
  for (const p of activePlans) {
    for (const op of p.operations) if (op.physical_target_ref) inFlight.set(op.physical_target_ref, { target_ref: op.physical_target_ref, compared_fields: op.compared_fields, before_values: op.before_values, expected_values: op.expected_values });
  }
  void store;
  return readForeignWrites(client, runtime, index, { exclude, inFlight, captureObservation });
}

/**
 * PV-ORPHAN-001: the walk's evidence rows and the cursor, looked for rather than re-compared. A plan past its
 * TTL protects nothing: it is not in flight, it is unfinished, and its rows are looked at like any other.
 */
async function orphanCheck(client: NotionReadClient, binding: BindingRecord, runtime: ResolvedRuntime, state: ResumeState, store: BackendStore, index: ReadonlyMap<string, import("./verificationIndex.ts").VerifiedObject>, activePlans: readonly Plan[], now: Date, captureObservation = false): Promise<OrphanReport> {
  const live = activePlans.filter((p) => p.expires_at > now);
  const lastFinal = lastProof(await store.receipts.findByRuntime(runtime.runtime_id, "FINAL"));
  const gate = typeof state.gate.gate_key === "string" ? state.gate.gate_key : "UNKNOWN";
  const cursor = { ref: state.cursor_ref, last_edited: typeof state.cursor_last_edited === "string" ? state.cursor_last_edited : "UNKNOWN", current_gate: gate };
  void binding;
  return readOrphanRows(client, runtime, index, { activePlans: live, lastFinal, cursor, captureObservation, provedGate: lastFinal ? await provedGateOf(store, runtime, lastFinal, state.cursor_ref) : undefined });
}

/**
 * The gate the product last held the cursor on, read from the plan its last FINAL proved: the cursor value that
 * plan wrote when it was a derived move, otherwise the gate its Run was opened on. Never the cursor's own word.
 */
async function provedGateOf(store: BackendStore, runtime: ResolvedRuntime, lastFinal: import("../verify/engine.ts").ReceiptRecord, cursorRef: string): Promise<string | undefined> {
  const plan = await store.plans.get(lastFinal.plan_id);
  if (!plan) return undefined;
  const g = runtime.adapter.controlPlane;
  const gateProp = (g.stateCursor ?? g.manifestCursor)?.currentGate;
  const moved = gateProp ? plan.operations.find((o) => o.physical_target_ref === cursorRef)?.expected_values[gateProp] : undefined;
  if (typeof moved === "string" && moved.trim() !== "") return moved;
  const opened = plan.stage1_writes.find((w) => w.purpose === "OPEN_RUN")?.fields[g.runProps.gateBefore];
  return typeof opened === "string" && opened.trim() !== "" ? opened : undefined;
}

/**
 * The row's values as they now stand, restricted to what a transaction may state. A control-owned field such as
 * the record's own key is proved and compared, but never sent as a change — os_prepare refuses that, rightly.
 */
async function currentValues(client: NotionReadClient, runtime: ResolvedRuntime, w: import("./foreignWrites.ts").ForeignWrite): Promise<Record<string, string> | undefined> {
  const { propText } = await import("../notion/shapes.ts");
  const spec = runtime.adapter.controlPlane.resources?.[w.logical_resource_key];
  const owned = new Set(spec?.protectedProperties ?? []);
  try {
    const page = (await client.retrievePage(w.target_ref)) as import("../notion/shapes.ts").Page;
    return Object.fromEntries(w.governed_fields.filter((f) => !owned.has(f)).map((f) => [f, propText(page, f) ?? ""]));
  } catch { return undefined; }
}

export async function rehydrate(client: NotionReadClient, binding: BindingRecord, runtime: ResolvedRuntime, store?: BackendStore, now: Date = new Date(), nativeCapture?: Intent, automaticAdoption = false): Promise<ResumeOutcome> {
  // Candidate read-only observation only. Never share this structure with preparation, guards, execution
  // or the next post-write observation; pages and queries remain fresh through StructureCache.
  if (automaticAdoption) client = new StructureCache(client);
  const warnings: string[] = [...runtime.warnings];
  // Governing versions at bind time vs now: informational for resume (prepare decides HOLD_VERSION_CHANGED).
  const snap = binding.governing_versions_snapshot;
  const gov = runtime.versions;
  const fresh = { spec: gov.governing_spec === "UNKNOWN" ? "UNKNOWN" : gov.governing_spec.value, schema: gov.governing_schema === "UNKNOWN" ? "UNKNOWN" : gov.governing_schema.value, control: gov.governing_control === "UNKNOWN" ? "UNKNOWN" : gov.governing_control.value };
  for (const k of ["spec", "schema", "control"] as const) if (snap[k] !== undefined && snap[k] !== fresh[k]) warnings.push(`governing_${k}_changed_since_bind: bound=${snap[k]} now=${fresh[k]}`);
  // Registry snapshot (SALES discovery cache) vs fresh canonical state.
  if (runtime.registry_snapshot) {
    const rs = runtime.registry_snapshot;
    if (rs["install_state"] && rs["install_state"] !== runtime.lifecycle_state) warnings.push(`registry_snapshot_stale: install_state registry=${rs["install_state"]} manifest=${runtime.lifecycle_state}`);
  }

  const read = await readControlPlane(client, runtime);
  if ("hold" in read) return { kind: "HOLD", code: read.hold, evidence: read.evidence, partial: {}, warnings };
  warnings.push(...read.warnings);
  if (runtime.registry_snapshot?.["current_gate"] && read.state && read.state.current_gate !== "UNKNOWN" && runtime.registry_snapshot["current_gate"] !== read.state.current_gate) {
    warnings.push(`registry_snapshot_stale: current_gate registry=${runtime.registry_snapshot["current_gate"]} os_state=${read.state.current_gate}`);
  }
  const pendingIntents = read.external_intents.filter((row) => !row.native_reconciliation);
  const capturing = nativeCapture && pendingIntents.length === 1 && nativeCaptureMatches(runtime, nativeCapture, pendingIntents[0]!)
    ? pendingIntents[0]!.ref : undefined;
  const derived = deriveResumeState(read, capturing);
  // The contract's declaration for the durable gate that was just read, served only while the canonical row it
  // names does not already answer it. It is an address, not authority: it grants nothing, and the same
  // declaration is what os_prepare enforces.
  const gateKey = (derived.kind === "HOLD" ? derived.partial.gate : derived.state.gate)?.gate_key;
  const unsatisfied = await unsatisfiedPendingStepInputs(client, runtime, gateKey);
  const pending = unsatisfied[0];
  // Candidate only: an absent declaration (especially B7) is not an answered step. Reuse the same
  // observation; this boolean exposes no answer and is never permission to skip a fresh guarded movement.
  const satisfied = runtime.adapter.controlPlane.localAnswerSources !== undefined
    && pendingStepInputs(runtime, gateKey).length > 0 && unsatisfied.length === 0;
  const withPending = <T extends object>(s: T): T => pending ? { ...s, pending_step_input: pending }
    : satisfied ? { ...s, setup_input_satisfied: true } : s;
  const capability = evaluateCapabilityCompleteness(runtime, read);
  for (const h of (derived.kind === "HOLD" ? derived.partial.historical_holds : derived.state.historical_holds) ?? []) warnings.push(`historical_hold_superseded: ${h.label} (${h.status}, required writes at ${h.last_required_written_at}) predates the cursor watermark and was superseded by ${h.superseded_by}; pins preserved, not recovery`);
  for (const m of (derived.kind === "HOLD" ? derived.partial.historical_mutations : derived.state.historical_mutations) ?? []) warnings.push(`historical_mutation_superseded: ${m.label} (${m.status}, edited ${m.last_edited}) predates the cursor watermark and was superseded by ${m.superseded_by}; kept for audit, not recovery`);
  if (derived.kind === "HOLD") return { kind: "HOLD", code: derived.code, evidence: derived.evidence, partial: withPending({ ...derived.partial, ...(capability ? { capability_completeness: capability } : {}) }), warnings };
  let state: ResumeState = withPending({ ...derived.state, ...(capability ? { capability_completeness: capability } : {}) });
  if (state.effective_hold !== "NONE" && state.effective_hold.code === "HOLD_RECOVERY_REQUIRED") {
    return { kind: "HOLD", code: "HOLD_RECOVERY_REQUIRED", evidence: state.effective_hold.evidence, partial: state, warnings };
  }
  // PV-FW-001: proved rows re-read and compared with their receipts. A row the seller owns and changed is a
  // decision to record, not an incident to refuse — it becomes the next question, asked before the step's own.
  // Coverage is reported as it is: what could not be read is unknown, never counted as verified.
  if (store) {
    const index = await buildVerificationIndex(store, runtime.runtime_id);
    const activePlans = await store.plans.findActive(binding.project, binding.lane, binding.runtime_generation);
    const fw = await foreignWriteCheck(client, runtime, read, store, index, activePlans, automaticAdoption);
    state = { ...state, foreign_writes: fw.foreign, coverage: fw.coverage };
    for (const u of fw.coverage.unknown) warnings.push(`foreign_write_coverage_unknown: ${u.logical_resource_key} ${u.target_ref} ${u.reason}`);
    const first = fw.foreign[0];
    if (first && !automaticAdoption) {
      const current = await currentValues(client, runtime, first);
      if (current) state = { ...state, pending_confirmation: pendingConfirmationFor(first, current) };
      else warnings.push(`foreign_write_unconfirmable: ${first.logical_resource_key} ${first.natural_key} became unreadable between the check and the question`);
    }
    // PV-ORPHAN-001: what the walk rests on that nothing proved, and a cursor the product did not move. Asked
    // about once, after any changed proved row; a cursor sitting past a step whose evidence is absent is not
    // adoptable and is said as it is, because no re-adoption can attest an answer that does not exist.
    const orphan = await orphanCheck(client, binding, runtime, state, store, index, activePlans, now, automaticAdoption);
    state = { ...state, orphan_rows: orphan.orphans, ...(orphan.cursor ? { cursor_drift: orphan.cursor } : {}), coverage: { checked: state.coverage!.checked + orphan.coverage.checked, unknown: [...state.coverage!.unknown, ...orphan.coverage.unknown], in_flight: [...state.coverage!.in_flight, ...orphan.coverage.in_flight] } };
    for (const u of orphan.coverage.unknown) warnings.push(`orphan_coverage_unknown: ${u.logical_resource_key} ${u.target_ref} ${u.reason}`);
    if (orphan.unjustified) {
      const u = orphan.unjustified;
      const evidence = [
        `the durable cursor sits on ${u.current_gate}, edited at ${orphan.cursor?.last_edited_observed ?? "UNKNOWN"} outside any transaction of this runtime (last proved at ${orphan.cursor?.last_edited_verified ?? "UNKNOWN"})`,
        `the step ${u.missing_step} it has passed has no verified answer: ${u.logical_resource_key} ${u.natural_key} is ${u.observation}`,
        "a cursor ahead of its evidence cannot be re-adopted; nothing was written",
      ];
      return { kind: "HOLD", code: "HOLD_STATE_DIVERGENCE", evidence, partial: { ...state, effective_hold: { code: "HOLD_STATE_DIVERGENCE", evidence }, next_safe_action: `the durable step must be brought back to ${u.missing_step} by the space owner, or that step's answer recorded, before anything else` }, warnings };
    }
    if (!automaticAdoption && !state.pending_confirmation) {
      const confirm = orphanConfirmationFor(orphan);
      if (confirm) state = { ...state, pending_confirmation: confirm };
    }
  }
  if (capability && !capability.complete) {
    const evidence = capability.comparisons.filter((c) => c.requirement === "REQUIRED" && !c.satisfied).map((c) => `${c.capability}=${c.state}: ${c.reason}`);
    const held: ResumeState = { ...state, effective_hold: { code: "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", evidence }, next_safe_action: capability.next_human_action };
    return { kind: "HOLD", code: "HOLD_REQUIRED_CAPABILITY_INCOMPLETE", evidence, partial: held, warnings };
  }
  if (capability?.complete) state = replaceCompletedCapabilityPrompt(runtime, state);
  return { kind: "OK", state, warnings };
}
