/**
 * PT-INST-011..020 — the copied MASTER payload is hostile, and the governing adapter is the only authority.
 *
 * The assigned clone carries the MASTER's Registry rows (wrong Resource Type, Status already RESOLVED, Scope
 * MASTER, Notes holding another rep's PII), a Root URL pointing at the MASTER, a copied Sales Contract URL and a
 * copied Last Run pointer. None of it may be read as truth, dereferenced, or echoed back to the seller.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInstallWorld } from "../unit/install-fixtures.ts";
import type { NotionReadClient } from "../../src/notion/readClient.ts";
import type { Intent } from "../../src/plans/prepare.ts";
import { inspectInstallBootstrap, installManifestTemplate } from "../../src/install/bootstrap.ts";
import { resolveRuntimeFor } from "../../src/tools/handlers.ts";
import { SALES_CONTROL_PLANE_05, SALES_CONTROL_PLANE_06 } from "../../src/versions/adapters/controlPlane.ts";
import { REP_A } from "../unit/sales-fixtures.ts";
import { boundHandle, detail, installerIntent, mappingIntent, prepare, resume, result, writerOf } from "./drive.ts";

/** The structural inspection the server installer runs for this world's assignment (what it maps and writes). */
async function inspection(w: ReturnType<typeof buildInstallWorld>) {
  const resolved = await resolveRuntimeFor(w.deps, REP_A, "VERTIGO", "SALES");
  assert.equal(resolved.kind, "RESOLVED");
  return inspectInstallBootstrap(w.deps.notion, (resolved as Extract<typeof resolved, { kind: "RESOLVED" }>).runtime);
}

const PII = "foreign-rep@example.invalid";

/** Records every page id the harness dereferences, so "never followed" is proven, not asserted by inspection. */
function watchReads(w: ReturnType<typeof buildInstallWorld>): string[] {
  const seen: string[] = [];
  const inner = w.deps.notion;
  const spy: NotionReadClient = {
    retrievePage: (id) => { seen.push(id); return inner.retrievePage(id); },
    retrieveDatabase: (id) => inner.retrieveDatabase(id),
    retrieveDataSource: (id) => inner.retrieveDataSource(id),
    retrieveBlockChildren: (id, cursor) => inner.retrieveBlockChildren(id, cursor),
    queryDataSource: (id, filter, cursor) => inner.queryDataSource(id, filter, cursor),
  };
  (w.deps as { notion: NotionReadClient }).notion = spy;
  return seen;
}

/* ─────────────────────────── PT-INST-011: copied pointers are never dereferenced ─────────────────────────── */

test("PT-INST-011/a: the installer never follows the copied MASTER root, Contract URL or Last Run pointer", async () => {
  const w = buildInstallWorld();
  const seen = watchReads(w);
  const handle = await boundHandle(w);
  const resumed = await resume(w, handle);
  assert.equal(resumed.code, "RESUMED", detail(resumed));

  assert.ok(!seen.includes(w.ids.foreignMaster), `the copied MASTER root was dereferenced: ${w.ids.foreignMaster}`);
  // The copied Contract URL and Last Run pages do not exist in this fixture; had they been followed, the
  // resolver would have attached the usual unreadable-pointer warnings. It attaches none.
  const warnings = (resumed.warnings ?? []).join(" | ");
  assert.doesNotMatch(warnings, /contract_page_unreadable/);
  assert.doesNotMatch(warnings, /last_run_unreadable/);
  assert.match(warnings, /Les données copiées et l'historique restent isolés pendant l'installation/);
  // Nothing the server wrote targets or names a copied pointer.
  assert.ok(writerOf(w).writes.length > 0, "the installer wrote nothing");
  for (const x of writerOf(w).writes) assert.doesNotMatch(`${x.target} ${JSON.stringify(x.properties)}`, new RegExp(w.ids.foreignMaster), "a server write reached the copied MASTER");
});

test("PT-INST-011/b: no copied PII ever reaches an envelope", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const bound = JSON.stringify(await resume(w, handle));
  assert.doesNotMatch(bound, new RegExp(PII), "copied Notes PII leaked into the installer envelope");
  assert.doesNotMatch(bound, /copied secret/);

  const prepared = await prepare(w, handle, await installerIntent(w, handle));
  assert.equal(prepared.code, "PLAN_PREPARED", detail(prepared));
  assert.doesNotMatch(JSON.stringify(prepared), new RegExp(PII));
});

/* ─────────────────────────── PT-INST-012: the mapping is contract-derived, not copied ─────────────────────────── */

