/** Dedicated INSTALL_ONLY planner/verifier. Copied Runs, Ledger and business rows remain quarantined; the one
 * canonical OS State cursor is located structurally and overwritten from a server-derived baseline before SETUP. */
import { createHash } from "node:crypto";
import type { BindingRecord } from "../binding/store.ts";
import type { HoldCode } from "../errors/codes.ts";
import { normalizeId, propText, type Page } from "../notion/shapes.ts";
import type { Intent } from "../plans/prepare.ts";
import { checkTargetReceipt, createPlan, expireIfDue, issueFinalReceipt, issueTargetReceipt, opaqueId, transition } from "../plans/service.ts";
import type { Plan, PlanOperation, WriteInstruction } from "../plans/store.ts";
import type { ReceiptRecord } from "../verify/engine.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { InstallAssignmentSnapshot } from "../registry/salesRuntimes.ts";
import type { HarnessDeps } from "../tools/handlers.ts";
import { INSTALL_MANIFEST_RESOURCE, INSTALL_OS_STATE_RESOURCE, INSTALL_REGISTRY_RESOURCE, inspectInstallBootstrap, installManifestTemplate, installStateTemplate, queryInstallRegistryRows, resolveInstallRegistry, validateInstallMappingIntent, validatePromotionIntent } from "./bootstrap.ts";

const hash = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const canaryKey = (planId: string): string => `VERIFICATION_INSTALLATION:${planId}`;
const proofPlanId = (plan: Plan): string => plan.recovers_plan_id ?? plan.plan_id;
const versionValue = (v: ResolvedRuntime["versions"]["governing_spec"]): string => v === "UNKNOWN" ? "UNKNOWN" : v.value;

/**
 * Authority snapshot used by every INSTALL boundary. The runtime generation intentionally remains a physical
 * locator generation; this additional fingerprint also includes backend assignment claims and governing pins so
 * a 0.5 -> 0.6 publication, reassigned instance id, or changed expected mailbox invalidates an in-flight plan.
 */
export const installContextFingerprint = (runtime: ResolvedRuntime): string => hash({
  logical_key: runtime.logical_key,
  runtime_id: runtime.runtime_id,
  runtime_generation: runtime.runtime_generation,
  root_ref: normalizeId(runtime.root_ref) ?? runtime.root_ref,
  manifest_ref: normalizeId(runtime.manifest_ref) ?? runtime.manifest_ref,
  pointer_generation: runtime.pointer_generation,
  governing: {
    spec: versionValue(runtime.versions.governing_spec),
    schema: versionValue(runtime.versions.governing_schema),
    control: versionValue(runtime.versions.governing_control),
  },
  assignment: {
    status: runtime.observations["registry_status"] ?? "UNKNOWN",
    rep_identity_key: runtime.observations["rep_identity_key"] ?? "UNKNOWN",
    expected_instance_id: runtime.observations["registry_expected_instance_id"] ?? "UNKNOWN",
    expected_gmail_identity: typeof runtime.observations["registry_expected_gmail_identity"] === "string"
      ? runtime.observations["registry_expected_gmail_identity"].toLowerCase()
      : "UNKNOWN",
    objective_package_ref: runtime.observations["objective_package_ref"] ?? "UNKNOWN",
  },
});

function assignmentSnapshotFromRuntime(runtime: ResolvedRuntime): InstallAssignmentSnapshot | undefined {
  const repKey = runtime.observations["rep_identity_key"];
  const expectedInstance = runtime.observations["registry_expected_instance_id"];
  const expectedMailbox = runtime.observations["registry_expected_gmail_identity"];
  if (runtime.observations["registry_status"] !== "INSTALL_PENDING" || typeof repKey !== "string" || typeof expectedInstance !== "string" || !expectedInstance.trim()) return undefined;
  const pointer = typeof runtime.pointer_generation === "string" && runtime.pointer_generation !== "UNKNOWN" && runtime.pointer_generation !== "NOT_APPLICABLE"
    ? runtime.pointer_generation
    : null;
  return {
    rep_identity_key: repKey,
    status: "INSTALL_PENDING",
    pointer_generation: pointer,
    root_ref: runtime.root_ref,
    expected_instance_id: expectedInstance,
    expected_gmail_identity: typeof expectedMailbox === "string" && expectedMailbox !== "UNKNOWN" && expectedMailbox !== "NOT_APPLICABLE"
      ? expectedMailbox
      : null,
    objective_package_ref: typeof runtime.observations["objective_package_ref"] === "string" && runtime.observations["objective_package_ref"] !== "NOT_APPLICABLE"
      ? runtime.observations["objective_package_ref"]
      : null,
    activation_proof_plan_id: null,
  };
}

type ContextCheck = { readonly ok: true } | { readonly ok: false; readonly code: HoldCode; readonly evidence: readonly string[] };

function checkInstallContext(plan: Plan, runtime: ResolvedRuntime): ContextCheck {
  const evidence: string[] = [];
  if (plan.runtime_logical_key !== runtime.logical_key) evidence.push("runtime logical assignment changed during installation");
  if (plan.runtime_id !== runtime.runtime_id) evidence.push(`assigned runtime id changed (${plan.runtime_id} -> ${runtime.runtime_id})`);
  if (plan.runtime_generation !== runtime.runtime_generation) evidence.push("runtime generation changed during installation");
  if (evidence.length > 0) return { ok: false, code: "HOLD_PLAN_RUNTIME_MISMATCH", evidence };

  const versions = {
    spec: versionValue(runtime.versions.governing_spec),
    schema: versionValue(runtime.versions.governing_schema),
    control: versionValue(runtime.versions.governing_control),
  };
  if (plan.governing_spec_version !== versions.spec) evidence.push(`governing spec changed (${plan.governing_spec_version} -> ${versions.spec})`);
  if (plan.governing_schema_version !== versions.schema) evidence.push(`governing schema changed (${plan.governing_schema_version} -> ${versions.schema})`);
  if (plan.governing_control_version !== versions.control) evidence.push(`governing control changed (${plan.governing_control_version} -> ${versions.control})`);
  if (plan.install_context_fingerprint !== installContextFingerprint(runtime)) evidence.push("backend install assignment identity changed after PREPARE");
  return evidence.length > 0 ? { ok: false, code: "HOLD_VERSION_CHANGED_DURING_TRANSACTION", evidence } : { ok: true };
}

const canaryStaticViolations = (page: Page, planId: string, runtime: ResolvedRuntime): string[] => {
  const expected: Readonly<Record<string, string>> = {
    Key: canaryKey(planId), Required: "false", "Resource URL": runtime.root_ref,
    "Resource Type": "PAGE", Scope: "READ_WRITE", Notes: "Vérification bornée de l'installation ; aucune donnée commerciale.",
  };
  const violations: string[] = [];
  for (const [field, value] of Object.entries(expected)) {
    const seen = propText(page, field);
    const equal = field === "Resource URL" ? normalizeId(seen) === value : seen === value;
    if (!equal) violations.push(`installation verification field ${field} differs from its plan-bound value`);
  }
  return violations;
};

export const isInstallMappingPlan = (p: Plan): boolean => p.plan_kind === "INSTALL_MAPPING";
export const isInstallPromotionPlan = (p: Plan): boolean => p.plan_kind === "INSTALL_PROMOTION";

type InstallPrepare =
  | { readonly kind: "PREPARED"; readonly plan: Plan; readonly replayed: boolean; readonly phase: "CARTOGRAPHIE" | "ACTIVATION" }
  | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly safe_action: string };

const hold = (code: HoldCode, evidence: readonly string[], safe_action: string): InstallPrepare => ({ kind: "HOLD", code, evidence, safe_action });

/** The most recent mapping proof available to bind a promotion to: one exact plan AND its one exact FINAL receipt. */
async function finalizedMapping(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime): Promise<{ readonly plan: Plan; readonly receipt: ReceiptRecord } | undefined> {
  const plans = await deps.store.plans.listByRuntime(binding.project, binding.lane, binding.runtime_generation);
  for (const p of [...plans].reverse()) if (p.principal_id === binding.principal_id && p.runtime_id === binding.runtime_id && p.runtime_generation === binding.runtime_generation && p.plan_state === "FINAL_VERIFIED" && isInstallMappingPlan(p) && checkInstallContext(p, runtime).ok) {
    const receipt = (await deps.store.receipts.findByPlan(p.plan_id, "FINAL")).find((r) => r.status === "VALID");
    if (receipt) return { plan: p, receipt };
  }
  return undefined;
}

export const hasFinalizedInstallMapping = async (deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime): Promise<boolean> => (await finalizedMapping(deps, binding, runtime)) !== undefined;

type ProofOutcome =
  | { readonly ok: true; readonly mapping_plan: Plan; readonly canary_ref: string; readonly proof_fingerprint: string }
  | { readonly ok: false; readonly evidence: readonly string[] };

type FinalizationLineage =
  | { readonly ok: true; readonly target: ReceiptRecord; readonly incumbent_final?: ReceiptRecord }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolves the one TARGET that may close a plan. Besides the normal VALID path, this deliberately accepts the two
 * durable crash footprints produced by the former multi-write FINAL sequence: TARGET already CONSUMED with no
 * FINAL, or FINAL already inserted while the plan/lease still lag. The caller still revalidates live Notion state
 * before invoking the store's atomic, idempotent finalize primitive.
 */
