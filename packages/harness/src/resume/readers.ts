/**
 * Control-plane readers (PV0-007). Discover the control-plane databases from the runtime root by
 * exact title (never by global search), then read incomplete Runs, non-VERIFIED ledger rows, the
 * cursor rows and the formal Gate. Read-only; every unreadable fact becomes UNKNOWN.
 */
import { listAllChildren, type NotionReadClient } from "../notion/readClient.ts";
import { childPageTitle, normalizeId, plainText, propMentions, propText, type Block, type Page, type RichText } from "../notion/shapes.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { CapabilityProofProps, ControlPlaneGrammar, CursorProps, GateProps, LedgerProps, RunProps } from "../versions/adapters/controlPlane.ts";
import type { CapabilityProofRow, ControlCheckRow, DerivedInputsRow, ControlPlaneSnapshot, CursorRow, ExternalActionIntent, GateRow, LedgerRow, RunRow, Text } from "./snapshot.ts";
import type { CapabilitySnapshot } from "./capabilities.ts";

const UNKNOWN = "UNKNOWN" as const;

interface DatabaseObject { readonly id: string; readonly data_sources?: ReadonlyArray<{ readonly id: string }> }
interface QueryResult { readonly results: readonly Page[] }

export interface DiscoveredDatabases {
  readonly runs?: string;
  readonly ledger?: string;
  readonly gates?: string;
  readonly controlChecks?: string;
  readonly registry?: string;
  readonly state?: string;
  readonly externalActions?: string;
  readonly capabilityProofs?: string;
  readonly warnings: string[];
}

function childDatabaseTitle(block: Block): string | undefined {
  return block.type === "child_database" ? (block["child_database"] as { title?: string } | undefined)?.title : undefined;
}

/** Locate exact-title databases under the runtime root. Execution only needs fresh Run/Ledger addressing;
 * the default still discovers the complete control plane for hydration and verification. No facts are cached here. */
export async function discoverControlPlane(client: NotionReadClient, rootId: string, g: ControlPlaneGrammar, scope: "ALL" | "RUN_AND_LEDGER" | "CAPABILITIES" = "ALL"): Promise<DiscoveredDatabases> {
  const warnings: string[] = [];
  let holder = rootId;
  if (g.parentTitle) {
    const rootChildren = await listAllChildren(client, rootId);
    const parents = rootChildren.filter((b) => (childPageTitle(b) ?? "").trim() === g.parentTitle);
    if (parents.length !== 1) return { warnings: [`expected exactly one "${g.parentTitle}" page under the root, found ${parents.length}`] };
    holder = normalizeId((parents[0] as Block).id) as string;
  }
  const children = await listAllChildren(client, holder);
  const byTitle = new Map<string, string[]>();
  for (const b of children) {
    const t = childDatabaseTitle(b);
    if (t !== undefined) byTitle.set(t.trim(), [...(byTitle.get(t.trim()) ?? []), normalizeId(b.id) as string]);
  }
  const ds = async (title: string | undefined): Promise<string | undefined> => {
    if (!title) return undefined;
    const ids = byTitle.get(title) ?? [];
    if (ids.length !== 1) { warnings.push(`expected exactly one "${title}" database, found ${ids.length}`); return undefined; }
    const db = (await client.retrieveDatabase(ids[0] as string)) as DatabaseObject;
    const sources = db.data_sources ?? [];
    if (sources.length !== 1) { warnings.push(`"${title}" has ${sources.length} data sources`); return undefined; }
    return normalizeId((sources[0] as { id: string }).id);
  };
  if (scope === "CAPABILITIES") {
    const state = await ds(g.stateDatabaseTitle), capabilityProofs = await ds(g.capabilityProofsDatabaseTitle);
    return { ...(state ? { state } : {}), ...(capabilityProofs ? { capabilityProofs } : {}), warnings: [...new Set(warnings)] };
  }
  const runs = await ds(g.runsDatabaseTitle);
  const ledger = await ds(g.ledgerDatabaseTitle);
  if (scope === "RUN_AND_LEDGER") return { ...(runs ? { runs } : {}), ...(ledger ? { ledger } : {}), warnings: [...new Set(warnings)] };
  const gates = await ds(g.gatesDatabaseTitle);
  const controlChecks = await ds(g.controlChecksDatabaseTitle);
  const registry = await ds(g.resourceRegistryDatabaseTitle);
  const state = await ds(g.stateDatabaseTitle);
  const externalActions = await ds(g.externalActionsDatabaseTitle);
  const capabilityProofs = await ds(g.capabilityProofsDatabaseTitle);
  return { ...(runs ? { runs } : {}), ...(ledger ? { ledger } : {}), ...(gates ? { gates } : {}), ...(controlChecks ? { controlChecks } : {}), ...(registry ? { registry } : {}), ...(state ? { state } : {}), ...(externalActions ? { externalActions } : {}), ...(capabilityProofs ? { capabilityProofs } : {}), warnings: [...new Set(warnings)] };
}