test("PT-INST-012/a: the derived mapping uses the contract's object type and exact path, not the copied Resource Type", async () => {
  const w = buildInstallWorld();
  const candidates = (await inspection(w)).mapping;
  const contract = SALES_CONTROL_PLANE_05.installContract?.physicalResources ?? [];

  for (const entry of candidates) {
    const spec = contract.find((r) => r.registryKey === entry.key);
    assert.ok(spec, `${entry.key} is not a governing contract key`);
    // The fixture deliberately seeds every copied Resource Type as the OPPOSITE of the contract's.
    assert.equal(entry.object_type, spec.objectType, `${entry.key} followed the copied Resource Type`);
    assert.equal(entry.exact_path, ["ROOT", ...spec.path].join(" / "));
    assert.equal(entry.candidate_url, `https://www.notion.so/${w.ids.objectRefs[spec.key]}`);
  }
  // What the server then writes into each Registry row is that derivation, never the copied type.
  const resumed = await resume(w, await boundHandle(w));
  assert.equal(resumed.code, "RESUMED", detail(resumed));
  let checked = 0;
  for (const entry of candidates) {
    const spec = contract.find((r) => r.registryKey === entry.key);
    const written = writerOf(w).writes.find((x) => x.target === w.ids.registryRows[entry.key]?.replace(/-/g, "") && "Resource Type" in x.properties);
    if (!written) continue;
    checked += 1;
    assert.deepEqual(written.properties["Resource Type"], { select: { name: spec?.objectType } }, `${entry.key} was written with a copied Resource Type`);
  }
  assert.ok(checked > 0, "no Registry mapping write was observed in the first batch");
});

test("PT-INST-012/b: the derived mapping normalizes copied metadata and demands HOLD until proven", async () => {
  const w = buildInstallWorld();
  const intent = await mappingIntent(w);
  assert.equal(intent.action_class, "INSTALL");
  assert.ok(intent.mutations.length > 0);
  for (const m of intent.mutations) {
    assert.equal(m.logical_resource_key, "SALES:INSTALL_REGISTRY");
    assert.equal(m.operation, "UPDATE");
    assert.deepEqual(Object.keys(m.desired_changes).sort(), ["Notes", "Required", "Resource Type", "Resource URL", "Scope", "Status"]);
    assert.equal(m.desired_changes["Status"], "HOLD", "a copied RESOLVED status was adopted instead of re-proved");
    const spec = SALES_CONTROL_PLANE_05.installContract?.physicalResources.find((r) => r.registryKey === m.record_selector.natural_key);
    assert.ok(spec);
    assert.equal(m.desired_changes["Required"], spec.required);
    assert.equal(m.desired_changes["Resource Type"], spec.objectType);
    assert.equal(m.desired_changes["Scope"], spec.objectType === "DATABASE" ? "READ_WRITE" : "READ_ONLY");
    assert.doesNotMatch(String(m.desired_changes["Notes"]), /foreign|@/i);
  }
});

test("PT-INST-012/c: the connector capabilities are separate, unverified capabilities — not install resources", async () => {
  const w = buildInstallWorld();
  const caps = (await inspection(w)).connector_capabilities;
  assert.deepEqual(caps.map((c) => c.key).sort(), ["EMAIL_TRACKER", "GMAIL"]);
  for (const c of caps) assert.equal(c.state, "UNKNOWN", "a connector was claimed verified by the structural install");
  // A connector is a capability, never a physical resource: no capability key may appear as a mapped Registry
  // key. (GMAIL_TRACKING_POLICY is a governing POLICY PAGE inside the clone and is legitimately mapped; the
  // capability keys GMAIL / EMAIL_TRACKER are not, and no mapping may carry a connector state.)
  const intent = await mappingIntent(w);
  const mapped = new Set(intent.mutations.map((m) => m.record_selector.natural_key));
  for (const c of caps) assert.ok(!mapped.has(c.key), `connector capability ${c.key} was mapped as a physical resource`);
  assert.ok(!intent.mutations.some((m) => "state" in m.desired_changes || "Capability Status" in m.desired_changes), "a connector state leaked into the structural mapping");
});

/* ─────────────────────────── PT-INST-013: arbitrary roots and mappings are refused ─────────────────────────── */

const tamper = (intent: Intent, index: number, changes: Record<string, unknown>): Intent => ({
  ...intent,
  mutations: intent.mutations.map((m, i) => (i === index ? { ...m, desired_changes: { ...m.desired_changes, ...changes } } : m)),
});

