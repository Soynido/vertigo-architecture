/**
 * Control-plane fixtures for os_resume tests. Extends the binding world with mutable META (Runs,
 * Mutation Ledger, Gates) and SALES (03 — CONTROL PLANE: OS State, Runs, Mutation Ledger, External
 * Actions) databases. All ids are synthetic; all versions belong to the TEST_* families.
 */
import type { Block, Page, RichText } from "../../src/notion/shapes.ts";
import { buildWorld, type World } from "./binding-fixtures.ts";
import { ID as META_ID, childPage, mention, synthetic, text, V as MV } from "./meta-fixtures.ts";
import { IDS as SALES_IDS, SV } from "./sales-fixtures.ts";

const rt = (s: string): RichText[] => [text(s)];
const list = (blocks: Block[]) => ({ results: blocks, has_more: false, next_cursor: null });

export const R = {
  metaRunsDb: synthetic("meta-runs-db"), metaRunsDs: synthetic("meta-runs-ds"),
  metaLedgerDb: synthetic("meta-ledger-db"), metaLedgerDs: synthetic("meta-ledger-ds"),
  metaGatesDb: synthetic("meta-gates-db"), metaGatesDs: synthetic("meta-gates-ds"),
  metaChecksDb: synthetic("meta-checks-db"), metaChecksDs: synthetic("meta-checks-ds"), check1: synthetic("meta-check-1"),
  metaRegistryDb: synthetic("meta-registry-db"), metaRegistryDs: synthetic("meta-registry-ds"), registryInputs: synthetic("meta-registry-inputs"),
  metaInputsDb: synthetic("meta-inputs-db"), metaInputsDs: synthetic("meta-inputs-ds"),
  run1: synthetic("meta-run-1"), run2: synthetic("meta-run-2"), run3: synthetic("meta-run-3"),
  gateM1: synthetic("meta-gate-m1"),
  salesCp: synthetic("sales-cp-rep-a"),
  salesStateDb: synthetic("sales-state-db"), salesStateDs: synthetic("sales-state-ds"), salesStateRow: synthetic("sales-state-row"),
  salesRunsDb: synthetic("sales-runs-db"), salesRunsDs: synthetic("sales-runs-ds"),
  salesLedgerDb: synthetic("sales-ledger-db"), salesLedgerDs: synthetic("sales-ledger-ds"),
  salesExtDb: synthetic("sales-ext-db"), salesExtDs: synthetic("sales-ext-ds"),
  salesRun1: synthetic("sales-run-1"),
};

export interface RunOpts { id: string; label: string; status: string; recovery?: boolean; nextAction?: string; holds?: string; lastEdited?: string; spec?: string; schema?: string; control?: string; mutationCount?: number; verified?: number; attempts?: number; lane?: "META" | "SALES" }
export function runPage(o: RunOpts): Page {
  const spec = o.lane === "SALES" ? "Sales Contract Version" : "Spec Version";
  const schema = o.lane === "SALES" ? "Schema Version" : "META Schema Version";
  const props: Record<string, unknown> = {
    Run: { type: "title", title: rt(o.label) },
    "Run ID": { type: "unique_id", unique_id: { prefix: o.lane === "SALES" ? "SRUN" : "TRUN", number: Number(o.label.replace(/\D/g, "") || 0) } },
    Status: { type: "select", select: { name: o.status } },
    "Recovery Required": { type: "checkbox", checkbox: o.recovery ?? false },
    "Next Action": { type: "rich_text", rich_text: o.nextAction ? rt(o.nextAction) : [] },
    Holds: { type: "rich_text", rich_text: o.holds ? rt(o.holds) : [] },
    "Last Required Written At": { type: "date", date: o.lastEdited ? { start: o.lastEdited } : null },
    "Mutation Count": { type: "number", number: o.mutationCount ?? 1 },
    "Verified Mutation Count": { type: "number", number: o.verified ?? (o.status === "COMPLETED" ? o.mutationCount ?? 1 : 0) },
    "Attempt Count": { type: "number", number: o.attempts ?? 1 },
    [spec]: { type: "rich_text", rich_text: rt(o.spec ?? (o.lane === "SALES" ? SV.contract : MV.specA)) },
    [schema]: { type: "rich_text", rich_text: rt(o.schema ?? (o.lane === "SALES" ? SV.schema : MV.schema)) },
    "Gate Before": { type: "rich_text", rich_text: rt("G-before") },
    "Gate After Expected": { type: "rich_text", rich_text: rt("G-after") },
    "Gate After Observed": { type: "rich_text", rich_text: [] },
    Origin: { type: "select", select: { name: o.lane === "SALES" ? "RUNTIME" : "META_RUNTIME" } },
  };
  if (o.lane !== "SALES") props["Control Version"] = { type: "rich_text", rich_text: rt(o.control ?? MV.controlA) };
  return { object: "page", id: o.id, archived: false, last_edited_time: o.lastEdited ?? "2030-01-01T00:00:00.000Z", properties: props as Page["properties"] };
}