function txt(page: Page, name: string | undefined): Text {
  if (!name) return UNKNOWN;
  const v = propText(page, name);
  return v === undefined || v === "" ? UNKNOWN : v.trim();
}
/** Optional free text: the property exists but is empty ⇒ the absence is positively established ("NONE"), not UNKNOWN. */
function optText(page: Page, name: string | undefined): Text {
  if (!name) return UNKNOWN;
  if (!(name in page.properties)) return UNKNOWN;
  const v = propText(page, name);
  return v === undefined || v.trim() === "" ? "NONE" : v.trim();
}
/** Free text whose emptiness is established: `""` when a text-typed property is read empty, UNKNOWN otherwise. Untrimmed. */
function knownText(page: Page, name: string | undefined): Text {
  if (!name) return UNKNOWN;
  const type = (page.properties[name] as { type?: string } | undefined)?.type;
  if (type !== "title" && type !== "rich_text" && type !== "email" && type !== "url" && type !== "phone_number") return UNKNOWN;
  return propText(page, name) ?? "";
}
/** Every page id of a fully listed relation; UNKNOWN when the property is not a relation, is truncated or holds a bad id. */
function relationIds(page: Page, name: string | undefined): readonly string[] | "UNKNOWN" {
  if (!name) return UNKNOWN;
  const p = page.properties[name] as { type?: string; relation?: unknown; has_more?: unknown } | undefined;
  if (p?.type !== "relation" || !Array.isArray(p.relation) || p.has_more === true) return UNKNOWN;
  const ids = (p.relation as readonly { id?: string }[]).map((r) => normalizeId(r?.id));
  return ids.every((id): id is string => id !== undefined) ? ids : UNKNOWN;
}
function bool(page: Page, name: string | undefined): boolean | "UNKNOWN" {
  if (!name) return UNKNOWN;
  const v = propText(page, name);
  return v === "true" ? true : v === "false" ? false : UNKNOWN;
}
function num(page: Page, name: string | undefined): number | "UNKNOWN" {
  if (!name) return UNKNOWN;
  const v = propText(page, name);
  return v === undefined || v === "" || Number.isNaN(Number(v)) ? UNKNOWN : Number(v);
}
function titleOf(page: Page): string {
  for (const p of Object.values(page.properties)) if (p.type === "title") return plainText((p as { title: readonly RichText[] }).title);
  return "";
}

export function readRun(page: Page, p: RunProps, harnessPlanIdProp?: string): RunRow {
  return {
    harness_plan_id: harnessPlanIdProp ? txt(page, harnessPlanIdProp) : UNKNOWN,
    ref: normalizeId(page.id) as string,
    label: txt(page, p.runId) === UNKNOWN ? titleOf(page) || UNKNOWN : `${txt(page, p.runId)} | ${titleOf(page)}`,
    status: txt(page, p.status),
    recovery_required: bool(page, p.recoveryRequired),
    last_edited: page.last_edited_time ?? UNKNOWN,
    next_action: txt(page, p.nextAction),
    holds: optText(page, p.holds),
    last_required_written_at: txt(page, p.lastRequiredWrittenAt),
    mutation_count: num(page, p.mutationCount),
    verified_mutation_count: num(page, p.verifiedMutationCount),
    attempt_count: num(page, p.attemptCount),
    pins: { spec: txt(page, p.specVersion), schema: txt(page, p.schemaVersion), control: p.controlVersion ? txt(page, p.controlVersion) : "NOT_APPLICABLE" },
    gate_before: txt(page, p.gateBefore),
    gate_after_expected: txt(page, p.gateAfterExpected),
    gate_after_observed: txt(page, p.gateAfterObserved),
    origin: txt(page, p.origin),
  };
}