async function finalizationLineage(deps: HarnessDeps, plan: Plan, now: Date, committedInstallProof = false): Promise<FinalizationLineage> {
  const incumbentFinal = (await deps.store.receipts.findByPlan(plan.plan_id, "FINAL")).find((r) => r.status === "VALID");
  const targets = await deps.store.receipts.findByPlan(plan.plan_id, "TARGET");
  const target = incumbentFinal?.target_receipt_id
    ? await deps.store.receipts.get(incumbentFinal.target_receipt_id)
    : targets.find((r) => r.status === "VALID") ?? targets.find((r) => r.status === "CONSUMED")
      ?? (committedInstallProof ? targets.find((r) => r.status === "EXPIRED") : undefined);
  if (!target || target.type !== "TARGET") return { ok: false, reason: "absent" };
  if (target.plan_id !== plan.plan_id || target.principal_id !== plan.principal_id || target.runtime_id !== plan.runtime_id || target.runtime_generation !== plan.runtime_generation) {
    return { ok: false, reason: "wrong plan, principal or runtime generation" };
  }
  if (target.status !== "VALID" && target.status !== "CONSUMED" && !(committedInstallProof && target.status === "EXPIRED")) return { ok: false, reason: target.status };
  if (incumbentFinal && incumbentFinal.target_receipt_id !== target.receipt_id) return { ok: false, reason: "the stored final result references another target" };
  if (!incumbentFinal && target.status === "VALID" && !committedInstallProof) {
    const checked = await checkTargetReceipt(deps.store, plan, target.receipt_id, now);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    return { ok: true, target: checked.receipt };
  }
  return { ok: true, target, ...(incumbentFinal ? { incumbent_final: incumbentFinal } : {}) };
}

/**
 * Gate P0-2. Re-proves, from scratch and from live sources, the ONE mapping proof a promotion was bound to.
 * Every input is re-read at call time: the mapping plan row, its FINAL receipt row, the contract-derived mapping
 * recomputed from the assigned clone, and the terminal plan-bound canary. Any tampering performed after the
 * promotion's own TARGET verification therefore surfaces here, immediately before backend activation.
 */
async function revalidateBoundMappingProof(deps: HarnessDeps, runtime: ResolvedRuntime, promotion: Plan): Promise<ProofOutcome> {
  const promotionContext = checkInstallContext(promotion, runtime);
  if (!promotionContext.ok) return { ok: false, evidence: promotionContext.evidence };
  const mappingPlanId = promotion.install_mapping_plan_id;
  const mappingReceiptId = promotion.install_mapping_final_receipt_id;
  if (!mappingPlanId || !mappingReceiptId) return { ok: false, evidence: ["promotion plan carries no bound mapping proof (plan id + FINAL receipt id)"] };

  const mappingPlan = await deps.store.plans.get(mappingPlanId);
  if (!mappingPlan) return { ok: false, evidence: [`bound mapping plan ${mappingPlanId} no longer exists`] };
  if (!isInstallMappingPlan(mappingPlan)) return { ok: false, evidence: ["the bound proof is not a structural mapping plan"] };
  if (mappingPlan.plan_state !== "FINAL_VERIFIED") return { ok: false, evidence: [`bound mapping plan is ${mappingPlan.plan_state}, not FINAL_VERIFIED`] };
  if (mappingPlan.principal_id !== promotion.principal_id) return { ok: false, evidence: ["bound mapping plan belongs to another principal"] };
  if (mappingPlan.runtime_id !== promotion.runtime_id) return { ok: false, evidence: ["bound mapping plan belongs to another runtime"] };
  if (mappingPlan.runtime_generation !== promotion.runtime_generation) return { ok: false, evidence: ["bound mapping plan belongs to another runtime generation"] };
  const mappingContext = checkInstallContext(mappingPlan, runtime);
  if (!mappingContext.ok) return { ok: false, evidence: mappingContext.evidence };

  const receipt = await deps.store.receipts.get(mappingReceiptId);
  if (!receipt) return { ok: false, evidence: [`bound mapping FINAL receipt ${mappingReceiptId} no longer exists`] };
  if (receipt.type !== "FINAL" || receipt.plan_id !== mappingPlanId) return { ok: false, evidence: ["bound receipt is not the FINAL receipt of the bound mapping plan"] };
  if (receipt.status !== "VALID") return { ok: false, evidence: [`bound mapping FINAL receipt is ${receipt.status}`] };
  if (receipt.principal_id !== promotion.principal_id || receipt.runtime_generation !== promotion.runtime_generation) return { ok: false, evidence: ["bound mapping FINAL receipt does not describe this principal/runtime generation"] };

  // Fresh, contract-derived mapping. Nothing is taken from the earlier inspection or from copied Registry values.
  const inspection = await inspectInstallBootstrap(deps.notion, runtime);
  if (inspection.violations.length > 0) return { ok: false, evidence: inspection.violations };
  const proved = new Map(mappingPlan.operations.map((o) => [o.natural_key ?? "", o]));
  const evidence: string[] = [];
  if (proved.size !== inspection.mapping.length) evidence.push(`bound mapping proved ${proved.size} Registry keys; the contract now derives ${inspection.mapping.length}`);
  for (const m of inspection.mapping) {
    const op = proved.get(m.key);
    if (!op) { evidence.push(`${m.key} is contract-required but was not part of the bound mapping proof`); continue; }
    if (normalizeId(String(op.expected_values["Resource URL"] ?? "")) !== m.candidate_ref) evidence.push(`${m.key} was proved against a different physical resource than the contract derives now`);
    const candidate = inspection.candidates.find((c) => c.registry_key === m.key);
    if (!candidate?.observed_points_to_candidate) evidence.push(`${m.key} no longer points at its unique contract-derived clone resource`);
    if (candidate?.observed_status !== "RESOLVED") evidence.push(`${m.key} status is ${candidate?.observed_status ?? "UNKNOWN"}, expected RESOLVED`);
    if (candidate?.observed_required !== String(m.required)) evidence.push(`${m.key} Required is ${candidate?.observed_required ?? "UNKNOWN"}, expected ${m.required}`);
    if (candidate?.observed_resource_type !== m.object_type) evidence.push(`${m.key} Resource Type is ${candidate?.observed_resource_type ?? "UNKNOWN"}, expected ${m.object_type}`);
    if (candidate?.observed_scope !== m.scope) evidence.push(`${m.key} Scope is ${candidate?.observed_scope ?? "UNKNOWN"}, expected ${m.scope}`);
    if (!candidate?.observed_notes_matches_contract) evidence.push(`${m.key} Notes differ from the contract-derived value`);
  }
  if (evidence.length > 0) return { ok: false, evidence };

  // The terminal canary is bound to the MAPPING plan id, so no canary of any other plan can satisfy this proof.
  const canaryRef = normalizeId(receipt.observations["canary_ref"] as string | undefined);
  if (!canaryRef) return { ok: false, evidence: ["the final structural proof records no terminal verification row"] };
  let canary: Page;
  try { canary = (await deps.notion.retrievePage(canaryRef)) as Page; }
  catch (err) { return { ok: false, evidence: [`the terminal verification row is unreadable: ${(err as Error).message}`] }; }
  if (canary.archived || canary.in_trash) return { ok: false, evidence: ["the terminal verification row was archived or trashed after the structural proof"] };
  if (propText(canary, "Key") !== canaryKey(proofPlanId(mappingPlan))) return { ok: false, evidence: ["the terminal verification row does not belong to the bound structural plan lineage"] };
  if (propText(canary, "Status") !== "RESOLVED") return { ok: false, evidence: [`the terminal verification row is ${propText(canary, "Status") ?? "UNKNOWN"}, expected RESOLVED`] };
  if (normalizeId(canary.parent?.data_source_id) !== inspection.registry_data_source_ref) return { ok: false, evidence: ["the terminal verification row is outside the assigned workspace Registry"] };
  const staticCanary = canaryStaticViolations(canary, proofPlanId(mappingPlan), runtime);
  if (staticCanary.length > 0) return { ok: false, evidence: staticCanary };
  const proofFingerprint = hash({
    inspection: inspection.inspection_fingerprint ?? "UNKNOWN",
    mapping: inspection.candidates.filter((c) => c.registry_key).map((c) => [c.registry_key, c.object_ref, c.schema_fingerprint ?? null, c.registry_row_ref ?? null, c.registry_row_revision ?? null, c.observed_resource_ref ?? null, c.observed_status ?? null]),
    verification: [canaryRef, canary.last_edited_time ?? null, propText(canary, "Key") ?? null, propText(canary, "Status") ?? null, normalizeId(canary.parent?.data_source_id) ?? null],
  });
  return { ok: true, mapping_plan: mappingPlan, canary_ref: canaryRef, proof_fingerprint: proofFingerprint };
}

