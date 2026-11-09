/**
 * os_control_status (PV0-019, PG8): read-only CONTROL reporting under the CURRENT governing control version.
 * The governing version is resolved fresh (SPEC_ROOT Status); candidates are reported and ignored; the matching
 * adapter decides the semantics (independent proof vs operational recomputation); freshness and scope are checked
 * before any result is promoted; unsupported versions HOLD with no fallback. Nothing here writes or fabricates.
 */
import type { BindingRecord } from "../binding/store.ts";
import type { HoldCode } from "../errors/codes.ts";
import type { NotionReadClient } from "../notion/readClient.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import { deriveResumeState, splitHistoricalMutations } from "../resume/derive.ts";
import { readControlPlane } from "../resume/readers.ts";
import type { ControlCheckRow, ControlPlaneSnapshot, Text } from "../resume/snapshot.ts";
import type { AdapterRegistry, ControlAdapter } from "../versions/registry.ts";
import type { ControlSource, ControlSpecAdapter } from "../versions/adapters/control.ts";

export type InvariantResult = "PASS" | "HOLD" | "VIOLATION" | "UNKNOWN" | "NOT_APPLICABLE";
export interface InvariantReport { readonly name: string; readonly result: InvariantResult; readonly evidence: readonly string[] }

export interface ControlStatus {
  readonly governing_control_version: string;
  readonly adapter: { readonly version: string; readonly mode: ControlSpecAdapter["mode"]; readonly note: string };
  readonly candidate_control_versions: readonly string[];
  readonly scope: { readonly required: readonly ControlSource[]; readonly read: readonly ControlSource[]; readonly missing: readonly ControlSource[] };
  readonly invariants: readonly InvariantReport[];
  readonly gate: { readonly gate_key: Text; readonly status: Text; readonly control_confirmation_state: Text; readonly confirmation_required: boolean; readonly confirmed_by: Text; readonly passed_by_run: Text };
  readonly control_check: { readonly status: "FRESH" | "STALE" | "MISSING" | "NOT_REQUIRED" | "SCOPE_INCOMPLETE"; readonly ref: Text; readonly checked_at: Text; readonly result: Text; readonly required_written_at: Text; readonly control_version: Text };
  readonly result: "CONFIRMED" | "OPERATIONAL_PASS" | "HOLD" | "VIOLATION" | "UNKNOWN";
  readonly historical_run_pins: Readonly<Record<string, string>>;
  readonly note: string;
}

export type ControlOutcome = { readonly kind: "OK"; readonly status: ControlStatus; readonly warnings: readonly string[] } | { readonly kind: "HOLD"; readonly code: HoldCode; readonly evidence: readonly string[]; readonly safe_action: string; readonly partial?: Partial<ControlStatus>; readonly warnings?: readonly string[] };

const isoMax = (...ts: (Text | undefined)[]): string | undefined => ts.filter((t): t is string => typeof t === "string" && t !== "UNKNOWN" && !Number.isNaN(Date.parse(t))).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
const later = (a: string | undefined, b: string | undefined): boolean => a !== undefined && b !== undefined && Date.parse(a) > Date.parse(b);