export function readLedger(page: Page, p: LedgerProps): LedgerRow {
  return { ref: normalizeId(page.id) as string, label: txt(page, p.mutationId) === UNKNOWN ? titleOf(page) || UNKNOWN : `${txt(page, p.mutationId)} | ${titleOf(page)}`, status: txt(page, p.status), run_ref_text: txt(page, p.runRef), last_edited: page.last_edited_time ?? UNKNOWN };
}

export function readGate(page: Page, p: GateProps): GateRow {
  return {
    ref: normalizeId(page.id) as string,
    key: txt(page, p.gateKey),
    status: txt(page, p.status),
    open_blocker: optText(page, p.openBlocker),
    next_action: txt(page, p.nextAction),
    next_question: txt(page, p.nextQuestion),
    last_edited: page.last_edited_time ?? UNKNOWN,
    last_required_written_at: txt(page, p.lastRequiredWrittenAt),
    control_confirmation_state: txt(page, p.controlConfirmationState),
    passed_by_run_ref: txt(page, p.passedByRunRef),
    passed_by_run_ids: propMentions(page, p.passedByRunRef),
    confirmed_by_control_check_ref: p.confirmedByControlCheckRef ? txt(page, p.confirmedByControlCheckRef) : UNKNOWN,
  };
}

export function readControlCheck(page: Page, p: import("../versions/adapters/controlPlane.ts").ControlCheckProps): ControlCheckRow {
  return { ref: normalizeId(page.id) as string, check_id: txt(page, p.checkId), control_version: txt(page, p.controlVersion), checked_at: txt(page, p.checkedAt), result: txt(page, p.result), scope: txt(page, p.scope), artifact_hash: p.artifactHash ? txt(page, p.artifactHash) : UNKNOWN, mirror_integrity: p.mirrorIntegrity ? txt(page, p.mirrorIntegrity) : UNKNOWN, last_edited: page.last_edited_time ?? UNKNOWN };
}

export function readCursor(page: Page, c: CursorProps): CursorRow {
  return {
    ref: normalizeId(page.id) as string,
    runtime_state: txt(page, c.runtimeState),
    health: txt(page, c.health),
    persistence_health: txt(page, c.persistenceHealth),
    recovery_required: bool(page, c.recoveryRequired),
    current_gate: txt(page, c.currentGate),
    current_gate_status: txt(page, c.currentGateStatus),
    current_setup_gate: txt(page, c.currentSetupGate),
    current_setup_gate_status: txt(page, c.currentSetupGateStatus),
    open_blocker: optText(page, c.openBlocker),
    next_action: txt(page, c.nextAction),
    next_question: txt(page, c.nextQuestion),
    last_run_ref_ids: c.lastRunRef ? propMentions(page, c.lastRunRef) : [],
    last_run_ref_text: txt(page, c.lastRunRef),
    last_verified_mutation: txt(page, c.lastVerifiedMutation),
    last_required_written_at: txt(page, c.lastRequiredWrittenAt),
    last_verified_at: txt(page, c.lastVerifiedAt),
    last_edited: page.last_edited_time ?? UNKNOWN,
    operating_modes: txt(page, c.operatingModes),
  };
}

export function readCapabilityProof(page: Page, p: CapabilityProofProps): CapabilityProofRow {
  return {
    ref: normalizeId(page.id) as string,
    proof_key: txt(page, p.proofKey), capability_key: txt(page, p.capabilityKey), state: txt(page, p.state),
    runtime_id: txt(page, p.runtimeId), principal_key: txt(page, p.principalKey), operating_mode: txt(page, p.operatingMode),
    competent_source: txt(page, p.competentSource), evidence_ref: txt(page, p.evidenceRef),
    verified_at: txt(page, p.verifiedAt), scope: txt(page, p.scope), last_edited: page.last_edited_time ?? UNKNOWN,
  };
}