test("PT-INST-013/a: a mapping retargeted at any object outside the contract derivation is refused", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const intent = await installerIntent(w, handle);
  const attacked = tamper(intent, 0, { "Resource URL": `https://www.notion.so/${w.ids.foreignMaster}` });
  const e = await prepare(w, handle, attacked);
  assert.equal(e.code, "HOLD_INSTALL_REQUIRED", detail(e));
  assert.match(detail(e), /does not target its unique contract-derived clone resource/);
});

test("PT-INST-013/b: a mapping that pre-declares RESOLVED, adds a field, drops a key or duplicates one is refused", async () => {
  const w = buildInstallWorld();
  const handle = await boundHandle(w);
  const base = await installerIntent(w, handle);

  const cases: Array<[string, Intent, RegExp]> = [
    ["pre-declared RESOLVED", tamper(base, 0, { Status: "RESOLVED" }), /must remain HOLD until the bounded readback verification completes/],
    ["extra field", tamper(base, 0, { Injected: "trust me" }), /must update exactly the contract-derived/],
    ["wrong metadata", tamper(base, 0, { Scope: "EXTERNAL" }), /Scope does not match the governing contract metadata/],
    ["dropped key", { ...base, mutations: base.mutations.slice(1) }, /required contract mapping .* is absent/],
    ["duplicated key", { ...base, mutations: [...base.mutations, base.mutations[0] as Intent["mutations"][number]] }, /is duplicated/],
    ["wrong action class", { ...base, action_class: "COMMIT" }, /requires action_class INSTALL/],
  ];
  for (const [label, intent, expected] of cases) {
    const e = await prepare(w, handle, intent);
    assert.equal(e.code, "HOLD_INSTALL_REQUIRED", `${label}: ${detail(e)}`);
    assert.match(detail(e), expected, label);
  }
});

/* ─────────────────────────── PT-INST-014: structural refusals from the governing contract ─────────────────────────── */

test("PT-INST-014/a: a missing, duplicated or wrongly-typed contract resource blocks the install", async () => {
  type Break = NonNullable<NonNullable<Parameters<typeof buildInstallWorld>[0]>["breakResource"]>;
  const cases: Array<[Break, RegExp]> = [
    [{ key: "ACCOUNTS", how: "MISSING" }, /exact path .* has 0 matches/],
    [{ key: "ACCOUNTS", how: "DUPLICATE" }, /has 2 matches/],
    [{ key: "ACCOUNTS", how: "WRONG_TYPE" }, /is PAGE, expected DATABASE/],
    [{ key: "BOOT_CARD", how: "WRONG_TYPE" }, /is DATABASE, expected PAGE/],
    [{ key: "BOOT_CARD", how: "DUPLICATE" }, /has 2 matches/],
  ];
  for (const [breakResource, expected] of cases) {
    const w = buildInstallWorld({ breakResource });
    const resumed = await resume(w, await boundHandle(w));
    assert.equal(resumed.code, "HOLD_INSTALL_REQUIRED", `${JSON.stringify(breakResource)}: ${detail(resumed)}`);
    assert.match(detail(resumed), expected, JSON.stringify(breakResource));
  }
});

test("PT-INST-014/b: a database that violates the contract's minimum schema blocks the install", async () => {
  const w = buildInstallWorld({ breakResource: { key: "RUNS", how: "SCHEMA" } });
  const resumed = await resume(w, await boundHandle(w));
  assert.equal(resumed.code, "HOLD_INSTALL_REQUIRED", detail(resumed));
  assert.match(detail(resumed), /RUNS: schema property .* expected/);
});

test("PT-INST-014/c: a duplicated or absent Registry key for a contract resource blocks the install", async () => {
  const dup = buildInstallWorld();
  dup.addRegistryRow("dup-accounts", { Key: "ACCOUNTS", Required: false, "Resource URL": "https://www.notion.so/deadbeef", "Resource Type": "PAGE", Status: "RESOLVED" });
  const a = await resume(dup, await boundHandle(dup));
  assert.equal(a.code, "HOLD_INSTALL_REQUIRED", detail(a));
  assert.match(detail(a), /Registry must contain exactly one contract key ACCOUNTS, found 2/);

  const gone = buildInstallWorld();
  gone.removeRegistryRow("ACCOUNTS");
  const b = await resume(gone, await boundHandle(gone));
  assert.equal(b.code, "HOLD_INSTALL_REQUIRED", detail(b));
  assert.match(detail(b), /Registry must contain exactly one contract key ACCOUNTS, found 0/);
});