export function ledgerRow(id: string, label: string, status: string, runRef: string, lastEdited = "2030-01-01T00:00:00.000Z"): Page {
  return { object: "page", id, archived: false, last_edited_time: lastEdited, properties: { Mutation: { type: "title", title: rt(label) }, "Mutation ID": { type: "unique_id", unique_id: { prefix: "TMUT", number: Number(label.replace(/\D/g, "") || 0) } }, Status: { type: "select", select: { name: status } }, "Run Ref": { type: "rich_text", rich_text: rt(runRef) } } };
}

export interface GateOpts { id: string; key: string; status: string; blocker?: string; nextAction?: string; nextQuestion?: string; lastEdited?: string; confirmation?: string; passedBy?: string; confirmedBy?: string }
export function gateRow(o: GateOpts): Page {
  return { object: "page", id: o.id, archived: false, last_edited_time: o.lastEdited ?? "2030-01-01T00:00:00.000Z", properties: { Gate: { type: "title", title: rt(`${o.key} — GATE`) }, "Gate Key": { type: "rich_text", rich_text: rt(o.key) }, Status: { type: "select", select: { name: o.status } }, "Open Blocker": { type: "rich_text", rich_text: o.blocker ? rt(o.blocker) : [] }, "Next Action": { type: "rich_text", rich_text: o.nextAction ? rt(o.nextAction) : [] }, "Next Question": { type: "rich_text", rich_text: o.nextQuestion ? rt(o.nextQuestion) : [] }, "Last Required Written At": { type: "date", date: o.lastEdited ? { start: o.lastEdited } : null }, "Control Confirmation State": { type: "select", select: { name: o.confirmation ?? "NOT_REQUIRED" } }, "Passed By Run Ref": { type: "rich_text", rich_text: o.passedBy ? rt(o.passedBy) : [] }, "Confirmed By Control Check Ref": { type: "rich_text", rich_text: o.confirmedBy ? rt(o.confirmedBy) : [] } } };
}

/** A META Resource Registry row (read-only pointer), e.g. the derived META_SALES_RUNTIME_INPUTS resource. */
export function registryRow(o: { key: string; url?: string; status?: string; scope?: string; schemaVersion?: string; lastVerified?: string; notes?: string; id?: string }): Page {
  return { object: "page", id: o.id ?? synthetic(`meta-registry-${o.key}`), archived: false, last_edited_time: o.lastVerified ?? "2030-01-02T00:00:00.000Z", properties: { Resource: { type: "title", title: rt(o.key) }, "Resource Key": { type: "rich_text", rich_text: rt(o.key) }, "Resource URL": { type: "url", url: o.url ?? `https://example.invalid/${o.key}` }, Status: { type: "select", select: { name: o.status ?? "RESOLVED" } }, Scope: { type: "select", select: { name: o.scope ?? "PRIVATE_META" } }, "Schema Version": { type: "rich_text", rich_text: rt(o.schemaVersion ?? "TEST_INPUTS/1") }, "Last Verified": { type: "date", date: { start: o.lastVerified ?? "2030-01-02T00:00:00.000Z" } }, Notes: { type: "rich_text", rich_text: o.notes ? rt(o.notes) : [] } } };
}