/** Read-only recomputation of the CONTROL-class invariants that are calculable from the control plane. */
export function computeInvariants(snap: ControlPlaneSnapshot, adapter: ControlSpecAdapter, versionsKnown: boolean): InvariantReport[] {
  const derived = deriveResumeState(snap);
  const state = derived.kind === "STATE" ? derived.state : derived.partial;
  const out: InvariantReport[] = [];
  const want = (n: string) => adapter.controlInvariants.includes(n);
  if (want("RUN_RECOVERY")) {
    if (derived.kind === "HOLD") out.push({ name: "RUN_RECOVERY", result: "HOLD", evidence: [`${derived.code}: ${derived.evidence.join("; ")}`] });
    else if (state.recovery_required) out.push({ name: "RUN_RECOVERY", result: "HOLD", evidence: state.recovery_reasons ?? [] });
    else out.push({ name: "RUN_RECOVERY", result: "PASS", evidence: ["no stale or incomplete durable Run is presented as healthy"] });
  }
  if (want("MUTATION_CLEAN")) {
    const { active: activeLedger, historical } = splitHistoricalMutations(snap);
    const orphans = activeLedger.length;
    const healthy = (snap.manifest.health === "HEALTHY" || snap.manifest.health === "UNKNOWN") && snap.manifest.recovery_required !== true && !(typeof (snap.state ?? snap.manifest).persistence_health === "string" && ((snap.state ?? snap.manifest).persistence_health as string).startsWith("HOLD"));
    out.push(orphans === 0 ? { name: "MUTATION_CLEAN", result: "PASS", evidence: [historical.length > 0 ? `no outstanding mutation; ${historical.length} superseded historical row(s) kept for audit` : "no PREPARED/WRITTEN/FAILED mutation outstanding"] } : healthy ? { name: "MUTATION_CLEAN", result: "VIOLATION", evidence: [`${orphans} orphan mutation(s) behind a state presented as healthy: ${activeLedger.map((l) => `${l.label} (${l.status})`).join("; ")}`] } : { name: "MUTATION_CLEAN", result: "HOLD", evidence: [`${orphans} non-VERIFIED mutation(s) with recovery declared`] });
  }
  if (want("GATE_PROOF")) {
    const g = snap.gate && snap.gate !== "NOT_FOUND" ? snap.gate : undefined;
    if (!g) out.push({ name: "GATE_PROOF", result: "UNKNOWN", evidence: ["current gate row not readable"] });
    else if (g.status !== "PASS") out.push({ name: "GATE_PROOF", result: "PASS", evidence: [`gate ${g.key} is ${g.status}; no PASS claim to prove`] });
    else {
      const required = adapter.controlConfirmedGates.includes(typeof g.key === "string" ? g.key : "");
      const linked = g.passed_by_run_ids.length > 0 || (g.passed_by_run_ref !== "UNKNOWN");
      if (required && g.control_confirmation_state !== "CONFIRMED") out.push({ name: "GATE_PROOF", result: "VIOLATION", evidence: [`gate ${g.key} is PASS with confirmation ${g.control_confirmation_state}; this gate requires independent Control confirmation under ${adapter.version} and cannot opt itself out`] });
      else if (!linked) out.push({ name: "GATE_PROOF", result: "HOLD", evidence: [`gate ${g.key} is PASS without a passed_by_run_ref`] });
      else if (required && g.confirmed_by_control_check_ref === "UNKNOWN") out.push({ name: "GATE_PROOF", result: "HOLD", evidence: [`gate ${g.key} is CONFIRMED but stores no confirmed_by_control_check_ref`] });
      else out.push({ name: "GATE_PROOF", result: "PASS", evidence: [`gate ${g.key} PASS links Run ${g.passed_by_run_ids[0] ?? g.passed_by_run_ref}${required ? ` and Control Check ${g.confirmed_by_control_check_ref}` : " (not a control-confirmed gate)"}`] });
    }
  }
  if (want("INHERITED_HISTORY")) {
    const seeded = snap.incomplete_runs.filter((r) => typeof r.origin === "string" && /TEMPLATE_SEED/i.test(r.origin));
    const refSeeded = snap.referenced_run && snap.referenced_run !== "NOT_FOUND" && typeof snap.referenced_run.origin === "string" && /TEMPLATE_SEED/i.test(snap.referenced_run.origin);
    out.push(refSeeded || seeded.length > 0 ? { name: "INHERITED_HISTORY", result: "VIOLATION", evidence: [`template-seeded Run presented as runtime history: ${[...(refSeeded ? [(snap.referenced_run as { label: Text }).label] : []), ...seeded.map((r) => r.label)].join("; ")}`] } : { name: "INHERITED_HISTORY", result: "PASS", evidence: ["no TEMPLATE_SEED Run in operational state"] });
  }
  if (want("ATTEMPT_IDENTITY")) {
    const r = snap.referenced_run && snap.referenced_run !== "NOT_FOUND" ? snap.referenced_run : snap.incomplete_runs[0];
    out.push(!r ? { name: "ATTEMPT_IDENTITY", result: "NOT_APPLICABLE", evidence: ["no current Run"] } : r.attempt_count === "UNKNOWN" ? { name: "ATTEMPT_IDENTITY", result: "UNKNOWN", evidence: [`run ${r.label} carries no attempt count`] } : { name: "ATTEMPT_IDENTITY", result: "PASS", evidence: [`run ${r.label} attempt ${r.attempt_count}`] });
  }
  if (want("VERSION_PIN")) {
    const r = snap.referenced_run && snap.referenced_run !== "NOT_FOUND" ? snap.referenced_run : undefined;
    if (!versionsKnown) out.push({ name: "VERSION_PIN", result: "UNKNOWN", evidence: ["governing versions not fully known"] });
    else if (!r) out.push({ name: "VERSION_PIN", result: "NOT_APPLICABLE", evidence: ["no referenced Run to pin"] });
    else {
      const missing = (["spec", "schema", "control"] as const).filter((k) => r.pins[k] === "UNKNOWN");
      out.push(missing.length > 0 ? { name: "VERSION_PIN", result: "HOLD", evidence: [`run ${r.label} lacks pin(s): ${missing.join(", ")}`] } : { name: "VERSION_PIN", result: "PASS", evidence: [`run ${r.label} pins ${r.pins.spec} / ${r.pins.schema} / ${r.pins.control}`] });
    }
  }
  if (want("CONTROL_REPORT_TAMPER")) {
    const checks = snap.control_checks && snap.control_checks !== "NOT_FOUND" ? snap.control_checks : [];
    // Live mirror vocabulary (META — CONTROL CHECKS): MATCH | TAMPERED | UNVERIFIED; fixtures may use OK/PASS/INTACT.
    const tampered = checks.filter((c) => typeof c.mirror_integrity === "string" && /^(TAMPERED|MISMATCH|FAIL|VIOLATION)$/i.test(c.mirror_integrity));
    const unverified = checks.filter((c) => typeof c.mirror_integrity !== "string" || !/^(MATCH|OK|PASS|INTACT|TAMPERED|MISMATCH|FAIL|VIOLATION)$/i.test(c.mirror_integrity));
    out.push(checks.length === 0 ? { name: "CONTROL_REPORT_TAMPER", result: "UNKNOWN", evidence: ["no Control Check mirror to compare against the canonical artifact"] } : tampered.length > 0 ? { name: "CONTROL_REPORT_TAMPER", result: "VIOLATION", evidence: tampered.map((c) => `mirror ${c.check_id} integrity ${c.mirror_integrity}`) } : unverified.length > 0 ? { name: "CONTROL_REPORT_TAMPER", result: "UNKNOWN", evidence: unverified.map((c) => `mirror ${c.check_id} integrity ${c.mirror_integrity}: not verified against the canonical artifact`) } : { name: "CONTROL_REPORT_TAMPER", result: "PASS", evidence: [`${checks.length} mirror(s) report MATCH with the canonical artifact (hash/chain verification is the verifier's)`] });
  }
  return out;
}