function operation(planId: string, ordinal: number, key: string, row: Page, expected: Readonly<Record<string, unknown>>, logical = INSTALL_REGISTRY_RESOURCE): PlanOperation {
  const compared = Object.keys(expected).sort();
  const before = Object.fromEntries(compared.map((field) => [field, propText(row, field) ?? null]));
  return {
    operation_id: hash(`${planId}:${ordinal}:${key}`).slice(0, 24), ordinal, logical_resource_key: logical,
    physical_target_ref: normalizeId(row.id) as string,
    ...((normalizeId(row.parent?.data_source_id) ?? normalizeId(row.parent?.database_id)) ? { target_data_source_ref: (normalizeId(row.parent?.data_source_id) ?? normalizeId(row.parent?.database_id)) as string } : {}),
    natural_key: key, natural_key_property: logical === INSTALL_REGISTRY_RESOURCE ? "Key" : "Name",
    idempotency_key: hash([bindingSalt(row), key, expected]).slice(0, 32), operation: "UPDATE",
    ...(row.last_edited_time ? { baseline_revision: row.last_edited_time } : {}), compared_fields: compared,
    before_values: before, expected_values: expected, before_hash: hash(before), expected_hash: hash(expected),
  };
}

const bindingSalt = (row: Page): string => normalizeId(row.id) ?? row.id;

async function installStateCurrent(deps: HarnessDeps, stateDataSourceRef: string): Promise<{ readonly row?: Page; readonly evidence: readonly string[] }> {
  const q = (await deps.notion.queryDataSource(stateDataSourceRef, { property: "Name", title: { equals: "CURRENT" } })) as { readonly results: readonly Page[] };
  const rows = q.results.filter((p) => !p.archived && !p.in_trash && propText(p, "Name") === "CURRENT");
  if (rows.length !== 1) return { evidence: [`OS State must contain exactly one live CURRENT row, found ${rows.length}`] };
  return { row: rows[0] as Page, evidence: [] };
}

export async function prepareInstall(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, intent: Intent, now: Date): Promise<InstallPrepare> {
  if (binding.binding_mode !== "INSTALL_ONLY" || binding.install_phase !== "INSTALL_PENDING") return hold("HOLD_INSTALL_REQUIRED", ["binding is not a persisted INSTALL_PENDING authorization"], "call os_bind again and follow the current runtime mode");
  const principal = await deps.principals.get(binding.principal_id);
  if (!principal) return hold("HOLD_PERMISSION_UNKNOWN", ["principal is no longer resolvable"], "re-authenticate, then call os_bind");
  if (!principal.display_name?.trim()) return hold("HOLD_PERMISSION_UNKNOWN", ["the authenticated principal has no stable display_name for Manifest ownership"], "complete the account identity, then continue normally");

  if (intent.action_class === "INSTALL_PROMOTE") {
    const prior = await finalizedMapping(deps, binding, runtime);
    if (!prior) return hold("HOLD_INSTALL_REQUIRED", ["no verified structural mapping exists for this workspace version"], "complete the structural verification before finalizing the workspace identity");
    const inspection = await inspectInstallBootstrap(deps.notion, runtime);
    const bad = inspection.mapping.filter((m) => {
      const c = inspection.candidates.find((x) => x.registry_key === m.key);
      return !c?.observed_points_to_candidate || c.observed_status !== "RESOLVED";
    });
    if (inspection.violations.length > 0 || bad.length > 0) return hold("HOLD_INSTALL_REQUIRED", [...inspection.violations, ...bad.map((m) => `${m.key} is not verified RESOLVED at its contract-derived target`)], "repair and reverify the structural mapping before promotion");
    const violations = validatePromotionIntent(principal, runtime, intent);
    if (violations.length > 0) return hold("HOLD_INSTALL_REQUIRED", violations, "use the exact server-derived promotion intent from os_resume");
    if (!inspection.state_data_source_ref) return hold("HOLD_REQUIRED_RESOURCE_MISSING", ["OS State data source is unavailable"], "restore/share the assigned clone OS State database");
    const currentState = await installStateCurrent(deps, inspection.state_data_source_ref);
    if (!currentState.row) return hold("HOLD_INSTALL_REQUIRED", currentState.evidence, "restore one canonical OS State CURRENT row before promotion");
    const manifest = (await deps.notion.retrievePage(runtime.manifest_ref)) as Page;
    const planId = opaqueId();
    const expected = installManifestTemplate(principal, runtime);
    const stateExpected = installStateTemplate();
    const manifestOp = operation(planId, 0, "CURRENT", manifest, expected, INSTALL_MANIFEST_RESOURCE);
    const stateOp = operation(planId, 1, "CURRENT", currentState.row, stateExpected, INSTALL_OS_STATE_RESOURCE);
    const normalizeState: WriteInstruction = {
      ordinal: 0, symbol: "NORMALIZE_OS_STATE", target_ref: normalizeId(currentState.row.id) as string,
      operation: "UPDATE", purpose: "TRANSACTIONAL_RECORD", fields: stateExpected,
      property_types: Object.fromEntries(Object.keys(stateExpected).map((k) => [k,
        k === "Recovery Required" ? "checkbox"
          : ["Build State", "Current Gate", "Current Gate Status", "Persistence Health"].includes(k) ? "select"
            : ["Last Required Written At", "Last Verified At"].includes(k) ? "date" : "rich_text"])),
      note: "Replace the copied UNBOUND template cursor with the clean B0 setup baseline before Manifest SETUP.",
    };
    const stateLast: WriteInstruction = { ordinal: 1, symbol: "PROMOTE_MANIFEST", target_ref: runtime.manifest_ref, operation: "UPDATE", purpose: "STATE_LAST", fields: expected, property_types: Object.fromEntries(Object.keys(expected).map((k) => [k, k === "Gmail Verified" || k === "Recovery Required" ? "checkbox" : k === "Root URL" || k === "Sales Contract URL" ? "url" : k === "Gmail Identity" ? "email" : ["Install State", "Instance Status", "Tracker Access", "Capability Status", "Health Status", "Persistence Health", "Current Gate", "Current Gate Status"].includes(k) ? "select" : "rich_text"])) };
    const gov = runtime.versions;
    const created = await createPlan(deps.store, deps.config, {
      plan_id: planId, principal_id: binding.principal_id, binding,
      plan_kind: "INSTALL_PROMOTION",
      // P0-2: this promotion is bound to THIS mapping plan and THIS final receipt, never to "a" final mapping.
      install_mapping_plan_id: prior.plan.plan_id,
      install_mapping_final_receipt_id: prior.receipt.receipt_id,
      install_context_fingerprint: installContextFingerprint(runtime),
      governing: { spec: gov.governing_spec === "UNKNOWN" ? "UNKNOWN" : gov.governing_spec.value, schema: gov.governing_schema === "UNKNOWN" ? "UNKNOWN" : gov.governing_schema.value, control: gov.governing_control === "UNKNOWN" ? "UNKNOWN" : gov.governing_control.value },
      run_mode: "OPEN_NEW", execution_attempt_id: opaqueId(), baseline_runtime_revision: manifest.last_edited_time ?? "UNKNOWN",
      operations: [manifestOp, stateOp], stage1_writes: [], finalization_writes: [normalizeState], state_last_write: stateLast,
    }, now);
    if (created.kind === "BUSY") return hold("HOLD_RUNTIME_BUSY", ["another install plan holds this runtime generation"], "finish or let the active install plan expire");
    return { kind: "PREPARED", plan: created.plan, replayed: created.kind === "EXISTING", phase: "ACTIVATION" };
  }

  const validated = await validateInstallMappingIntent(deps.notion, runtime, intent);
  if (validated.violations.length > 0) return hold("HOLD_INSTALL_REQUIRED", validated.violations, "use the complete contract-derived mapping returned by os_resume");
  if (!validated.inspection.registry_data_source_ref) return hold("HOLD_REQUIRED_RESOURCE_MISSING", ["Registry data source is unavailable"], "restore/share the assigned clone Registry");
  const planId = opaqueId();
  const ops: PlanOperation[] = [];
  const writes: WriteInstruction[] = [];
  for (const [i, m] of validated.inspection.mapping.entries()) {
    const row = (await deps.notion.retrievePage(m.row_ref)) as Page;
    const expected = { Required: m.required, "Resource URL": m.candidate_url, "Resource Type": m.object_type, Status: "HOLD", Scope: m.scope, Notes: m.notes };
    ops.push(operation(planId, i, m.key, row, expected));
    writes.push({ ordinal: i, symbol: `MAP_${i}`, target_ref: m.row_ref, operation: "UPDATE", purpose: "WRITE_TARGET", fields: expected, property_types: { Required: "checkbox", "Resource URL": "url", "Resource Type": "select", Status: "select", Scope: "select", Notes: "rich_text" }, note: `${m.key}: contract-derived ${m.object_type} at ${m.exact_path}` });
  }
  writes.push({
    ordinal: writes.length, symbol: "INSTALL_VERIFICATION", target_ref: validated.inspection.registry_data_source_ref, operation: "CREATE", purpose: "TRANSACTIONAL_RECORD",
    fields: { Key: canaryKey(planId), Required: false, "Resource URL": `https://www.notion.so/${runtime.root_ref}`, "Resource Type": "PAGE", Status: "MISSING", Scope: "READ_WRITE", Notes: "Vérification bornée de l'installation ; aucune donnée commerciale." },
    property_types: { Key: "title", Required: "checkbox", "Resource URL": "url", "Resource Type": "select", Status: "select", Scope: "select", Notes: "rich_text" },
  });
  const finalization = validated.inspection.mapping.map((m, i): WriteInstruction => ({ ordinal: writes.length + i, symbol: `MAP_${i}_RESOLVED`, target_ref: m.row_ref, operation: "UPDATE", purpose: "TRANSACTIONAL_RECORD", fields: { Status: "RESOLVED" }, property_types: { Status: "select" } }));
  const canaryRetire: WriteInstruction = {
    ordinal: writes.length + finalization.length,
    symbol: "INSTALL_VERIFICATION_RESOLVED",
    target_ref: "$created:INSTALL_VERIFICATION",
    operation: "UPDATE",
    purpose: "STATE_LAST",
    fields: { Status: "RESOLVED" },
    property_types: { Status: "select" },
  };
  const gov = runtime.versions;
  const manifest = (await deps.notion.retrievePage(runtime.manifest_ref)) as Page;
  const created = await createPlan(deps.store, deps.config, {
    plan_id: planId, principal_id: binding.principal_id, binding,
    plan_kind: "INSTALL_MAPPING",
    install_context_fingerprint: installContextFingerprint(runtime),
    governing: { spec: gov.governing_spec === "UNKNOWN" ? "UNKNOWN" : gov.governing_spec.value, schema: gov.governing_schema === "UNKNOWN" ? "UNKNOWN" : gov.governing_schema.value, control: gov.governing_control === "UNKNOWN" ? "UNKNOWN" : gov.governing_control.value },
    run_mode: "OPEN_NEW", execution_attempt_id: opaqueId(), baseline_runtime_revision: manifest.last_edited_time ?? "UNKNOWN",
    operations: ops, stage1_writes: writes, finalization_writes: finalization, state_last_write: canaryRetire,
  }, now);
  if (created.kind === "BUSY") return hold("HOLD_RUNTIME_BUSY", ["another install plan holds this runtime generation"], "finish or let the active install plan expire");
  return { kind: "PREPARED", plan: created.plan, replayed: created.kind === "EXISTING", phase: "CARTOGRAPHIE" };
}