/** A Control Check mirror row: pointer/summary of an independent verifier's canonical report (00G). */
export interface ControlCheckOpts { id?: string; checkId?: string; version?: string; checkedAt?: string; result?: string; scope?: string; hash?: string; integrity?: string }
export function controlCheckRow(o: ControlCheckOpts = {}): Page {
  const id = o.id ?? R.check1;
  return { object: "page", id, archived: false, last_edited_time: o.checkedAt ?? "2030-01-02T06:00:00.000Z", properties: { "Control Check": { type: "title", title: rt(o.checkId ?? "TCC-1") }, "Control Check ID": { type: "rich_text", rich_text: rt(o.checkId ?? "TCC-1") }, "Control Version": { type: "rich_text", rich_text: rt(o.version ?? MV.controlA) }, "Checked At": { type: "date", date: o.checkedAt === "" ? null : { start: o.checkedAt ?? "2030-01-02T06:00:00.000Z" } }, Result: { type: "select", select: { name: o.result ?? "PASS" } }, Scope: { type: "rich_text", rich_text: rt(o.scope ?? "manifest, runs, mutation ledger, gates") }, "Canonical Artifact Hash": { type: "rich_text", rich_text: rt(o.hash ?? "sha256:fixture") }, "Mirror Integrity Status": { type: "select", select: { name: o.integrity ?? "OK" } } } };
}

export interface MetaCursorOpts { runtimeId?: string; runtimeState?: string; health?: string; persistence?: string; recovery?: boolean; currentGate?: string; setupGate?: string; setupGateStatus?: string; blocker?: string; nextAction?: string; lastRunId?: string | null; lastVerifiedMutation?: string; lastEdited?: string; omitPersistence?: boolean; spec?: string; schema?: string; control?: string }
export function metaManifestPage(o: MetaCursorOpts = {}): Page {
  const lastRun = o.lastRunId === undefined ? R.run1 : o.lastRunId;
  const props: Record<string, unknown> = {
    Name: { type: "title", title: rt("CURRENT") },
    "Root URL": { type: "url", url: `https://example.invalid/p/${META_ID.rootA}` },
    "Runtime ID": { type: "rich_text", rich_text: rt(o.runtimeId ?? "RT-TEST-01") },
    "Spec Root URL": { type: "url", url: `https://example.invalid/p/${META_ID.specRoot}` },
    "Spec Version": { type: "rich_text", rich_text: rt(o.spec ?? MV.specA) },
    "Schema Version": { type: "rich_text", rich_text: rt(o.schema ?? MV.schema) },
    "Control Version": { type: "rich_text", rich_text: rt(o.control ?? MV.controlA) },
    "Runtime State": { type: "select", select: { name: o.runtimeState ?? "SETUP" } },
    Health: { type: "select", select: { name: o.health ?? "HEALTHY" } },
    "Recovery Required": { type: "checkbox", checkbox: o.recovery ?? false },
    "Current Gate": { type: "rich_text", rich_text: rt(o.currentGate ?? "T0 — INSTALL — PASS") },
    "Current Setup Gate": { type: "rich_text", rich_text: rt(o.setupGate ?? "T1 — FRAME") },
    "Current Setup Gate Status": { type: "select", select: { name: o.setupGateStatus ?? "OPEN" } },
    "Open Blocker": { type: "rich_text", rich_text: o.blocker ? rt(o.blocker) : [] },
    "Next Action": { type: "rich_text", rich_text: rt(o.nextAction ?? "Ask the first frame question") },
    "Last Run Ref": { type: "rich_text", rich_text: lastRun ? [text("TRUN-x | "), mention(lastRun)] : [] },
    "Last Verified Mutation": { type: "rich_text", rich_text: rt(o.lastVerifiedMutation ?? "TMUT-9") },
    "Last Required Written At": { type: "date", date: { start: o.lastEdited ?? "2030-01-02T00:00:00.000Z" } },
    "Last Verified At": { type: "date", date: { start: o.lastEdited ?? "2030-01-02T00:00:00.000Z" } },
  };
  if (!o.omitPersistence) props["Persistence Health"] = { type: "select", select: { name: o.persistence ?? "PASS" } };
  return { object: "page", id: META_ID.manifest, archived: false, last_edited_time: o.lastEdited ?? "2030-01-02T00:00:00.000Z", parent: { type: "data_source_id", data_source_id: META_MANIFEST_DS }, properties: props as Page["properties"] };
}