async function queryAll(client: NotionReadClient, dsId: string, filter: unknown): Promise<Page[]> {
  const out: Page[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const q = (await client.queryDataSource(dsId, filter, cursor)) as QueryResult & { has_more?: boolean; next_cursor?: string | null };
    out.push(...q.results.filter((p) => !p.archived && !p.in_trash));
    if (!q.has_more || !q.next_cursor) return out;
    cursor = q.next_cursor;
  }
  return out;
}

/** Positive-only capability preflight. Uncertainty falls back to the full reader; never manufactures a HOLD.
 * No page/query facts are cached. Unlike the legacy reader, a truncated journal cannot certify completeness. */
export async function readCapabilitySnapshot(client: NotionReadClient, runtime: ResolvedRuntime): Promise<CapabilitySnapshot | undefined> {
  try {
    const g = runtime.adapter.controlPlane;
    if (!g.capabilityProofsDatabaseTitle || !g.capabilityProofProps) return undefined;
    const dbs = await discoverControlPlane(client, runtime.root_ref, g, "CAPABILITIES");
    if (dbs.warnings.length || !dbs.capabilityProofs || (g.stateDatabaseTitle && !dbs.state)) return undefined;
    const completeRows = async (ds: string, filter: unknown): Promise<Page[] | undefined> => {
      const rows: Page[] = [], seen = new Set<string>(); let cursor: string | undefined;
      for (let n = 0; n < 50; n++) {
        const q = await client.queryDataSource(ds, filter, cursor) as QueryResult & { has_more?: boolean; next_cursor?: string | null };
        if (!Array.isArray(q.results)) return undefined;
        rows.push(...q.results.filter((p) => !p.archived && !p.in_trash));
        if (q.has_more === false) return rows;
        if (q.has_more !== true || !q.next_cursor || seen.has(q.next_cursor)) return undefined;
        seen.add(q.next_cursor); cursor = q.next_cursor;
      }
      return undefined;
    };
    const page = await client.retrievePage(runtime.manifest_ref) as Page;
    if (page.archived || page.in_trash) return undefined;
    const manifest = readCursor(page, g.manifestCursor);
    let state: CursorRow | undefined;
    if (g.stateDatabaseTitle) {
      const rows = await completeRows(dbs.state!, { property: "title", title: { equals: g.stateRowTitle ?? "CURRENT" } });
      if (!rows) return undefined;
      const current = rows.filter((p) => titleOf(p).trim() === (g.stateRowTitle ?? "CURRENT"));
      if (current.length !== 1) return undefined;
      state = readCursor(current[0]!, g.stateCursor ?? g.manifestCursor);
    }
    const modes = (state ?? manifest).operating_modes;
    // 0.5.13 declares ONLY adapter default modes; no invented OS State property or migration is required.
    // If the grammar does declare a durable mode field, unknown values cannot certify a positive shortcut.
    const modeField = (state ? g.stateCursor ?? g.manifestCursor : g.manifestCursor).operatingModes;
    if (modeField && (modes === UNKNOWN || modes === "NONE" || modes.trim() === "")) return undefined;
    const proofs = await completeRows(dbs.capabilityProofs, undefined);
    if (!proofs) return undefined;
    return { manifest, ...(state ? { state } : {}), capability_proofs: proofs.map((p) => readCapabilityProof(p, g.capabilityProofProps!)) };
  } catch { return undefined; }
}