async function queryCanary(deps: HarnessDeps, runtime: ResolvedRuntime, plan: Plan): Promise<Page | undefined> {
  const registry = await resolveInstallRegistry(deps.notion, runtime);
  if (!registry) return undefined;
  const key = canaryKey(proofPlanId(plan));
  const q = (await deps.notion.queryDataSource(registry, { property: "Key", title: { equals: key } })) as { readonly results: readonly Page[] };
  const rows = q.results.filter((p) => !p.archived && !p.in_trash && propText(p, "Key") === key);
  return rows.length === 1 ? rows[0] : undefined;
}

/** The live rows carrying this plan lineage's verification Key (the server installer confines its canary writes to them). */
export async function queryCanaryRows(deps: HarnessDeps, runtime: ResolvedRuntime, plan: Plan): Promise<Page[]> {
  const registry = await resolveInstallRegistry(deps.notion, runtime);
  if (!registry) return [];
  const key = canaryKey(proofPlanId(plan));
  const q = (await deps.notion.queryDataSource(registry, { property: "Key", title: { equals: key } })) as { readonly results: readonly Page[] };
  return q.results.filter((p) => !p.archived && !p.in_trash && propText(p, "Key") === key);
}

async function mappingObserved(deps: HarnessDeps, runtime: ResolvedRuntime, plan: Plan, status: "HOLD" | "RESOLVED"): Promise<string[]> {
  const inspection = await inspectInstallBootstrap(deps.notion, runtime);
  const v = [...inspection.violations];
  for (const op of plan.operations) {
    const map = inspection.mapping.find((m) => m.key === op.natural_key);
    const candidate = inspection.candidates.find((c) => c.registry_key === op.natural_key);
    if (!map || !candidate) { v.push(`${op.natural_key ?? "UNKNOWN"}: contract mapping disappeared`); continue; }
    if (!candidate.observed_points_to_candidate) v.push(`${map.key}: Registry does not point to its unique contract-derived clone resource`);
    if (candidate.observed_status !== status) v.push(`${map.key}: status is ${candidate.observed_status ?? "UNKNOWN"}, expected ${status}`);
    if (candidate.observed_required !== String(map.required)) v.push(`${map.key}: Required is ${candidate.observed_required ?? "UNKNOWN"}, expected ${map.required}`);
    if (candidate.observed_resource_type !== map.object_type) v.push(`${map.key}: Resource Type is ${candidate.observed_resource_type ?? "UNKNOWN"}, expected ${map.object_type}`);
    if (candidate.observed_scope !== map.scope) v.push(`${map.key}: Scope is ${candidate.observed_scope ?? "UNKNOWN"}, expected ${map.scope}`);
    if (!candidate.observed_notes_matches_contract) v.push(`${map.key}: Notes differ from the contract-derived value`);
  }
  return v;
}

export type InstallContinuation =
  | { readonly kind: "NONE" }
  | { readonly kind: "ACTION"; readonly plan: Plan; readonly write: WriteInstruction; readonly phase: "STAGE1" | "FINALIZATION" | "STATE_LAST"; readonly progress_label: string }
  | { readonly kind: "VERIFY"; readonly plan: Plan; readonly phase: "TARGET" | "FINAL"; readonly progress_label: string }
  | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly safe_action: string };

const observedEquals = (field: string, seen: string | undefined, expected: unknown): boolean => {
  if (expected === null) return seen === undefined || seen === "";
  if (field === "Resource URL" || field === "Root URL" || field === "Sales Contract URL") return normalizeId(seen) === normalizeId(String(expected));
  if (typeof expected === "boolean") return seen === String(expected);
  return (seen ?? "") === String(expected);
};

type RecoverInstallOutcome =
  | { readonly kind: "PLAN"; readonly plan: Plan }
  | { readonly kind: "NONE" }
  | { readonly kind: "HOLD"; readonly evidence: readonly string[] };

async function targetWindowIsRecoverable(deps: HarnessDeps, plan: Plan, now: Date): Promise<boolean> {
  if (plan.plan_state !== "TARGET_VERIFIED" && plan.plan_state !== "AWAITING_FINAL_VERIFY") return false;
  if ((await deps.store.receipts.findByPlan(plan.plan_id, "FINAL")).some((r) => r.status === "VALID")) return false;
  const targets = await deps.store.receipts.findByPlan(plan.plan_id, "TARGET");
  for (const target of targets) {
    if (target.status === "VALID" && target.expires_at && target.expires_at <= now) await deps.store.receipts.setStatus(target.receipt_id, "EXPIRED");
  }
  const refreshed = await deps.store.receipts.findByPlan(plan.plan_id, "TARGET");
  // A CONSUMED target is the historical crash footprint handled by the atomic FINAL convergence path.
  return !refreshed.some((r) => r.status === "CONSUMED" || (r.status === "VALID" && (!r.expires_at || r.expires_at > now)));
}

async function cloneRecoverableInstallPlan(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, source: Plan, now: Date): Promise<RecoverInstallOutcome> {
  const planId = opaqueId();
  const operations = source.operations.map((op) => ({ ...op, operation_id: hash(`${planId}:${op.ordinal}:${op.natural_key ?? op.logical_resource_key}`).slice(0, 24) }));
  const gov = runtime.versions;
  const created = await createPlan(deps.store, deps.config, {
    plan_id: planId,
    plan_kind: source.plan_kind,
    principal_id: binding.principal_id,
    binding,
    governing: { spec: versionValue(gov.governing_spec), schema: versionValue(gov.governing_schema), control: versionValue(gov.governing_control) },
    run_mode: "RECOVER_EXISTING",
    execution_attempt_id: opaqueId(),
    baseline_runtime_revision: String(runtime.observations["manifest_last_edited_time"] ?? source.baseline_runtime_revision),
    operations,
    // These instructions retain the original lineage-bound verification Key. The continuation engine observes
    // every target before returning one action, so an already-created row is never emitted as CREATE again.
    stage1_writes: source.stage1_writes,
    finalization_writes: source.finalization_writes,
    state_last_write: source.state_last_write,
    recovers_plan_id: proofPlanId(source),
    ...(source.install_mapping_plan_id ? { install_mapping_plan_id: source.install_mapping_plan_id } : {}),
    ...(source.install_mapping_final_receipt_id ? { install_mapping_final_receipt_id: source.install_mapping_final_receipt_id } : {}),
    install_context_fingerprint: installContextFingerprint(runtime),
  }, now);
  if (created.kind === "BUSY") return { kind: "HOLD", evidence: ["another recovery won the runtime mutation lease; resume again from durable state"] };
  if (created.kind === "CREATED") {
    await deps.store.events.append({
      event_type: "INSTALL_PLAN_RECOVERED", result: "AWAITING_STAGE1_WRITES",
      principal_id: binding.principal_id, binding_id: binding.binding_id, plan_id: created.plan.plan_id,
      runtime_id: binding.runtime_id, detail: { recovers_plan_id: proofPlanId(source), previous_plan_id: source.plan_id }, created_at: now,
    });
  }
  return { kind: "PLAN", plan: created.plan };
}