export interface SalesStateOpts { gate?: string; gateStatus?: string; buildState?: string; recovery?: boolean; persistence?: string; blocker?: string; nextAction?: string; nextQuestion?: string; lastRunId?: string | null; lastVerifiedMutation?: string; lastEdited?: string; operatingMode?: string }
export function salesStatePage(o: SalesStateOpts = {}): Page {
  const lastRun = o.lastRunId === undefined ? R.salesRun1 : o.lastRunId;
  return { object: "page", id: R.salesStateRow, archived: false, last_edited_time: o.lastEdited ?? "2030-01-02T00:00:00.000Z", properties: {
    Name: { type: "title", title: rt("CURRENT") },
    "Current Gate": { type: "select", select: { name: o.gate ?? "B2_ICP" } },
    "Current Gate Status": { type: "select", select: { name: o.gateStatus ?? "OPEN" } },
    "Build State": { type: "select", select: { name: o.buildState ?? "B2_ICP" } },
    "Recovery Required": { type: "checkbox", checkbox: o.recovery ?? false },
    "Persistence Health": { type: "select", select: { name: o.persistence ?? "PASS" } },
    "Open Blocker": { type: "rich_text", rich_text: o.blocker ? rt(o.blocker) : [] },
    "Next Action": { type: "rich_text", rich_text: rt(o.nextAction ?? "Answer the ICP question") },
    "Next Question": { type: "rich_text", rich_text: rt(o.nextQuestion ?? "Who is the ideal customer?") },
    "Last Run Ref": { type: "rich_text", rich_text: lastRun ? [mention(lastRun)] : [] },
    "Last Verified Mutation": { type: "rich_text", rich_text: rt(o.lastVerifiedMutation ?? "SMUT-13") },
    "Last Required Written At": { type: "date", date: { start: o.lastEdited ?? "2030-01-02T00:00:00.000Z" } },
    "Last Verified At": { type: "date", date: { start: o.lastEdited ?? "2030-01-02T00:00:00.000Z" } },
    "Operating Mode": { type: "rich_text", rich_text: o.operatingMode ? rt(o.operatingMode) : [] },
  } };
}

export function extIntent(id: string, effect: string, recordType = "INTENT"): Page {
  return { object: "page", id, archived: false, properties: { Action: { type: "title", title: rt("send") }, "Record Type": { type: "select", select: { name: recordType } }, "Effect Status": { type: "select", select: { name: effect } }, "Approval State": { type: "select", select: { name: "APPROVED" } }, "Action Key": { type: "rich_text", rich_text: rt(`ak-${id.slice(0, 6)}`) } } };
}

export interface ResumeWorld extends World {
  setMetaManifest(o: MetaCursorOpts): void;
  setMetaRuns(rows: Page[]): void;
  setMetaLedger(rows: Page[]): void;
  setMetaGates(rows: Page[]): void;
  removeMetaGates(): void;
  setMetaControlChecks(rows: Page[]): void;
  setMetaRegistry(rows: Page[]): void;
  setMetaInputs(rows: Page[]): void;
  removeMetaInputs(): void;
  removeMetaControlChecks(): void;
  /** Replace SPEC_ROOT children (e.g. adopt a new governing CONTROL version, or add a candidate page). */
  setSpecRoot(blocks: Block[]): void;
  setSalesState(o: SalesStateOpts): void;
  setSalesRuns(rows: Page[]): void;
  setSalesLedger(rows: Page[]): void;
  setSalesExternal(rows: Page[]): void;
}

/** Install META (root A and root B) and SALES (rep A, rep B) control planes into a world map. */
/** Rows registered under a data source get a `parent` so membership checks (cross-runtime) work as in the REST API. */
export function setRowsIn(m: Map<string, unknown>, ds: string, rows: Page[]): void {
  const withParent = rows.map((r) => ({ ...r, parent: r.parent ?? { type: "data_source_id", data_source_id: ds } }));
  m.set(`query:${ds}`, { results: withParent });
  for (const r of withParent) m.set(`page:${r.id}`, r);
}