test("PT-INST-014/d: an unreadable Registry fails closed and never yields a partial mapping", async () => {
  const w = buildInstallWorld();
  w.map.delete(`data_source:${w.ids.registryDs}`);
  const resumed = await resume(w, await boundHandle(w));
  assert.equal(resumed.status, "HOLD", detail(resumed));
  assert.equal(result(resumed)["installation"], undefined);
});

test("PT-INST-014/e: every select value written by installation must already exist in the live schema", async () => {
  const cases = [
    { key: "REGISTRY" as const, field: "Resource Type", option: "PAGE" },
    { key: "REGISTRY" as const, field: "Resource Type", option: "DATABASE" },
    { key: "REGISTRY" as const, field: "Status", option: "MISSING" },
    { key: "REGISTRY" as const, field: "Status", option: "EXPECTED" },
    { key: "REGISTRY" as const, field: "Status", option: "RESOLVED" },
    { key: "REGISTRY" as const, field: "Scope", option: "READ_WRITE" },
    { key: "REGISTRY" as const, field: "Scope", option: "READ_ONLY" },
    { key: "INSTANCE_MANIFEST" as const, field: "Install State", option: "SETUP" },
    { key: "INSTANCE_MANIFEST" as const, field: "Instance Status", option: "ACTIVE" },
    { key: "INSTANCE_MANIFEST" as const, field: "Tracker Access", option: "UNKNOWN" },
    { key: "INSTANCE_MANIFEST" as const, field: "Capability Status", option: "UNKNOWN" },
    { key: "RUNS" as const, field: "Status", option: "RUNNING" },
    { key: "RUNS" as const, field: "Origin", option: "PLUGIN" },
    { key: "MUTATION_LEDGER" as const, field: "Status", option: "VERIFIED" },
    { key: "MUTATION_LEDGER" as const, field: "Operation", option: "UPSERT" },
    { key: "CAPABILITY_PROFILE" as const, field: "State", option: "READ_VERIFIED" },
  ];
  for (const breakSelectOption of cases) {
    const w = buildInstallWorld({ breakSelectOption });
    const resumed = await resume(w, await boundHandle(w));
    assert.equal(resumed.code, "HOLD_INSTALL_REQUIRED", `${JSON.stringify(breakSelectOption)}: ${detail(resumed)}`);
    assert.match(detail(resumed), new RegExp(`lacks required option ${breakSelectOption.option}`));
    const binding = await w.deps.store.plans.listByRuntime("VERTIGO", "SALES", "7");
    assert.equal(binding.length, 0, "a schema-option refusal still created a plan");
  }
});

test("PT-INST-014/e2: the 0.5 install contract uses the canonical Notion build and persistence vocabularies", () => {
  const resources = SALES_CONTROL_PLANE_05.installContract?.physicalResources ?? [];
  const manifest = resources.find((resource) => resource.key === "INSTANCE_MANIFEST");
  const state = resources.find((resource) => resource.key === "OS_STATE");
  assert.deepEqual(manifest?.requiredSelectOptions?.["Persistence Health"], [
    "UNKNOWN", "PASS", "HOLD_NOTION_WRITE", "HOLD_PARTIAL_COMMIT", "HOLD_REBIND_REQUIRED", "HOLD_CONTROL_CONFIRMATION",
  ]);
  assert.deepEqual(state?.requiredSelectOptions?.["Build State"], [
    "B0_DISCOVERY", "B1_OFFER", "B2_ICP", "B3_DATA", "B4_QUALIFICATION", "B5_OUTREACH", "B6_AUTHORITY", "B7_DRY_RUN", "READY", "HOLD",
  ]);
  assert.deepEqual(state?.requiredSelectOptions?.["Persistence Health"], manifest?.requiredSelectOptions?.["Persistence Health"]);
});

test("PT-INST-014/f: a missing business-critical column blocks activation before any plan", async () => {
  const w = buildInstallWorld();
  const accountDb = w.map.get(`database:${w.ids.objectRefs["ACCOUNTS"]}`) as { data_sources: Array<{ id: string }> };
  const ds = accountDb.data_sources[0]?.id as string;
  const source = w.map.get(`data_source:${ds}`) as { object: string; id: string; properties: Record<string, unknown> };
  const { Qualification: _removed, ...properties } = source.properties;
  w.map.set(`data_source:${ds}`, { ...source, properties });
  const resumed = await resume(w, await boundHandle(w));
  assert.equal(resumed.code, "HOLD_INSTALL_REQUIRED", detail(resumed));
  assert.match(detail(resumed), /ACCOUNTS: schema property Qualification is MISSING, expected select/);
});