/** Full control-plane read for a resolved runtime. */
export async function readControlPlane(client: NotionReadClient, runtime: ResolvedRuntime): Promise<ControlPlaneSnapshot | { readonly hold: "HOLD_BOOTSTRAP_DISCOVERY" | "HOLD_REQUIRED_RESOURCE_MISSING"; readonly evidence: string[] }> {
  const g = runtime.adapter.controlPlane;
  const warnings: string[] = [];
  let dbs: DiscoveredDatabases;
  try {
    dbs = await discoverControlPlane(client, runtime.root_ref, g);
  } catch (err) {
    return { hold: "HOLD_BOOTSTRAP_DISCOVERY", evidence: [`control plane unreadable: ${(err as Error).message}`] };
  }
  warnings.push(...dbs.warnings);
  if (!dbs.runs || !dbs.ledger) return { hold: "HOLD_REQUIRED_RESOURCE_MISSING", evidence: [`required control-plane databases missing: ${[!dbs.runs && g.runsDatabaseTitle, !dbs.ledger && g.ledgerDatabaseTitle].filter(Boolean).join(", ")}`, ...dbs.warnings] };

  // Manifest cursor (already resolved page): re-read fresh.
  const manifestPage = (await client.retrievePage(runtime.manifest_ref)) as Page;
  const manifest = readCursor(manifestPage, g.manifestCursor);

  // SALES OS State cursor.
  let state: CursorRow | undefined;
  if (g.stateDatabaseTitle) {
    if (!dbs.state) return { hold: "HOLD_REQUIRED_RESOURCE_MISSING", evidence: [`required "${g.stateDatabaseTitle}" database missing`] };
    const rows = (await queryAll(client, dbs.state, { property: "title", title: { equals: g.stateRowTitle ?? "CURRENT" } })).filter((p) => titleOf(p).trim() === (g.stateRowTitle ?? "CURRENT"));
    if (rows.length !== 1) return { hold: "HOLD_REQUIRED_RESOURCE_MISSING", evidence: [`expected exactly one ${g.stateRowTitle ?? "CURRENT"} row in "${g.stateDatabaseTitle}", found ${rows.length}`] };
    state = readCursor(rows[0] as Page, g.stateCursor ?? g.manifestCursor);
  }

  // Runs: incomplete by status or recovery flag; filter client-side too (fixtures may ignore filters).
  const runPages = await queryAll(client, dbs.runs, { or: [...g.incompleteRunStatuses.map((s) => ({ property: g.runProps.status, select: { equals: s } })), { property: g.runProps.recoveryRequired, checkbox: { equals: true } }] });
  const incomplete_runs = runPages.map((p) => readRun(p, g.runProps, g.writeProps?.runHarnessPlanId)).filter((r) => (typeof r.status === "string" && g.incompleteRunStatuses.includes(r.status)) || r.recovery_required === true);

  // Referenced run (cursor pointer) — prefer OS State for SALES, Manifest otherwise.
  const cursor = state ?? manifest;
  // Native Notion writes use a scalar canonical page id for rich-text references. Mentions remain supported for
  // legacy/manual records, but a valid id embedded in Last Run Ref is an equally authoritative pointer.
  const cursorTextRef = typeof cursor.last_run_ref_text === "string" ? normalizeId(cursor.last_run_ref_text) : undefined;
  const manifestTextRef = typeof manifest.last_run_ref_text === "string" ? normalizeId(manifest.last_run_ref_text) : undefined;
  const refIds = cursor.last_run_ref_ids.length > 0
    ? cursor.last_run_ref_ids
    : cursorTextRef
      ? [cursorTextRef]
      : manifest.last_run_ref_ids.length > 0
        ? manifest.last_run_ref_ids
        : manifestTextRef
          ? [manifestTextRef]
          : [];
  let referenced_run: RunRow | "NOT_FOUND" | undefined;
  if (refIds.length > 0) {
    const already = incomplete_runs.find((r) => r.ref === refIds[0]);
    if (already) referenced_run = already;
    else {
      try {
        referenced_run = readRun((await client.retrievePage(refIds[0] as string)) as Page, g.runProps, g.writeProps?.runHarnessPlanId);
      } catch (err) {
        warnings.push(`referenced_run_unreadable: ${refIds[0]} (${(err as Error).message})`);
        referenced_run = "NOT_FOUND";
      }
    }
  }

  // Latest Run by its durable completion watermark (Last Required Written At): a COMPLETED Run the cursor never
  // adopted, with a watermark newer than the cursor's own, is a stale state (state-last missing).
  let latest_run: RunRow | undefined;
  try {
    const recent = (await queryAll(client, dbs.runs, { property: g.runProps.lastRequiredWrittenAt, date: { is_not_empty: true } })).map((p) => readRun(p, g.runProps, g.writeProps?.runHarnessPlanId));
    latest_run = recent.filter((r) => typeof r.last_required_written_at === "string" && r.last_required_written_at !== "UNKNOWN" && !Number.isNaN(Date.parse(r.last_required_written_at))).sort((a, b) => Date.parse(b.last_required_written_at as string) - Date.parse(a.last_required_written_at as string))[0];
  } catch (err) {
    warnings.push(`latest_run_unreadable: ${(err as Error).message}`);
  }

  // Ledger: non-VERIFIED rows.
  const ledgerPages = await queryAll(client, dbs.ledger, { or: g.nonVerifiedLedgerStatuses.map((s) => ({ property: g.ledgerProps.status, select: { equals: s } })) });
  const incomplete_ledger = ledgerPages.map((p) => readLedger(p, g.ledgerProps)).filter((l) => typeof l.status === "string" && g.nonVerifiedLedgerStatuses.includes(l.status));

  // Gate row (META): keyed by the cursor's current setup gate, else current gate.
  let gate: GateRow | "NOT_FOUND" | undefined;
  if (g.gatesDatabaseTitle && g.gateProps) {
    if (!dbs.gates) { warnings.push(`"${g.gatesDatabaseTitle}" database not found`); gate = "NOT_FOUND"; }
    else {
      const source = manifest.current_setup_gate !== UNKNOWN ? manifest.current_setup_gate : manifest.current_gate;
      const key = typeof source === "string" && source !== UNKNOWN ? (source.split(/\s+—\s+|\s+-\s+/)[0] ?? source).trim() : undefined;
      if (!key) gate = "NOT_FOUND";
      else {
        const rows = (await queryAll(client, dbs.gates, { property: g.gateProps.gateKey, rich_text: { equals: key } })).map((p) => readGate(p, g.gateProps as GateProps)).filter((r) => r.key === key);
        if (rows.length === 1) gate = rows[0] as GateRow;
        else { warnings.push(`gate row for key ${key}: found ${rows.length}`); gate = "NOT_FOUND"; }
      }
    }
  }

  // Control Check mirrors (META): consumed, never produced.
  let control_checks: readonly ControlCheckRow[] | "NOT_FOUND" | undefined;
  if (g.controlChecksDatabaseTitle && g.controlCheckProps) {
    if (!dbs.controlChecks) { control_checks = "NOT_FOUND"; warnings.push(`"${g.controlChecksDatabaseTitle}" database not found`); }
    else control_checks = (await queryAll(client, dbs.controlChecks, { property: g.controlCheckProps.checkedAt, date: { is_not_empty: true } })).map((p) => readControlCheck(p, g.controlCheckProps as import("../versions/adapters/controlPlane.ts").ControlCheckProps));
  }

  // Registered resources (META): pointers the Skill may read with native Notion; never business truth.
  const readRegistered = async (resourceKey: string): Promise<DerivedInputsRow | "NOT_FOUND"> => {
    const rp = g.resourceRegistryProps as NonNullable<typeof g.resourceRegistryProps>;
    if (!dbs.registry) return "NOT_FOUND";
    const rows = (await queryAll(client, dbs.registry, { property: rp.resourceKey, rich_text: { equals: resourceKey } })).filter((p) => txt(p, rp.resourceKey) === resourceKey);
    const row = rows[0];
    if (rows.length > 1) warnings.push(`registry has ${rows.length} rows for ${resourceKey}; the first is exposed`);
    return row ? { ref: normalizeId(row.id) as string, resource_key: resourceKey, url: txt(row, rp.resourceUrl), status: txt(row, rp.status), scope: txt(row, rp.scope), schema_version: txt(row, rp.schemaVersion), last_verified: txt(row, rp.lastVerified), notes: txt(row, rp.notes) } : "NOT_FOUND";
  };
  let derived_inputs: DerivedInputsRow | "NOT_FOUND" | undefined;
  if (g.resourceRegistryDatabaseTitle && g.resourceRegistryProps && g.derivedInputsResourceKey) {
    if (!dbs.registry) { derived_inputs = "NOT_FOUND"; warnings.push(`"${g.resourceRegistryDatabaseTitle}" database not found`); }
    else derived_inputs = await readRegistered(g.derivedInputsResourceKey);
  }
  // Registered GTM measurement resource (candidate, PV-GTM-002): its presence is what makes a runtime GTM-capable
  // on the META side. Absent ⇒ NOT_FOUND, no warning: not registering it is a legitimate state, not a defect.
  let gtm_metrics: DerivedInputsRow | "NOT_FOUND" | undefined;
  if (g.resourceRegistryDatabaseTitle && g.resourceRegistryProps && g.gtmMetricsResourceKey) {
    gtm_metrics = dbs.registry ? await readRegistered(g.gtmMetricsResourceKey) : "NOT_FOUND";
  }

  // External action intents (SALES): reconstructed from the durable record — routing metadata only, never an effect.
  let external_intents_unresolved: number | "NOT_APPLICABLE" | "UNKNOWN" = "NOT_APPLICABLE";
  const external_intents: ExternalActionIntent[] = [];
  if (g.externalActionsDatabaseTitle && g.externalActionProps) {
    if (!dbs.externalActions) { external_intents_unresolved = UNKNOWN; warnings.push(`"${g.externalActionsDatabaseTitle}" database not found`); }
    else {
      const ep = g.externalActionProps;
      const rows = await queryAll(client, dbs.externalActions, { and: [{ property: ep.recordType, select: { equals: g.intentRecordType } }] });
      for (const p of rows) {
        if (propText(p, ep.recordType) !== g.intentRecordType || !g.unresolvedEffectStatuses.includes(propText(p, ep.effectStatus) ?? "")) continue;
        const row: ExternalActionIntent = { ref: normalizeId(p.id) as string, action_key: txt(p, ep.actionKey), record_type: txt(p, ep.recordType), effect_status: txt(p, ep.effectStatus), approval_state: txt(p, ep.approvalState), action_type: txt(p, ep.actionType), recipient: txt(p, ep.recipient), subject: txt(p, ep.subject), thread_ref: txt(p, ep.threadRef), effect_ref: txt(p, ep.effectRef), prepared_at: txt(p, ep.preparedAt), last_edited: p.last_edited_time ?? UNKNOWN,
          context_facts: { recipient: knownText(p, ep.recipient), thread_context: knownText(p, ep.threadRef), account_ref: knownText(p, ep.accountRef), contact_ref: knownText(p, ep.contactRef), authority_refs: relationIds(p, ep.authorityRef) } };
        const { readNativeReconciliation } = await import("../effects/adapter.ts");
        const native = await readNativeReconciliation(client, runtime, row);
        external_intents.push({ ...row, ...(native ? { native_reconciliation: native } : {}) });
      }
      external_intents_unresolved = external_intents.filter((row) => !row.native_reconciliation).length;
    }
  }

  // Capability proof journal (SALES candidate). Missing journal is explicit: completeness derives UNKNOWN rather
  // than silently treating an absent row or database as a verified capability.
  let capability_proofs: readonly CapabilityProofRow[] | "NOT_FOUND" | undefined;
  if (g.capabilityProofsDatabaseTitle && g.capabilityProofProps) {
    if (!dbs.capabilityProofs) {
      capability_proofs = "NOT_FOUND";
      warnings.push(`"${g.capabilityProofsDatabaseTitle}" database not found`);
    } else {
      // Read the whole append-only journal: a malformed row with no verification time is itself ERROR evidence and
      // must not disappear behind an `is_not_empty` filter.
      capability_proofs = (await queryAll(client, dbs.capabilityProofs, undefined))
        .map((p) => readCapabilityProof(p, g.capabilityProofProps as CapabilityProofProps));
    }
  }

  const sources = { runs: dbs.runs !== undefined, ledger: dbs.ledger !== undefined, gates: dbs.gates !== undefined, control_checks: dbs.controlChecks !== undefined, state: dbs.state !== undefined };
  return { manifest, ...(state ? { state } : {}), incomplete_runs, ...(referenced_run !== undefined ? { referenced_run } : {}), ...(latest_run ? { latest_run } : {}), incomplete_ledger, ...(gate !== undefined ? { gate } : {}), ...(control_checks !== undefined ? { control_checks } : {}), ...(derived_inputs !== undefined ? { derived_inputs } : {}), ...(gtm_metrics !== undefined ? { gtm_metrics } : {}), sources, external_intents_unresolved, external_intents, ...(capability_proofs !== undefined ? { capability_proofs } : {}), warnings };
}