const T = (names: [string, string][]) => ({ properties: Object.fromEntries(names.map(([n, t]) => [n, { type: t }])) });
export const SCHEMAS = {
  metaRuns: T([["Run", "title"], ["Run ID", "unique_id"], ["Status", "select"], ["Recovery Required", "checkbox"], ["Next Action", "rich_text"], ["Holds", "rich_text"], ["Last Required Written At", "date"], ["Mutation Count", "number"], ["Verified Mutation Count", "number"], ["Attempt Count", "number"], ["Spec Version", "rich_text"], ["META Schema Version", "rich_text"], ["Control Version", "rich_text"], ["Gate Before", "rich_text"], ["Gate After Expected", "rich_text"], ["Gate After Observed", "rich_text"], ["Origin", "select"], ["Harness Plan ID", "rich_text"]]),
  metaLedger: T([["Mutation", "title"], ["Mutation ID", "unique_id"], ["Status", "select"], ["Run Ref", "rich_text"], ["Target Ref", "rich_text"], ["Operation", "select"], ["Harness Plan ID", "rich_text"], ["Idempotency Key", "rich_text"], ["Target Receipt ID", "rich_text"]]),
  metaGates: T([["Gate", "title"], ["Gate Key", "rich_text"], ["Status", "select"], ["Open Blocker", "rich_text"], ["Next Action", "rich_text"], ["Next Question", "rich_text"], ["Last Required Written At", "date"], ["Control Confirmation State", "select"], ["Passed By Run Ref", "rich_text"], ["Confirmed By Control Check Ref", "rich_text"]]),
  metaInputs: T([["Input", "title"], ["Input Key", "rich_text"], ["Gate Key", "rich_text"], ["Question", "rich_text"], ["Answer", "rich_text"], ["State", "select"], ["Source", "select"], ["Run Ref", "rich_text"]]),
  metaRegistry: T([["Resource", "title"], ["Resource Key", "rich_text"], ["Resource URL", "url"], ["Status", "select"], ["Scope", "select"], ["Schema Version", "rich_text"], ["Last Verified", "date"], ["Notes", "rich_text"]]),
  metaControlChecks: T([["Control Check", "title"], ["Control Check ID", "rich_text"], ["Control Version", "rich_text"], ["Checked At", "date"], ["Result", "select"], ["Scope", "rich_text"], ["Canonical Artifact Hash", "rich_text"], ["Mirror Integrity Status", "select"]]),
  salesRuns: T([["Run", "title"], ["Run ID", "unique_id"], ["Status", "select"], ["Recovery Required", "checkbox"], ["Next Action", "rich_text"], ["Holds", "rich_text"], ["Last Required Written At", "date"], ["Mutation Count", "number"], ["Verified Mutation Count", "number"], ["Attempt Count", "number"], ["Sales Contract Version", "rich_text"], ["Schema Version", "rich_text"], ["Gate Before", "rich_text"], ["Gate After Expected", "rich_text"], ["Gate After Observed", "rich_text"], ["Origin", "select"], ["Harness Plan ID", "rich_text"]]),
  salesLedger: T([["Mutation", "title"], ["Mutation ID", "unique_id"], ["Status", "select"], ["Run Ref", "rich_text"], ["Target Ref", "rich_text"], ["Operation", "select"], ["Harness Plan ID", "rich_text"], ["Idempotency Key", "rich_text"], ["Target Receipt ID", "rich_text"]]),
  // Mirrors the live SALES 0.5 External Actions schema observed read-only on the approved canary (2026-09-18).
  salesExt: T([["Action", "title"], ["Record Type", "select"], ["Effect Status", "select"], ["Approval State", "select"], ["Action Key", "rich_text"], ["Action Type", "select"], ["Recipient", "email"], ["Subject / Content Hash", "rich_text"], ["Thread ID / Context", "rich_text"], ["Competent Source ID", "rich_text"], ["Verified", "checkbox"], ["Observed At", "date"], ["Execution Attempt ID", "rich_text"], ["Run Ref", "rich_text"], ["Idempotency Key", "rich_text"]]),
  metaManifest: T([["Name", "title"], ["Root URL", "url"], ["Runtime ID", "rich_text"], ["Spec Root URL", "url"], ["Spec Version", "rich_text"], ["Schema Version", "rich_text"], ["Control Version", "rich_text"], ["Runtime State", "select"], ["Health", "select"], ["Persistence Health", "select"], ["Recovery Required", "checkbox"], ["Current Gate", "rich_text"], ["Current Setup Gate", "rich_text"], ["Current Setup Gate Status", "select"], ["Open Blocker", "rich_text"], ["Next Action", "rich_text"], ["Last Run Ref", "rich_text"], ["Last Verified Mutation", "rich_text"], ["Last Required Written At", "date"], ["Last Verified At", "date"]]),
  salesState: T([["Name", "title"], ["Current Gate", "select"], ["Current Gate Status", "select"], ["Build State", "select"], ["Recovery Required", "checkbox"], ["Persistence Health", "select"], ["Open Blocker", "rich_text"], ["Next Action", "rich_text"], ["Next Question", "rich_text"], ["Last Run Ref", "rich_text"], ["Last Verified Mutation", "rich_text"], ["Last Required Written At", "date"], ["Last Verified At", "date"], ["Operating Mode", "rich_text"]]),
};
export const META_MANIFEST_DS = synthetic("meta-manifest-ds");