test("PT-INST-014/g: every BUSINESS control-plane field is structural, not an optional best effort", async () => {
  const cases = [
    ["RUNS", "Harness Plan ID"],
    ["MUTATION_LEDGER", "Harness Plan ID"],
    ["MUTATION_LEDGER", "Target Receipt ID"],
    ["OS_STATE", "Last Run Ref"],
    ["OS_STATE", "Last Verified Mutation"],
    ["OS_STATE", "Last Verified At"],
    ["CAPABILITY_PROFILE", "Evidence Ref"],
  ] as const;
  for (const [key, field] of cases) {
    const w = buildInstallWorld();
    const db = w.map.get(`database:${w.ids.objectRefs[key]}`) as { data_sources: Array<{ id: string }> };
    const ds = db.data_sources[0]?.id as string;
    const source = w.map.get(`data_source:${ds}`) as { properties: Record<string, unknown> };
    const properties = { ...source.properties };
    delete properties[field];
    w.map.set(`data_source:${ds}`, { ...source, properties });
    const resumed = await resume(w, await boundHandle(w));
    assert.equal(resumed.code, "HOLD_INSTALL_REQUIRED", `${key}.${field}: ${detail(resumed)}`);
    assert.match(detail(resumed), new RegExp(`${key}: schema property ${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is MISSING`));
  }
});

test("PT-INST-014/h: no backend Gmail expectation clears copied template identity", async () => {
  const w = buildInstallWorld({ omitExpectedGmailIdentity: true, manifest: { "Gmail Identity": PII, "Gmail Verified": true } });
  const resolved = await resolveRuntimeFor(w.deps, REP_A, "VERTIGO", "SALES");
  assert.equal(resolved.kind, "RESOLVED");
  if (resolved.kind !== "RESOLVED") return;
  const expected = installManifestTemplate(REP_A, resolved.runtime);
  assert.equal(expected["Gmail Identity"], null, "copied mailbox survived an absent backend identity claim");
  assert.equal(expected["Gmail Verified"], false, "copied Gmail verification survived installation");
  assert.doesNotMatch(JSON.stringify(expected), new RegExp(PII));
});

test("PT-INST-014/i: the 0.6 contract inspects Capability Profile, every GTM container and Calendar before KNOWN", async () => {
  const complete = buildInstallWorld({ controlPlane: SALES_CONTROL_PLANE_06 });
  const resumed = await resume(complete, await boundHandle(complete));
  assert.equal(resumed.code, "RESUMED", detail(resumed));
  const caps = (await inspection(complete)).connector_capabilities;
  assert.deepEqual(caps.map((c) => `${c.key}:${c.requirement}`).sort(), ["EMAIL_TRACKER:OPTIONAL", "GMAIL:REQUIRED", "GOOGLE_CALENDAR:REQUIRED"]);

  for (const key of ["CAPABILITY_PROFILE", "CAMPAIGNS", "EXPOSURES", "GTM_SNAPSHOTS"] as const) {
    const broken = buildInstallWorld({ controlPlane: SALES_CONTROL_PLANE_06, breakResource: { key, how: "SCHEMA" } });
    const held = await resume(broken, await boundHandle(broken));
    assert.equal(held.code, "HOLD_INSTALL_REQUIRED", `${key}: ${detail(held)}`);
    assert.match(detail(held), new RegExp(`${key}: schema property`));
  }
});

test("PT-INST-014/j: one structural inspection reads each shared block tree at most once", async () => {
  const w = buildInstallWorld();
  const counts = new Map<string, number>();
  const inner = w.deps.notion;
  const notion: NotionReadClient = {
    retrievePage: (id) => inner.retrievePage(id),
    retrieveDatabase: (id) => inner.retrieveDatabase(id),
    retrieveDataSource: (id) => inner.retrieveDataSource(id),
    retrieveBlockChildren: (id, cursor) => {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return inner.retrieveBlockChildren(id, cursor);
    },
    queryDataSource: (id, filter, cursor) => inner.queryDataSource(id, filter, cursor),
  };
  const deps = { ...w.deps, notion };
  const resolved = await resolveRuntimeFor(deps, REP_A, "VERTIGO", "SALES");
  assert.equal(resolved.kind, "RESOLVED");
  if (resolved.kind !== "RESOLVED") return;
  counts.clear();
  const inspection = await inspectInstallBootstrap(notion, resolved.runtime);
  assert.deepEqual(inspection.violations, []);
  assert.ok(counts.size > 1, "the contract should traverse more than one structural holder");
  assert.equal(Math.max(...counts.values()), 1, "a shared block tree was read repeatedly in one inspection");
});