/**
 * Selects or reconstructs the one INSTALL plan owned by this assignment. Expiry never asks the seller to replay a
 * technical command: the next cold os_resume retires the stale backend window, opens one recovery plan under the
 * same durable verification lineage, then derives the next missing native action from live Notion state.
 */
async function recoverInstallPlan(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, now: Date): Promise<RecoverInstallOutcome> {
  const runtimePlans = (await deps.store.plans.listByRuntime(binding.project, binding.lane, binding.runtime_generation))
    .filter((p) => p.principal_id === binding.principal_id && p.runtime_id === binding.runtime_id && (isInstallMappingPlan(p) || isInstallPromotionPlan(p)));
  const finalizedMappingLineages = new Set<string>();
  for (const plan of runtimePlans) {
    if (!isInstallMappingPlan(plan) || plan.plan_state !== "FINAL_VERIFIED" || !checkInstallContext(plan, runtime).ok) continue;
    if ((await deps.store.receipts.findByPlan(plan.plan_id, "FINAL")).some((receipt) => receipt.status === "VALID")) {
      finalizedMappingLineages.add(proofPlanId(plan));
    }
  }

  const allActive = await deps.store.plans.findActive(binding.project, binding.lane, binding.runtime_generation);
  const owned = allActive.filter((p) => p.principal_id === binding.principal_id && (isInstallMappingPlan(p) || isInstallPromotionPlan(p)));
  for (const plan of owned) {
    // A completed recovery descendant closes its entire mapping lineage. Older EXPIRED/SUPERSEDED ancestors —
    // or a racing recovery opened immediately after FINAL — must never resurrect the mapping and hide promotion.
    if (isInstallMappingPlan(plan) && finalizedMappingLineages.has(proofPlanId(plan))) {
      await transition(deps.store, plan.plan_id, "SUPERSEDED", now, {
        recovery_possible: false,
        reason: "mapping lineage already has a valid FINAL proof",
      });
      continue;
    }
    if (plan.expires_at <= now) {
      await expireIfDue(deps.store, plan, now);
      continue;
    }
    const context = checkInstallContext(plan, runtime);
    const targetExpired = context.ok ? await targetWindowIsRecoverable(deps, plan, now) : false;
    if (!context.ok || targetExpired) {
      await transition(deps.store, plan.plan_id, "SUPERSEDED", now, {
        recovery_possible: true,
        reason: !context.ok ? "install authority context changed" : "install TARGET window expired",
      });
    }
  }

  const active = (await deps.store.plans.findActive(binding.project, binding.lane, binding.runtime_generation))
    .filter((p) => p.principal_id === binding.principal_id && p.runtime_id === binding.runtime_id && (isInstallMappingPlan(p) || isInstallPromotionPlan(p)) && checkInstallContext(p, runtime).ok)
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  if (active[0]) return { kind: "PLAN", plan: active[0] };

  // Re-read after expiry/supersede transitions above; the initial snapshot intentionally cannot be reused here.
  const terminal = (await deps.store.plans.listByRuntime(binding.project, binding.lane, binding.runtime_generation))
    .filter((p) => p.principal_id === binding.principal_id && p.runtime_id === binding.runtime_id
      && (p.plan_state === "EXPIRED" || p.plan_state === "SUPERSEDED")
      && (!isInstallMappingPlan(p) || !finalizedMappingLineages.has(proofPlanId(p)))
      && (isInstallMappingPlan(p) || isInstallPromotionPlan(p)) && checkInstallContext(p, runtime).ok)
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  for (const source of terminal) {
    if ((await deps.store.receipts.findByPlan(source.plan_id, "FINAL")).some((r) => r.status === "VALID")) continue;
    return cloneRecoverableInstallPlan(deps, binding, runtime, source, now);
  }
  return { kind: "NONE" };
}

/**
 * Fresh reconstruction for a new chat/process. It never trusts the previous response boundary and returns at most
 * ONE missing native action. A CREATE is returned only when the plan-bound verification row is proven absent; once
 * that row exists, resume can only advance by update/readback and can never blindly create it again.
 */