export function installControlPlanes(m: Map<string, unknown>): void {
  const db = (id: string, ds: string, title: string) => m.set(`database:${id}`, { object: "database", id, title: rt(title), data_sources: [{ id: ds, name: title }] });
  const setRows = (ds: string, rows: Page[]) => setRowsIn(m, ds, rows);
  for (const rootId of [META_ID.rootA, META_ID.rootB]) {
    const rootChildren = ((m.get(`children:${rootId}`) as { results?: Block[] } | undefined)?.results ?? []).filter((b) => b.type !== "child_database");
    m.set(`children:${rootId}`, list([...rootChildren,
      { id: R.metaRunsDb, type: "child_database", child_database: { title: "META — RUNS" } },
      { id: R.metaLedgerDb, type: "child_database", child_database: { title: "META — MUTATION LEDGER" } },
      { id: R.metaGatesDb, type: "child_database", child_database: { title: "META — GATES" } },
      { id: R.metaChecksDb, type: "child_database", child_database: { title: "META — CONTROL CHECKS" } },
      { id: R.metaRegistryDb, type: "child_database", child_database: { title: "META — RESOURCE REGISTRY" } },
      { id: R.metaInputsDb, type: "child_database", child_database: { title: "META — INPUTS" } },
    ]));
  }
  db(R.metaRunsDb, R.metaRunsDs, "META — RUNS"); db(R.metaLedgerDb, R.metaLedgerDs, "META — MUTATION LEDGER"); db(R.metaGatesDb, R.metaGatesDs, "META — GATES"); db(R.metaChecksDb, R.metaChecksDs, "META — CONTROL CHECKS"); db(R.metaRegistryDb, R.metaRegistryDs, "META — RESOURCE REGISTRY"); db(R.metaInputsDb, R.metaInputsDs, "META — INPUTS");
  m.set(`data_source:${R.metaRunsDs}`, SCHEMAS.metaRuns); m.set(`data_source:${R.metaLedgerDs}`, SCHEMAS.metaLedger); m.set(`data_source:${R.metaGatesDs}`, SCHEMAS.metaGates); m.set(`data_source:${R.metaChecksDs}`, SCHEMAS.metaControlChecks); m.set(`data_source:${R.metaRegistryDs}`, SCHEMAS.metaRegistry);
  setRows(R.metaRegistryDs, []);
  m.set(`data_source:${R.metaInputsDs}`, SCHEMAS.metaInputs);
  setRows(R.metaInputsDs, []);
  // One fresh, in-scope, PASS Control Check under the governing control version (checked after every default write).
  setRows(R.metaChecksDs, [controlCheckRow()]);
  setRows(R.metaRunsDs, [runPage({ id: R.run1, label: "TRUN-1", status: "COMPLETED", lastEdited: "2030-01-01T12:00:00.000Z", nextAction: "Ask the first frame question" })]);
  setRows(R.metaLedgerDs, []);
  setRows(R.metaGatesDs, [gateRow({ id: R.gateM1, key: "T1", status: "OPEN", nextAction: "Ask the first frame question", nextQuestion: "What do you sell?", lastEdited: "2030-01-02T00:00:00.000Z" })]);
  m.set(`page:${META_ID.manifest}`, metaManifestPage());
  m.set(`data_source:${META_MANIFEST_DS}`, SCHEMAS.metaManifest);
  for (const rep of ["rep-a", "rep-b"] as const) {
    const salesRootId = SALES_IDS(rep).root;
    const cp = rep === "rep-a" ? R.salesCp : synthetic("sales-cp-rep-b");
    const ids = rep === "rep-a"
      ? { stateDb: R.salesStateDb, stateDs: R.salesStateDs, stateRow: R.salesStateRow, runsDb: R.salesRunsDb, runsDs: R.salesRunsDs, ledgerDb: R.salesLedgerDb, ledgerDs: R.salesLedgerDs, extDb: R.salesExtDb, extDs: R.salesExtDs, run1: R.salesRun1 }
      : { stateDb: synthetic("sales-state-db-b"), stateDs: synthetic("sales-state-ds-b"), stateRow: synthetic("sales-state-row-b"), runsDb: synthetic("sales-runs-db-b"), runsDs: synthetic("sales-runs-ds-b"), ledgerDb: synthetic("sales-ledger-db-b"), ledgerDs: synthetic("sales-ledger-ds-b"), extDb: synthetic("sales-ext-db-b"), extDs: synthetic("sales-ext-ds-b"), run1: synthetic("sales-run-1-b") };
    const salesRootChildren = ((m.get(`children:${salesRootId}`) as { results?: Block[] } | undefined)?.results ?? []).filter((b) => (b["child_page"] as { title?: string } | undefined)?.title !== "03 — CONTROL PLANE");
    m.set(`children:${salesRootId}`, list([...salesRootChildren, childPage(cp, "03 — CONTROL PLANE")]));
    m.set(`children:${cp}`, list([
      { id: ids.stateDb, type: "child_database", child_database: { title: "OS State" } },
      { id: ids.runsDb, type: "child_database", child_database: { title: "Runs" } },
      { id: ids.ledgerDb, type: "child_database", child_database: { title: "Mutation Ledger" } },
      { id: ids.extDb, type: "child_database", child_database: { title: "External Actions" } },
    ]));
    db(ids.stateDb, ids.stateDs, "OS State"); db(ids.runsDb, ids.runsDs, "Runs"); db(ids.ledgerDb, ids.ledgerDs, "Mutation Ledger"); db(ids.extDb, ids.extDs, "External Actions");
    m.set(`data_source:${ids.runsDs}`, SCHEMAS.salesRuns); m.set(`data_source:${ids.ledgerDs}`, SCHEMAS.salesLedger); m.set(`data_source:${ids.extDs}`, SCHEMAS.salesExt); m.set(`data_source:${ids.stateDs}`, SCHEMAS.salesState);
    const stateRow = salesStatePage({ lastRunId: ids.run1 });
    setRows(ids.stateDs, [{ ...stateRow, id: ids.stateRow }]);
    setRows(ids.runsDs, [runPage({ id: ids.run1, label: "SRUN-1", status: "COMPLETED", lane: "SALES", lastEdited: "2030-01-01T12:00:00.000Z" })]);
    setRows(ids.ledgerDs, []);
    // One resolved (SENT) intent per rep: a legitimate UPDATE target that never counts as unresolved.
    setRows(ids.extDs, [extIntent(SALES_EXT_ROW(rep), "SENT")]);
  }
}
export const SALES_EXT_ROW = (rep: "rep-a" | "rep-b") => synthetic(`sales-ext-row-${rep}`);
export const SALES_EXT_DS = (rep: "rep-a" | "rep-b") => (rep === "rep-a" ? R.salesExtDs : synthetic("sales-ext-ds-b"));