function latestCheck(rows: readonly ControlCheckRow[], version: string): ControlCheckRow | undefined {
  return rows.filter((c) => c.control_version === version).sort((a, b) => Date.parse(String(b.checked_at)) - Date.parse(String(a.checked_at)))[0];
}

export async function controlStatus(client: NotionReadClient, controlAdapters: AdapterRegistry<ControlAdapter>, binding: BindingRecord, runtime: ResolvedRuntime): Promise<ControlOutcome> {
  const warnings: string[] = [...runtime.warnings];
  const gov = runtime.versions.governing_control;
  const candidates = runtime.versions.candidates.filter((c) => c.value.split("/")[0] === (gov === "UNKNOWN" ? "CONTROL" : gov.value.split("/")[0])).map((c) => c.value);
  const historical = Object.fromEntries(runtime.historical_pins.map((h) => [h.ref, `${h.spec} / ${h.schema} / ${h.control}`]));
  if (gov === "UNKNOWN") {
    return { kind: "HOLD", code: "HOLD_CONTROL_UNKNOWN", evidence: [binding.lane === "SALES" ? "the governing CONTROL version is not pinned on a Personal SALES runtime; CONTROL semantics are META-governed and must be reported from a META binding" : "SPEC_ROOT does not declare a governing CONTROL version"], safe_action: binding.lane === "SALES" ? "call os_control_status from a META binding" : "declare the governing CONTROL version durably on SPEC_ROOT", partial: { candidate_control_versions: candidates, historical_run_pins: historical }, warnings };
  }
  const adapter = controlAdapters.resolve(gov.value) as ControlSpecAdapter | undefined;
  if (!adapter) {
    return { kind: "HOLD", code: "HOLD_UNSUPPORTED_CONTROL_VERSION", evidence: [`governing CONTROL version ${gov.value} has no adapter (supported: ${controlAdapters.supported().join(", ") || "none"}); no fallback to a prior adapter`], safe_action: "add an adapter for the governing CONTROL version (capability declaration), then call again; never reinterpret under another version", partial: { governing_control_version: gov.value, candidate_control_versions: candidates, historical_run_pins: historical }, warnings };
  }
  const adapterView = { version: adapter.version, mode: adapter.mode, note: adapter.note };
  const base: Partial<ControlStatus> = { governing_control_version: gov.value, adapter: adapterView, candidate_control_versions: candidates, historical_run_pins: historical };

  const read = await readControlPlane(client, runtime);
  if ("hold" in read) return { kind: "HOLD", code: "HOLD_CONTROL_SCOPE_INCOMPLETE", evidence: [`control plane unreadable: ${read.evidence.join("; ")}`], safe_action: "restore the required read scope; a partial verification is never promoted", partial: base, warnings };
  warnings.push(...read.warnings);
  const present = new Set<ControlSource>(["MANIFEST", ...(read.sources.runs ? ["RUNS" as const] : []), ...(read.sources.ledger ? ["LEDGER" as const] : []), ...(read.sources.gates && read.gate !== "NOT_FOUND" ? ["GATES" as const] : []), ...(read.sources.control_checks && read.control_checks !== "NOT_FOUND" ? ["CONTROL_CHECKS" as const] : [])]);
  const missing = adapter.requiredSources.filter((s) => !present.has(s));
  const scope = { required: adapter.requiredSources, read: [...present], missing };
  if (missing.length > 0) return { kind: "HOLD", code: "HOLD_CONTROL_SCOPE_INCOMPLETE", evidence: [`required CONTROL sources not read: ${missing.join(", ")}`, "a result over an incomplete scope is never promoted to PASS"], safe_action: "restore the missing source(s) in the runtime control plane, then call again", partial: { ...base, scope }, warnings };

  const versionsKnown = runtime.versions.governing_spec !== "UNKNOWN" && runtime.versions.governing_schema !== "UNKNOWN";
  const invariants = computeInvariants(read, adapter, versionsKnown);
  const g = read.gate && read.gate !== "NOT_FOUND" ? read.gate : undefined;
  const gateKey = g?.key ?? "UNKNOWN";
  const confirmationRequired = adapter.controlConfirmedGates.includes(typeof gateKey === "string" ? gateKey : "");
  const gateView = { gate_key: gateKey, status: g?.status ?? "UNKNOWN", control_confirmation_state: g?.control_confirmation_state ?? "UNKNOWN", confirmation_required: confirmationRequired, confirmed_by: g?.confirmed_by_control_check_ref ?? "UNKNOWN", passed_by_run: g?.passed_by_run_ref ?? "UNKNOWN" };
  const requiredWrittenAt = isoMax(g?.last_required_written_at, read.manifest.last_required_written_at, read.state?.last_required_written_at, read.referenced_run && read.referenced_run !== "NOT_FOUND" ? read.referenced_run.last_required_written_at : undefined, ...read.incomplete_runs.map((r) => r.last_required_written_at));

  // Control Check mirror evaluation (consumed, never produced).
  const rows = read.control_checks && read.control_checks !== "NOT_FOUND" ? read.control_checks : [];
  const check = latestCheck(rows, gov.value);
  const needsCheck = adapter.mode === "INDEPENDENT_PROOF" || confirmationRequired;
  let checkView: ControlStatus["control_check"];
  if (!needsCheck) checkView = { status: "NOT_REQUIRED", ref: check?.ref ?? "UNKNOWN", checked_at: check?.checked_at ?? "UNKNOWN", result: check?.result ?? "UNKNOWN", required_written_at: requiredWrittenAt ?? "UNKNOWN", control_version: gov.value };
  else if (!check) checkView = { status: "MISSING", ref: "UNKNOWN", checked_at: "UNKNOWN", result: "UNKNOWN", required_written_at: requiredWrittenAt ?? "UNKNOWN", control_version: gov.value };
  else {
    const scopeText = typeof check.scope === "string" ? check.scope.toLowerCase() : "";
    const scopeWords: Record<ControlSource, string> = { MANIFEST: "manifest", RUNS: "run", LEDGER: "ledger", GATES: "gate", CONTROL_CHECKS: "control check" };
    const scopeMissing = adapter.requiredSources.filter((s) => s !== "CONTROL_CHECKS" && !scopeText.includes(scopeWords[s]));
    const stale = later(requiredWrittenAt, typeof check.checked_at === "string" ? check.checked_at : undefined) || typeof check.checked_at !== "string" || check.checked_at === "UNKNOWN";
    checkView = { status: scopeMissing.length > 0 ? "SCOPE_INCOMPLETE" : stale ? "STALE" : "FRESH", ref: check.ref, checked_at: check.checked_at, result: check.result, required_written_at: requiredWrittenAt ?? "UNKNOWN", control_version: gov.value };
    if (scopeMissing.length > 0) warnings.push(`control check ${check.check_id} scope "${check.scope}" omits ${scopeMissing.join(", ")}`);
  }

  const violation = invariants.filter((i) => i.result === "VIOLATION");
  const unknown = invariants.filter((i) => i.result === "UNKNOWN" || i.result === "HOLD");
  const finish = (result: ControlStatus["result"], note: string): ControlStatus => ({ governing_control_version: gov.value, adapter: adapterView, candidate_control_versions: candidates, scope, invariants, gate: gateView, control_check: checkView, result, historical_run_pins: historical, note });
  const holdWith = (code: HoldCode, evidence: string[], safe: string, result: ControlStatus["result"]): ControlOutcome => ({ kind: "HOLD", code, evidence, safe_action: safe, partial: finish(result, "not promoted"), warnings });

  if (needsCheck) {
    if (checkView.status === "MISSING") return holdWith("HOLD_CONTROL_PROOF_MISSING", [`${adapter.mode === "INDEPENDENT_PROOF" ? `${adapter.version} requires an independent Control Check` : `gate ${gateKey} is on the control-confirmed list of ${adapter.version}`}; no Control Check mirror for ${gov.value} exists`, "the harness never fabricates a check"], "run the independent verifier (manually or scheduled) and mirror its canonical report, then call again", "UNKNOWN");
    if (checkView.status === "SCOPE_INCOMPLETE") return holdWith("HOLD_CONTROL_SCOPE_INCOMPLETE", [`Control Check ${check?.check_id} does not declare every required target (${adapter.requiredSources.filter((s) => s !== "CONTROL_CHECKS").join(", ")}): scope "${check?.scope}"`], "re-run the verifier over the full required scope", "UNKNOWN");
    if (checkView.status === "STALE") return holdWith("HOLD_CONTROL_STALE", [`Control Check ${check?.check_id} checked_at ${check?.checked_at} is older than the latest required write ${requiredWrittenAt}: it cannot confirm mutations written after it`], "re-run the verifier after the latest durable write; provisional state stays provisional", "HOLD");
    const res = String(check?.result ?? "UNKNOWN").toUpperCase();
    if (res === "VIOLATION" || violation.length > 0) return holdWith("HOLD_CONTROL_VIOLATION", [...(res === "VIOLATION" ? [`Control Check ${check?.check_id} result VIOLATION`] : []), ...violation.map((v) => `${v.name}: ${v.evidence.join("; ")}`)], "resolve the violated invariant(s) durably; no gate advances on narration", "VIOLATION");
    if (res !== "PASS") return holdWith("HOLD_CONTROL_UNKNOWN", [`Control Check ${check?.check_id} result ${check?.result}`], "the verifier did not PASS; treat the gate as unconfirmed", res === "HOLD" ? "HOLD" : "UNKNOWN");
    if (adapter.mode === "INDEPENDENT_PROOF" && unknown.length > 0) warnings.push(`operational recomputation left ${unknown.map((u) => u.name).join(", ")} non-PASS; the fresh Control Check remains the authority under ${adapter.version}`);
    return { kind: "OK", status: finish("CONFIRMED", `fresh Control Check ${check?.check_id} (${check?.checked_at}) confirms the current scope under ${adapter.version}`), warnings };
  }
  // OPERATIONAL_RECOMPUTE without a control-confirmed gate.
  if (violation.length > 0) return holdWith("HOLD_CONTROL_VIOLATION", violation.map((v) => `${v.name}: ${v.evidence.join("; ")}`), "resolve the violated invariant(s) durably; no gate advances on narration", "VIOLATION");
  if (unknown.length > 0) return holdWith("HOLD_CONTROL_UNKNOWN", unknown.map((u) => `${u.name}: ${u.result} — ${u.evidence.join("; ")}`), "resolve the unknown/held invariant(s); a partial recomputation is never promoted to PASS", "HOLD");
  return { kind: "OK", status: finish("OPERATIONAL_PASS", `deterministic read-only recomputation under ${adapter.version}: an operational integrity check, not an adversarial attestation`), warnings };
}