export async function resumeInstallContinuation(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, now: Date): Promise<InstallContinuation> {
  const recovered = await recoverInstallPlan(deps, binding, runtime, now);
  if (recovered.kind === "NONE") return { kind: "NONE" };
  if (recovered.kind === "HOLD") return { kind: "HOLD", code: "HOLD_RUNTIME_BUSY", evidence: recovered.evidence, safe_action: "reprendre normalement ; l'état durable sera relu" };
  const plan = recovered.plan;
  const context = checkInstallContext(plan, runtime);
  if (!context.ok) return { kind: "HOLD", code: context.code, evidence: context.evidence, safe_action: "reprendre avec l'affectation et les versions actuellement publiées" };

  if (isInstallPromotionPlan(plan)) {
    if (plan.plan_state === "AWAITING_STAGE1_WRITES") return { kind: "VERIFY", plan, phase: "TARGET", progress_label: "Je vérifie une dernière fois la structure avant d'activer cet espace." };
    if (plan.plan_state === "TARGET_VERIFIED" || plan.plan_state === "AWAITING_FINAL_VERIFY") {
      for (const write of plan.finalization_writes) {
        const row = (await deps.notion.retrievePage(write.target_ref)) as Page;
        if (row.archived || row.in_trash || !Object.entries(write.fields).every(([field, expected]) => observedEquals(field, propText(row, field), expected))) {
          return { kind: "ACTION", plan, write, phase: "FINALIZATION", progress_label: "Je prépare l'état initial sûr de votre espace." };
        }
      }
      const manifest = (await deps.notion.retrievePage(runtime.manifest_ref)) as Page;
      const op = plan.operations.find((candidate) => candidate.logical_resource_key === INSTALL_MANIFEST_RESOURCE);
      if (!op) return { kind: "HOLD", code: "HOLD_INSTALL_REQUIRED", evidence: ["the activation plan has no Manifest operation"], safe_action: "reprendre l'installation depuis l'état actuel" };
      if (operationMismatch(manifest, op).length > 0) return { kind: "ACTION", plan, write: plan.state_last_write, phase: "STATE_LAST", progress_label: "Je finalise l'identité de votre espace." };
      return { kind: "VERIFY", plan, phase: "FINAL", progress_label: "Je vérifie la finalisation de votre espace." };
    }
    return { kind: "HOLD", code: "HOLD_PLAN_REPLAY_INVALID", evidence: [`activation plan is ${plan.plan_state}`], safe_action: "reprendre l'installation depuis l'état actuel" };
  }

  const mappingWrites = plan.stage1_writes.filter((w) => w.symbol !== "INSTALL_VERIFICATION");
  // Only matched candidates can save a GET. A missing/stale candidate still uses the original fresh GET
  // before deciding to write; this scan is local to this observation, not a memoized proof or canary query.
  const scannedRows = await queryInstallRegistryRows(deps.notion, runtime);
  const alreadyMatches = (write: WriteInstruction) => scannedRows.some((row) => normalizeId(row.id) === normalizeId(write.target_ref)
    && Object.entries(write.fields).every(([field, expected]) => observedEquals(field, propText(row, field), expected)));
  const verificationCreate = plan.stage1_writes.find((w) => w.symbol === "INSTALL_VERIFICATION");
  const rows = await queryCanaryRows(deps, runtime, plan);
  if (rows.length > 1) return { kind: "HOLD", code: "HOLD_DUPLICATE", evidence: ["more than one plan-bound installation verification row exists"], safe_action: "faire retirer le doublon avant de continuer" };
  const verification = rows[0];
  const status = verification ? propText(verification, "Status") : undefined;
  if (verification) {
    const staticVerification = canaryStaticViolations(verification, proofPlanId(plan), runtime);
    if (staticVerification.length > 0) return { kind: "HOLD", code: "HOLD_TARGET_WRONG_VALUE", evidence: staticVerification, safe_action: "reprendre la vérification depuis l'état actuel" };
  }

  if (plan.plan_state === "AWAITING_STAGE1_WRITES") {
    const recovering = plan.recovers_plan_id !== undefined;
    // A recovered plan may observe a later durable verification boundary. Re-prove the surrounding mapping and
    // reconstruct backend receipts/state; never roll the row backwards and never replay its CREATE.
    if (recovering && verification && (status === "EXPECTED" || status === "RESOLVED")) {
      const expectedStatus = status === "EXPECTED" ? "HOLD" : undefined;
      const observed = await inspectInstallBootstrap(deps.notion, runtime);
      const bad = [...observed.violations];
      for (const op of plan.operations) {
        const mapping = observed.mapping.find((m) => m.key === op.natural_key);
        const candidate = observed.candidates.find((c) => c.registry_key === op.natural_key);
        if (!mapping) { bad.push(`${op.natural_key ?? "UNKNOWN"}: contract mapping disappeared`); continue; }
        if (!candidate?.observed_points_to_candidate) bad.push(`${op.natural_key ?? "UNKNOWN"}: Registry no longer points to its contract-derived resource`);
        if (expectedStatus && candidate?.observed_status !== expectedStatus) bad.push(`${op.natural_key ?? "UNKNOWN"}: status is ${candidate?.observed_status ?? "UNKNOWN"}, expected ${expectedStatus}`);
        if (!expectedStatus && candidate?.observed_status !== "HOLD" && candidate?.observed_status !== "RESOLVED") bad.push(`${op.natural_key ?? "UNKNOWN"}: status is ${candidate?.observed_status ?? "UNKNOWN"}, expected HOLD or RESOLVED`);
        if (candidate?.observed_required !== String(mapping.required)) bad.push(`${mapping.key}: Required differs from the contract-derived value`);
        if (candidate?.observed_resource_type !== mapping.object_type) bad.push(`${mapping.key}: Resource Type differs from the contract-derived value`);
        if (candidate?.observed_scope !== mapping.scope) bad.push(`${mapping.key}: Scope differs from the contract-derived value`);
        if (!candidate?.observed_notes_matches_contract) bad.push(`${mapping.key}: Notes differ from the contract-derived value`);
      }
      if (bad.length > 0) return { kind: "HOLD", code: "HOLD_TARGET_WRONG_VALUE", evidence: bad, safe_action: "reprendre depuis l'état structurel observé" };
      await issueTargetReceipt(deps.store, deps.config, plan, { install_phase: status === "EXPECTED" ? "RECOVERED_CANARY_UPDATED" : "RECOVERED_CANARY_RESOLVED", canary_ref: normalizeId(verification.id) }, now);
      if (status === "EXPECTED") return { kind: "VERIFY", plan: (await deps.store.plans.get(plan.plan_id)) ?? plan, phase: "TARGET", progress_label: "Je relis l'étape de vérification récupérée." };
      await transition(deps.store, plan.plan_id, "AWAITING_FINAL_VERIFY", now, { install_canary: "RECOVERED_RESOLVED" });
      const advanced = (await deps.store.plans.get(plan.plan_id)) ?? plan;
      for (const write of advanced.finalization_writes) {
        const row = (await deps.notion.retrievePage(write.target_ref)) as Page;
        if (!Object.entries(write.fields).every(([field, expected]) => observedEquals(field, propText(row, field), expected))) return { kind: "ACTION", plan: advanced, write, phase: "FINALIZATION", progress_label: "Je valide le prochain lien vérifié de votre espace." };
      }
      return { kind: "VERIFY", plan: advanced, phase: "FINAL", progress_label: "Je vérifie la cartographie complète récupérée de votre espace." };
    }
    for (const write of mappingWrites) {
      if (alreadyMatches(write)) continue;
      const row = (await deps.notion.retrievePage(write.target_ref)) as Page;
      if (!Object.entries(write.fields).every(([field, expected]) => observedEquals(field, propText(row, field), expected))) return { kind: "ACTION", plan, write, phase: "STAGE1", progress_label: "Je relie le prochain élément de votre espace." };
    }
    if (!verification) {
      if (!verificationCreate) return { kind: "HOLD", code: "HOLD_INSTALL_REQUIRED", evidence: ["the installation plan has no verification create action"], safe_action: "reprendre l'installation" };
      return { kind: "ACTION", plan, write: verificationCreate, phase: "STAGE1", progress_label: "Je crée la vérification bornée de cet espace." };
    }
    if (status !== "MISSING") return { kind: "HOLD", code: "HOLD_TARGET_WRONG_VALUE", evidence: [`installation verification status is ${status ?? "UNKNOWN"}, expected MISSING at this boundary`], safe_action: "reprendre depuis l'état vérifié" };
    return { kind: "VERIFY", plan, phase: "TARGET", progress_label: "Je relis la première étape de vérification." };
  }

  if (!verification) return { kind: "HOLD", code: "HOLD_TARGET_NOT_WRITTEN", evidence: ["the plan-bound installation verification row disappeared; CREATE will not be replayed"], safe_action: "faire contrôler la ligne de vérification manquante" };
  if (plan.plan_state === "TARGET_VERIFIED") {
    if (status === "MISSING") return { kind: "ACTION", plan, write: { ordinal: 0, symbol: "INSTALL_VERIFICATION_UPDATED", target_ref: normalizeId(verification.id) as string, operation: "UPDATE", purpose: "TRANSACTIONAL_RECORD", fields: { Status: "EXPECTED" }, property_types: { Status: "select" } }, phase: "FINALIZATION", progress_label: "Je poursuis la vérification de l'espace." };
    if (status !== "EXPECTED") return { kind: "HOLD", code: "HOLD_TARGET_WRONG_VALUE", evidence: [`installation verification status is ${status ?? "UNKNOWN"}, expected EXPECTED at this boundary`], safe_action: "reprendre depuis l'état vérifié" };
    return { kind: "VERIFY", plan, phase: "TARGET", progress_label: "Je relis la deuxième étape de vérification." };
  }

  if (plan.plan_state === "AWAITING_FINAL_VERIFY") {
    if (status === "EXPECTED") return { kind: "ACTION", plan, write: { ...plan.state_last_write, target_ref: normalizeId(verification.id) as string }, phase: "STATE_LAST", progress_label: "Je termine la vérification bornée de l'espace." };
    if (status !== "RESOLVED") return { kind: "HOLD", code: "HOLD_TARGET_WRONG_VALUE", evidence: [`installation verification status is ${status ?? "UNKNOWN"}, expected RESOLVED at this boundary`], safe_action: "reprendre depuis l'état vérifié" };
    for (const write of plan.finalization_writes) {
      if (alreadyMatches(write)) continue;
      const row = (await deps.notion.retrievePage(write.target_ref)) as Page;
      if (!Object.entries(write.fields).every(([field, expected]) => observedEquals(field, propText(row, field), expected))) return { kind: "ACTION", plan, write, phase: "FINALIZATION", progress_label: "Je valide le prochain lien vérifié de votre espace." };
    }
    return { kind: "VERIFY", plan, phase: "FINAL", progress_label: "Je vérifie la cartographie complète de votre espace." };
  }
  return { kind: "HOLD", code: "HOLD_PLAN_REPLAY_INVALID", evidence: [`installation plan is ${plan.plan_state}`], safe_action: "reprendre l'installation depuis l'état actuel" };
}

export type InstallTargetOutcome =
  | { readonly kind: "STEP"; readonly step: "CANARY_UPDATE" | "CANARY_RESOLVE"; readonly write: WriteInstruction; readonly canary_ref: string }
  | { readonly kind: "TARGET"; readonly receipt_id: string; readonly canary_ref?: string }
  | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly safe_action: string };