export function buildResumeWorld(): ResumeWorld {
  const w = buildWorld();
  const m = w.map;
  const setRows = (ds: string, rows: Page[]) => setRowsIn(m, ds, rows);
  return {
    ...w,
    setMetaManifest(o) { m.set(`page:${META_ID.manifest}`, metaManifestPage(o)); },
    setMetaRuns(rows) { setRows(R.metaRunsDs, rows); },
    setMetaLedger(rows) { setRows(R.metaLedgerDs, rows); },
    setMetaGates(rows) { setRows(R.metaGatesDs, rows); },
    removeMetaGates() { m.set(`children:${META_ID.rootA}`, list(((m.get(`children:${META_ID.rootA}`) as { results: Block[] }).results).filter((b) => b.id !== R.metaGatesDb))); },
    setMetaControlChecks(rows) { setRows(R.metaChecksDs, rows); },
    setMetaRegistry(rows) { setRows(R.metaRegistryDs, rows); },
    setMetaInputs(rows) { setRows(R.metaInputsDs, rows); },
    removeMetaInputs() { m.set(`children:${META_ID.rootA}`, list(((m.get(`children:${META_ID.rootA}`) as { results: Block[] }).results).filter((b) => b.id !== R.metaInputsDb))); },
    removeMetaControlChecks() { m.set(`children:${META_ID.rootA}`, list(((m.get(`children:${META_ID.rootA}`) as { results: Block[] }).results).filter((b) => b.id !== R.metaChecksDb))); },
    setSpecRoot(blocks) { m.set(`children:${META_ID.specRoot}`, list(blocks)); },
    setSalesState(o) { setRows(R.salesStateDs, [salesStatePage(o)]); },
    setSalesRuns(rows) { setRows(R.salesRunsDs, rows); },
    setSalesLedger(rows) { setRows(R.salesLedgerDs, rows); },
    setSalesExternal(rows) { setRows(R.salesExtDs, rows); },
  };
}