export async function verifyInstallTarget(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, plan: Plan, now: Date): Promise<InstallTargetOutcome> {
  const context = checkInstallContext(plan, runtime);
  if (!context.ok) return { kind: "HOLD", code: context.code, evidence: context.evidence, safe_action: "reprendre avec l'affectation et les versions actuellement publiées" };
  await expireIfDue(deps.store, plan, now);
  const fresh = (await deps.store.plans.get(plan.plan_id)) ?? plan;
  if (["EXPIRED", "ABORTED", "SUPERSEDED", "HOLD"].includes(fresh.plan_state)) return { kind: "HOLD", code: "HOLD_PLAN_EXPIRED", evidence: [`plan is ${fresh.plan_state}`], safe_action: "resume the bounded installation; never replay blindly" };
  if (isInstallPromotionPlan(fresh)) {
    if (fresh.plan_state !== "AWAITING_STAGE1_WRITES" && fresh.plan_state !== "TARGET_VERIFIED") return { kind: "HOLD", code: "HOLD_PLAN_REPLAY_INVALID", evidence: [`promotion plan is ${fresh.plan_state}`], safe_action: "resume installation" };
    const proof = await revalidateBoundMappingProof(deps, runtime, fresh);
    if (!proof.ok) return { kind: "HOLD", code: "HOLD_INSTALL_REQUIRED", evidence: proof.evidence, safe_action: "repair the structural mapping and reverify it before promotion" };
    const receipt = await issueTargetReceipt(deps.store, deps.config, fresh, { install_phase: "PROMOTION_READY", mapping_plan_id: proof.mapping_plan.plan_id, mapping_final_receipt_id: fresh.install_mapping_final_receipt_id, canary_ref: proof.canary_ref, mapping_proof_fingerprint: proof.proof_fingerprint }, now);
    return { kind: "TARGET", receipt_id: receipt.receipt_id, canary_ref: proof.canary_ref };
  }
  if (!isInstallMappingPlan(fresh)) return { kind: "HOLD", code: "HOLD_PLAN_REPLAY_INVALID", evidence: ["plan is not an install mapping/promotion plan"], safe_action: "prepare from os_resume's exact installer intent" };
  const mapping = await mappingObserved(deps, runtime, fresh, "HOLD");
  if (mapping.length > 0) return { kind: "HOLD", code: "HOLD_TARGET_WRONG_VALUE", evidence: mapping, safe_action: "execute the exact pending mapping writes, then verify again" };
  if (fresh.plan_state === "AWAITING_FINAL_VERIFY") {
    const issued = (await deps.store.receipts.findByPlan(fresh.plan_id, "TARGET")).find((r) => r.status === "VALID");
    // P0-4: the canary receipt is validated through checkTargetReceipt, so its TTL, ownership and consumption
    // state are enforced here exactly as they are on the business path — never by a bare status === "VALID".
    const checked = issued ? await checkTargetReceipt(deps.store, fresh, issued.receipt_id, now) : undefined;
    const receipt = checked?.ok ? checked.receipt : undefined;
    const savedRef = normalizeId(receipt?.observations["canary_ref"] as string | undefined);
    if (!receipt || !savedRef) return { kind: "HOLD", code: "HOLD_TARGET_RECEIPT_INVALID", evidence: [`the installation verification receipt is ${checked && !checked.ok ? checked.reason : "absent"}`], safe_action: "restart the bounded structural verification" };
    let retired: Page;
    try { retired = (await deps.notion.retrievePage(savedRef)) as Page; }
    catch (err) { return { kind: "HOLD", code: "HOLD_TARGET_NOT_WRITTEN", evidence: [`the terminal verification row cannot be fetched: ${(err as Error).message}`], safe_action: "restore read access to the plan-bound verification row" }; }
    if (retired.archived || retired.in_trash || propText(retired, "Key") !== canaryKey(proofPlanId(fresh)) || propText(retired, "Status") !== "RESOLVED") {
      return { kind: "HOLD", code: "HOLD_TARGET_WRONG_VALUE", evidence: ["the plan-bound verification row is not RESOLVED after its terminal update and readback"], safe_action: "execute the exact RESOLVED update, then verify again" };
    }
    const staticCanary = canaryStaticViolations(retired, proofPlanId(fresh), runtime);
    if (staticCanary.length > 0) return { kind: "HOLD", code: "HOLD_TARGET_WRONG_VALUE", evidence: staticCanary, safe_action: "reprendre la vérification depuis l'état actuel" };
    return { kind: "TARGET", receipt_id: receipt.receipt_id, canary_ref: savedRef };
  }
  const canary = await queryCanary(deps, runtime, fresh);
  if (!canary) return { kind: "HOLD", code: "HOLD_TARGET_NOT_WRITTEN", evidence: ["the unique structural verification row is absent or duplicated"], safe_action: "create the provided verification row exactly once" };
  const staticCanary = canaryStaticViolations(canary, proofPlanId(fresh), runtime);
  if (staticCanary.length > 0) return { kind: "HOLD", code: "HOLD_TARGET_WRONG_VALUE", evidence: staticCanary, safe_action: "reprendre la vérification depuis l'état actuel" };
  const ref = normalizeId(canary.id) as string;
  const status = propText(canary, "Status");
  if (fresh.plan_state === "AWAITING_STAGE1_WRITES") {
    if (status !== "MISSING") return { kind: "HOLD", code: "HOLD_TARGET_WRONG_VALUE", evidence: [`verification status is ${status ?? "UNKNOWN"}; expected MISSING after creation and readback`], safe_action: "restore the verification row to its provided creation state" };
    await issueTargetReceipt(deps.store, deps.config, fresh, { install_phase: "CANARY_CREATED_AND_FETCHED", canary_ref: ref }, now);
    return { kind: "STEP", step: "CANARY_UPDATE", canary_ref: ref, write: { ordinal: 0, symbol: "INSTALL_VERIFICATION_UPDATED", target_ref: ref, operation: "UPDATE", purpose: "TRANSACTIONAL_RECORD", fields: { Status: "EXPECTED" }, property_types: { Status: "select" } } };
  }
  if (fresh.plan_state === "TARGET_VERIFIED") {
    if (status !== "EXPECTED") return { kind: "HOLD", code: "HOLD_TARGET_WRONG_VALUE", evidence: [`verification status is ${status ?? "UNKNOWN"}; expected EXPECTED after update and readback`], safe_action: "execute the exact verification update, then verify again" };
    await transition(deps.store, fresh.plan_id, "AWAITING_FINAL_VERIFY", now, { install_canary: "UPDATED_AND_FETCHED" });
    return { kind: "STEP", step: "CANARY_RESOLVE", canary_ref: ref, write: { ...fresh.state_last_write, target_ref: ref } };
  }
  return { kind: "HOLD", code: "HOLD_PLAN_REPLAY_INVALID", evidence: [`mapping plan is ${fresh.plan_state}`], safe_action: "resume installation" };
}

export type InstallFinalOutcome = { readonly kind: "VERIFIED"; readonly receipt_id: string } | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly safe_action: string };

export async function verifyInstallMappingFinal(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, plan: Plan, now: Date): Promise<InstallFinalOutcome> {
  if (!isInstallMappingPlan(plan)) return { kind: "HOLD", code: "HOLD_PLAN_REPLAY_INVALID", evidence: ["not a Registry mapping plan"], safe_action: "resume installation" };
  const context = checkInstallContext(plan, runtime);
  if (!context.ok) return { kind: "HOLD", code: context.code, evidence: context.evidence, safe_action: "reprendre avec l'affectation et les versions actuellement publiées" };
  const lineage = await finalizationLineage(deps, plan, now);
  if (!lineage.ok) return { kind: "HOLD", code: lineage.reason === "absent" ? "HOLD_FINAL_WITHOUT_TARGET_VERIFICATION" : "HOLD_TARGET_RECEIPT_INVALID", evidence: [`mapping target receipt is ${lineage.reason}`], safe_action: "resume the bounded structural verification from its current state" };
  const target = lineage.target;
  const mapping = await mappingObserved(deps, runtime, plan, "RESOLVED");
  if (mapping.length > 0) return { kind: "HOLD", code: "HOLD_TARGET_CHANGED_AFTER_TARGET_VERIFY", evidence: mapping, safe_action: "execute the rendered mapping finalization, then verify again" };
  const canaryRef = normalizeId(target.observations["canary_ref"] as string | undefined);
  if (!canaryRef) return { kind: "HOLD", code: "HOLD_TARGET_RECEIPT_INVALID", evidence: ["the target proof has no structural verification-row reference"], safe_action: "restart the bounded structural verification" };
  let canary: Page;
  try { canary = (await deps.notion.retrievePage(canaryRef)) as Page; }
  catch (err) { return { kind: "HOLD", code: "HOLD_TARGET_CHANGED_AFTER_TARGET_VERIFY", evidence: [`the terminal verification row is unreadable: ${(err as Error).message}`], safe_action: "restore read access to the plan-bound verification row" }; }
  if (canary.archived || canary.in_trash || propText(canary, "Key") !== canaryKey(proofPlanId(plan)) || propText(canary, "Status") !== "RESOLVED") {
    return { kind: "HOLD", code: "HOLD_TARGET_CHANGED_AFTER_TARGET_VERIFY", evidence: ["the plan-bound structural verification row is not RESOLVED"], safe_action: "apply the exact RESOLVED update, then verify again" };
  }
  const staticCanary = canaryStaticViolations(canary, proofPlanId(plan), runtime);
  if (staticCanary.length > 0) return { kind: "HOLD", code: "HOLD_TARGET_CHANGED_AFTER_TARGET_VERIFY", evidence: staticCanary, safe_action: "reprendre la vérification depuis l'état actuel" };
  const registryDs = (await inspectInstallBootstrap(deps.notion, runtime)).registry_data_source_ref;
  if (!registryDs || normalizeId(canary.parent?.data_source_id) !== registryDs) {
    return { kind: "HOLD", code: "HOLD_TARGET_CHANGED_AFTER_TARGET_VERIFY", evidence: ["the plan-bound verification row is outside the assigned workspace Registry"], safe_action: "restart the bounded structural verification against the assigned workspace" };
  }
  const receipt = await issueFinalReceipt(deps.store, plan, target, { install_phase: "MAPPING_VERIFIED", canary_ref: canaryRef }, now);
  return { kind: "VERIFIED", receipt_id: receipt.receipt_id };
}

function operationMismatch(page: Page, op: PlanOperation): string[] {
  return op.compared_fields.filter((field) => !observedEquals(field, propText(page, field), op.expected_values[field]));
}

export async function verifyInstallPromotionFinal(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, plan: Plan, now: Date): Promise<InstallFinalOutcome> {
  if (!isInstallPromotionPlan(plan)) return { kind: "HOLD", code: "HOLD_PLAN_REPLAY_INVALID", evidence: ["not a workspace activation plan"], safe_action: "resume installation" };
  const context = checkInstallContext(plan, runtime);
  if (!context.ok) return { kind: "HOLD", code: context.code, evidence: context.evidence, safe_action: "reprendre avec l'affectation et les versions actuellement publiées" };
  const lineage = await finalizationLineage(deps, plan, now);
  if (!lineage.ok) return { kind: "HOLD", code: lineage.reason === "absent" ? "HOLD_FINAL_WITHOUT_TARGET_VERIFICATION" : "HOLD_TARGET_RECEIPT_INVALID", evidence: [`promotion target receipt is ${lineage.reason}`], safe_action: "resume the bounded activation from its current state" };
  const target = lineage.target;

  // P0-2. The LAST thing before backend activation is a complete, fresh re-proof of the exact bound mapping:
  // the mapping plan row, its FINAL receipt row, the contract-derived mapping recomputed from the live clone and
  // the terminal plan-bound canary. Anything tampered with after this promotion's TARGET verification HOLDs here
  // and no authority is granted.
  const proof = await revalidateBoundMappingProof(deps, runtime, plan);
  if (!proof.ok) return { kind: "HOLD", code: "HOLD_TARGET_CHANGED_AFTER_TARGET_VERIFY", evidence: [...proof.evidence, "no backend activation was attempted"], safe_action: "repair and reverify the structural mapping, then re-prepare the promotion" };
  if (target.observations["mapping_proof_fingerprint"] !== proof.proof_fingerprint) return { kind: "HOLD", code: "HOLD_TARGET_CHANGED_AFTER_TARGET_VERIFY", evidence: ["the structural inspection fingerprint changed after the promotion target check", "no backend activation was attempted"], safe_action: "reverify the installation from its current state" };

  const manifestOp = plan.operations.find((candidate) => candidate.logical_resource_key === INSTALL_MANIFEST_RESOURCE);
  const stateOp = plan.operations.find((candidate) => candidate.logical_resource_key === INSTALL_OS_STATE_RESOURCE);
  if (!manifestOp || !stateOp?.physical_target_ref) return { kind: "HOLD", code: "HOLD_INSTALL_REQUIRED", evidence: ["promotion plan lacks its Manifest or OS State normalization operation"], safe_action: "re-prepare the promotion from the current installation state" };
  const state = (await deps.notion.retrievePage(stateOp.physical_target_ref)) as Page;
  if (state.archived || state.in_trash) return { kind: "HOLD", code: "HOLD_STATE_LAST_NOT_PROVEN", evidence: ["OS State CURRENT is archived or trashed"], safe_action: "restore the canonical OS State CURRENT row, then resume" };
  const stateBad = operationMismatch(state, stateOp);
  if (stateBad.length > 0) return { kind: "HOLD", code: "HOLD_STATE_LAST_NOT_PROVEN", evidence: stateBad.map((f) => `OS State field ${f} does not match the server-derived setup baseline`), safe_action: "execute the exact OS State normalization action before Manifest state-last" };
  const manifest = (await deps.notion.retrievePage(runtime.manifest_ref)) as Page;
  const bad = operationMismatch(manifest, manifestOp);
  if (bad.length > 0) return { kind: "HOLD", code: "HOLD_STATE_LAST_NOT_PROVEN", evidence: bad.map((f) => `Manifest field ${f} does not match the server-derived promotion`), safe_action: "execute the exact Manifest state-last action, then verify FINAL" };

  // Notion and the backend registry cannot participate in one distributed transaction. Narrow that unavoidable
  // external-write race to the final read/CAS boundary: repeat the complete inspection and Manifest read immediately
  // before the backend compare-and-swap, and fail closed on any changed fingerprint or promotion field.
  const finalProof = await revalidateBoundMappingProof(deps, runtime, plan);
  if (!finalProof.ok || finalProof.proof_fingerprint !== proof.proof_fingerprint) return { kind: "HOLD", code: "HOLD_TARGET_CHANGED_AFTER_TARGET_VERIFY", evidence: [...(!finalProof.ok ? finalProof.evidence : ["the structural inspection changed during final activation checks"]), "no backend activation was attempted"], safe_action: "reverify the installation from its current state" };
  const finalState = (await deps.notion.retrievePage(stateOp.physical_target_ref)) as Page;
  const finalStateBad = operationMismatch(finalState, stateOp);
  const finalManifest = (await deps.notion.retrievePage(runtime.manifest_ref)) as Page;
  const finalManifestBad = operationMismatch(finalManifest, manifestOp);
  if (finalStateBad.length > 0 || finalState.last_edited_time !== state.last_edited_time || finalManifestBad.length > 0 || finalManifest.last_edited_time !== manifest.last_edited_time) return { kind: "HOLD", code: "HOLD_FINAL_RUNTIME_CONFLICT", evidence: [...finalStateBad.map((f) => `OS State field ${f} changed during final activation checks`), ...(finalState.last_edited_time !== state.last_edited_time ? ["OS State revision changed during final activation checks"] : []), ...finalManifestBad.map((f) => `Manifest field ${f} changed during final activation checks`), ...(finalManifest.last_edited_time !== manifest.last_edited_time ? ["Manifest revision changed during final activation checks"] : []), "no backend activation was attempted"], safe_action: "resume from the current OS State and Manifest before activating" };
  const expectedAssignment = assignmentSnapshotFromRuntime(runtime);
  if (!expectedAssignment) return { kind: "HOLD", code: "HOLD_PERMISSION_UNKNOWN", evidence: ["runtime has no complete INSTALL_PENDING assignment snapshot"], safe_action: "re-authenticate and bind the assigned runtime" };
  const repKey = expectedAssignment.rep_identity_key;
  const currentAssignment = await deps.salesRegistry.lookup(repKey);
  if (currentAssignment?.activation_proof_plan_id === plan.plan_id) {
    const receipt = await issueFinalReceipt(deps.store, plan, target, lineage.incumbent_final?.observations ?? { install_phase: "PROMOTION_RECOVERED_AFTER_ACTIVATION", manifest_ref: runtime.manifest_ref, activation_proof_plan_id: plan.plan_id }, now);
    await deps.store.bindings.setStatus(plan.binding_id, "STALE");
    return { kind: "VERIFIED", receipt_id: receipt.receipt_id };
  }
  const activated = await deps.salesRegistry.activateInstallation(expectedAssignment, plan.plan_id);
  if (!activated) return { kind: "HOLD", code: "HOLD_CONFLICT", evidence: ["backend provisioning assignment changed or was already consumed; no authority was granted by this call"], safe_action: "call os_bind again and inspect the fresh backend assignment" };
  const receipt = await issueFinalReceipt(deps.store, plan, target, { install_phase: "PROMOTION_VERIFIED", manifest_ref: runtime.manifest_ref, pointer_generation: activated.pointer_generation, activation_proof_plan_id: plan.plan_id, mapping_plan_id: proof.mapping_plan.plan_id, mapping_final_receipt_id: plan.install_mapping_final_receipt_id, canary_ref: proof.canary_ref }, now);
  await deps.store.bindings.setStatus(plan.binding_id, "STALE");
  await deps.store.events.append({ event_type: "INSTALL_PROMOTION_ADOPTED", result: "FINAL_VERIFIED", principal_id: binding.principal_id, binding_id: binding.binding_id, plan_id: plan.plan_id, runtime_id: binding.runtime_id, detail: { pointer_generation: activated.pointer_generation }, created_at: now });
  return { kind: "VERIFIED", receipt_id: receipt.receipt_id };
}

/**
 * Crash recovery: a new BUSINESS binding closes bookkeeping only when the registry already carries this proof id.
 *
 * This path grants NO authority — the backend compare-and-swap already happened and is what made the runtime a
 * business instance; all that is left is to record the FINAL receipt and stale the spent INSTALL_ONLY binding.
 * It is therefore deliberately not gated on the target receipt's TTL: a crash between the CAS and the receipt
 * write must still reconcile, however long the operator took to come back. It IS gated on the plan having really
 * reached TARGET_VERIFIED (the only state from which activation can have run) and on the Manifest still matching.
 */
export async function finalizePromotionAfterRebind(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, now: Date): Promise<string | undefined> {
  if (binding.binding_mode !== "BUSINESS") return undefined;
  const repKey = runtime.observations["rep_identity_key"];
  if (typeof repKey !== "string") return undefined;
  const entry = await deps.salesRegistry.lookup(repKey);
  const proof = entry?.activation_proof_plan_id;
  if (!proof) return undefined;
  const plan = await deps.store.plans.get(proof);
  if (!plan || !isInstallPromotionPlan(plan) || plan.principal_id !== binding.principal_id) return undefined;
  if (plan.plan_state !== "TARGET_VERIFIED" && plan.plan_state !== "AWAITING_FINAL_VERIFY" && plan.plan_state !== "FINAL_VERIFIED" && plan.plan_state !== "EXPIRED" && plan.plan_state !== "SUPERSEDED") return undefined;
  // The registry's exact activation_proof_plan_id is the durable distributed-commit marker. Once it is KNOWN,
  // expiry can no longer make bookkeeping unrecoverable: no authority is granted here, only the already-committed
  // CAS is reconciled into the local FINAL transaction.
  const lineage = await finalizationLineage(deps, plan, now, true);
  if (!lineage.ok) return undefined;
  const target = lineage.target;
  const manifestOp = plan.operations.find((candidate) => candidate.logical_resource_key === INSTALL_MANIFEST_RESOURCE);
  if (!manifestOp) return undefined;
  const manifest = (await deps.notion.retrievePage(runtime.manifest_ref)) as Page;
  if (operationMismatch(manifest, manifestOp).length > 0) return undefined;
  const stateOp = plan.operations.find((candidate) => candidate.logical_resource_key === INSTALL_OS_STATE_RESOURCE);
  if (stateOp?.physical_target_ref) {
    const state = (await deps.notion.retrievePage(stateOp.physical_target_ref)) as Page;
    if (state.archived || state.in_trash || operationMismatch(state, stateOp).length > 0) return undefined;
  }
  await issueFinalReceipt(deps.store, plan, target, { install_phase: "PROMOTION_RECOVERED_AFTER_ACTIVATION", manifest_ref: runtime.manifest_ref, activation_proof_plan_id: proof }, now, { committed_install_proof_plan_id: proof });
  await deps.store.bindings.setStatus(plan.binding_id, "STALE");
  return plan.plan_id;
}
