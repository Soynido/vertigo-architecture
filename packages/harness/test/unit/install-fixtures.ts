/** Complete synthetic Personal SALES clone used only by INSTALL_ONLY acceptance tests. */
import { InMemoryPrincipalRegistry, type Principal } from "../../src/auth/principal.ts";
import { loadConfig } from "../../src/config/index.ts";
import { FixtureNotionReadClient } from "../../src/notion/readClient.ts";
import type { Block, Page, PageProperty, RichText } from "../../src/notion/shapes.ts";
import { InMemorySalesRuntimeRegistry, type SalesRuntimeEntry } from "../../src/registry/salesRuntimes.ts";
import { createMemoryStore } from "../../src/store/memory.ts";
import type { HarnessDeps } from "../../src/tools/handlers.ts";
import { SALES_CONTROL_PLANE_05, type ControlPlaneGrammar, type InstallPhysicalResource } from "../../src/versions/adapters/controlPlane.ts";
import { SALES_OPERATIONS_REQUIREMENTS, salesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import { mention, synthetic, text } from "./meta-fixtures.ts";
import { REP_A, SGRAMMAR, SV } from "./sales-fixtures.ts";

const rt = (value: string): RichText[] => value ? [text(value)] : [];
const list = (results: Block[]) => ({ results, has_more: false, next_cursor: null });
const pageBlock = (id: string, title: string): Block => ({ id, type: "child_page", child_page: { title } });
const dbBlock = (id: string, title: string): Block => ({ id, type: "child_database", child_database: { title } });

function property(type: string, value: unknown): PageProperty {
  switch (type) {
    case "title": return { type, title: rt(String(value ?? "")) };
    case "rich_text": return { type, rich_text: rt(String(value ?? "")) };
    case "url": return { type, url: value ? String(value) : null };
    case "email": return { type, email: value ? String(value) : null };
    case "checkbox": return { type, checkbox: Boolean(value) };
    case "select": return { type, select: value ? { name: String(value) } : null };
    case "date": return { type, date: value ? { start: String(value) } : null };
    default: return { type: "rich_text", rich_text: rt(String(value ?? "")) };
  }
}

export interface InstallWorld {
  readonly map: Map<string, unknown>;
  readonly deps: HarnessDeps;
  readonly ids: {
    readonly root: string;
    readonly foreignMaster: string;
    readonly manifestDb: string;
    readonly manifestDs: string;
    readonly manifestRow: string;
    readonly stateDb: string;
    readonly stateDs: string;
    readonly stateRow: string;
    readonly registryDb: string;
    readonly registryDs: string;
    readonly registryRows: Readonly<Record<string, string>>;
    readonly objectRefs: Readonly<Record<string, string>>;
  };
  setRegistry(entries: readonly SalesRuntimeEntry[]): void;
  lookupRegistry(): Promise<SalesRuntimeEntry | undefined>;
  /** Direct fixture surgery used by the adversarial cases (a human editing the clone mid-install). */
  setRegistryRow(key: string, fields: Readonly<Record<string, unknown>>): void;
  addRegistryRow(id: string, fields: Readonly<Record<string, unknown>>): string;
  removeRegistryRow(key: string): void;
  setManifest(fields: Readonly<Record<string, unknown>>): void;
  setState(fields: Readonly<Record<string, unknown>>): void;
}

export interface InstallWorldOptions {
  readonly controlPlane?: ControlPlaneGrammar;
  readonly principal?: Principal;
  readonly rootTitle?: string;
  readonly registryStatus?: SalesRuntimeEntry["status"];
  /** Backend-assigned instance id; `undefined` removes the claim entirely. */
  readonly expectedInstanceId?: string | undefined;
  readonly omitExpectedInstanceId?: boolean;
  /** Omits the backend mailbox claim so copied Manifest identity must be cleared, never retained. */
  readonly omitExpectedGmailIdentity?: boolean;
  readonly objectivePackageRef?: string;
  /** Structural sabotage applied while the clone is built (one contract key). */
  readonly breakResource?: { readonly key: string; readonly how: "MISSING" | "DUPLICATE" | "WRONG_TYPE" | "SCHEMA" };
  /** Removes one otherwise valid select option from the live data-source schema. */
  readonly breakSelectOption?: { readonly key: string; readonly field: string; readonly option: string };
  readonly manifest?: Readonly<Record<string, unknown>>;
}

export function buildInstallWorld(options: InstallWorldOptions = {}): InstallWorld {
  const principal = options.principal ?? REP_A;
  const map = new Map<string, unknown>();
  const root = synthetic("install-clone-root");
  const foreignMaster = synthetic("copied-foreign-master-root");
  map.set(`page:${root}`, { object: "page", id: root, archived: false, properties: { title: property("title", options.rootTitle ?? "REP A — SALES AGENT OS") } });

  const childMap = new Map<string, Block[]>();
  const appendChild = (parent: string, block: Block) => {
    const rows = childMap.get(parent) ?? [];
    if (!rows.some((b) => b.id === block.id)) childMap.set(parent, [...rows, block]);
  };
  const pagesByPath = new Map<string, string>();
  const ensurePagePath = (path: readonly string[]): string => {
    let parent = root;
    const parts: string[] = [];
    for (const segment of path) {
      parts.push(segment);
      const key = parts.join(" / ");
      let id = pagesByPath.get(key);
      if (!id) {
        id = synthetic(`install-page:${key}`);
        pagesByPath.set(key, id);
        appendChild(parent, pageBlock(id, segment));
        map.set(`page:${id}`, { object: "page", id, archived: false, properties: { title: property("title", segment) } });
      }
      parent = id;
    }
    return parent;
  };

  const databaseIds = new Map<string, { db: string; ds: string }>();
  const objectRefs: Record<string, string> = {};
  const controlPlane = options.controlPlane ?? SALES_CONTROL_PLANE_05;
  const installResources = controlPlane.installContract?.physicalResources ?? [];
  const sabotage = (key: string, how: InstallWorldOptions["breakResource"] extends undefined ? never : NonNullable<InstallWorldOptions["breakResource"]>["how"]): boolean =>
    options.breakResource?.key === key && options.breakResource.how === how;
  for (const spec of installResources) {
    if (spec.path.length === 0) { objectRefs[spec.key] = root; continue; }
    if (sabotage(spec.key, "MISSING")) continue;
    const title = spec.path[spec.path.length - 1] as string;
    if (spec.objectType === "PAGE") {
      if (sabotage(spec.key, "WRONG_TYPE")) {
        // A database sits where the contract fixes a page.
        const parent = ensurePagePath(spec.path.slice(0, -1));
        const db = synthetic(`install-wrongtype:${spec.key}`);
        const ds = synthetic(`install-wrongtype-ds:${spec.key}`);
        appendChild(parent, dbBlock(db, title));
        map.set(`database:${db}`, { object: "database", id: db, title: rt(title), data_sources: [{ id: ds, name: title }] });
        map.set(`data_source:${ds}`, { object: "data_source", id: ds, properties: { Name: { type: "title" } } });
        map.set(`query:${ds}`, { results: [], has_more: false, next_cursor: null });
        continue;
      }
      objectRefs[spec.key] = ensurePagePath(spec.path);
      if (sabotage(spec.key, "DUPLICATE")) {
        const parent = ensurePagePath(spec.path.slice(0, -1));
        const twin = synthetic(`install-duplicate:${spec.key}`);
        appendChild(parent, pageBlock(twin, title));
        map.set(`page:${twin}`, { object: "page", id: twin, archived: false, properties: { title: property("title", title) } });
      }
      continue;
    }
    const parent = ensurePagePath(spec.path.slice(0, -1));
    const pathKey = spec.path.join(" / ");
    if (sabotage(spec.key, "WRONG_TYPE")) {
      // A plain page sits where the contract fixes a database.
      const twin = synthetic(`install-wrongtype:${spec.key}`);
      appendChild(parent, pageBlock(twin, title));
      map.set(`page:${twin}`, { object: "page", id: twin, archived: false, properties: { title: property("title", title) } });
      continue;
    }
    const db = synthetic(`install-db:${pathKey}`);
    const ds = synthetic(`install-ds:${pathKey}`);
    databaseIds.set(spec.key, { db, ds });
    objectRefs[spec.key] = db;
    appendChild(parent, dbBlock(db, title));
    map.set(`database:${db}`, { object: "database", id: db, title: rt(title), data_sources: [{ id: ds, name: title }] });
    const required = spec.requiredProperties ?? {};
    const titleName = Object.entries(required).find(([, type]) => type === "title")?.[0] ?? "Name";
    type FixtureSchemaProperty = { type: string; select?: { options: Array<{ name: string }> }; multi_select?: { options: Array<{ name: string }> } };
    const schema: Record<string, FixtureSchemaProperty> = { [titleName]: { type: "title" } };
    const optionsFor = (field: string): string[] => {
      const governed = spec.requiredSelectOptions?.[field];
      if (governed) return [...governed];
      if (spec.key === "REGISTRY") {
        if (field === "Resource Type") return ["PAGE", "DATABASE", "DATA_SOURCE", "CONNECTOR", "EXTERNAL_SOURCE"];
        if (field === "Status") return ["EXPECTED", "RESOLVED", "MISSING", "HOLD"];
        if (field === "Scope") return ["READ_ONLY", "READ_WRITE", "WRITE_ONLY", "EXTERNAL"];
      }
      if (spec.key === "INSTANCE_MANIFEST") {
        if (field === "Install State") return ["UNBOUND", "SETUP", "READY", "HOLD"];
        if (field === "Instance Status") return ["ACTIVE", "PAUSED", "RETIRED"];
        if (field === "Tracker Access") return ["NONE", "UNKNOWN", "ACCESSIBLE", "PARTIAL", "INACCESSIBLE"];
        if (field === "Capability Status") return ["UNKNOWN", "PARTIAL", "PASS", "FAIL"];
      }
      return [];
    };
    for (const [name, type] of Object.entries(required)) {
      let selectOptions = optionsFor(name);
      if (options.breakSelectOption?.key === spec.key && options.breakSelectOption.field === name) selectOptions = selectOptions.filter((x) => x !== options.breakSelectOption?.option);
      schema[name] = type === "select" ? { type, select: { options: selectOptions.map((x) => ({ name: x })) } } : { type };
    }
    // SCHEMA sabotage: the contract's minimum schema is violated by a property of the wrong type.
    if (sabotage(spec.key, "SCHEMA")) {
      const victim = Object.entries(required).find(([, type]) => type !== "title")?.[0];
      if (victim) schema[victim] = { type: "rich_text" === schema[victim]?.type ? "number" : "rich_text" };
    }
    map.set(`data_source:${ds}`, { object: "data_source", id: ds, properties: schema });
    map.set(`query:${ds}`, { results: [], has_more: false, next_cursor: null });
    if (sabotage(spec.key, "DUPLICATE")) {
      const twinDb = synthetic(`install-duplicate-db:${spec.key}`);
      const twinDs = synthetic(`install-duplicate-ds:${spec.key}`);
      appendChild(parent, dbBlock(twinDb, title));
      map.set(`database:${twinDb}`, { object: "database", id: twinDb, title: rt(title), data_sources: [{ id: twinDs, name: title }] });
      map.set(`data_source:${twinDs}`, { object: "data_source", id: twinDs, properties: schema });
      map.set(`query:${twinDs}`, { results: [], has_more: false, next_cursor: null });
    }
  }
  for (const [holder, children] of childMap) map.set(`children:${holder}`, list(children));
  for (const id of pagesByPath.values()) if (!map.has(`children:${id}`)) map.set(`children:${id}`, list([]));
  if (!map.has(`children:${root}`)) map.set(`children:${root}`, list([]));

  const manifest = databaseIds.get("INSTANCE_MANIFEST") as { db: string; ds: string };
  const manifestRow = synthetic("install-manifest-current");
  const manifestPage: Page = {
    object: "page", id: manifestRow, archived: false, last_edited_time: "2030-01-01T00:00:00.000Z",
    parent: { type: "data_source_id", data_source_id: manifest.ds },
    properties: {
      Name: property("title", "CURRENT"),
      "Root URL": property("url", `https://www.notion.so/${foreignMaster}`),
      "Instance ID": property("rich_text", "TEMPLATE-UNBOUND"),
      Owner: property("rich_text", ""),
      "Gmail Identity": property("email", ""),
      "Install State": property("select", "UNBOUND"),
      "Instance Status": property("select", "ACTIVE"),
      "Sales Contract Version": property("rich_text", SV.contract),
      "Sales Contract URL": property("url", `https://www.notion.so/${synthetic("copied-foreign-contract")}`),
      "Schema Version": property("rich_text", SV.schema),
      "Strategy Version": property("rich_text", ""),
      "Toolkit Version": property("rich_text", ""),
      "Authority Version": property("rich_text", ""),
      "Last Run Ref": { type: "rich_text", rich_text: [text("RUN-FOREIGN | "), mention(synthetic("copied-foreign-run"))] },
      "Read Scope": property("rich_text", ""),
      "Write Scope": property("rich_text", ""),
      "Gmail Verified": property("checkbox", false),
      "Tracker Access": property("select", "UNKNOWN"),
      "Capability Status": property("select", "UNKNOWN"),
      "Recovery Required": property("checkbox", false),
      // The real master template carries a fail-closed health seed on the Manifest, exactly as it does on the
      // OS State row below. The fixture omitted it, so no test could see what a clone is actually born with.
      "Health Status": property("select", "HOLD"),
      "Persistence Health": property("select", "HOLD_REBIND_REQUIRED"),
      "Current Gate": property("select", "B0_DISCOVERY"),
      "Current Gate Status": property("select", "HOLD"),
      "Last Verified Mutation": property("rich_text", "MUT-FOREIGN"),
    },
  };
  for (const [field, value] of Object.entries(options.manifest ?? {})) {
    const existing = manifestPage.properties[field];
    (manifestPage.properties as Record<string, PageProperty>)[field] = property(existing?.type ?? "rich_text", value);
  }
  map.set(`page:${manifestRow}`, manifestPage);
  map.set(`query:${manifest.ds}`, { results: [manifestPage], has_more: false, next_cursor: null });

  // A template seed is intentionally non-operational. Promotion has to overwrite this exact cursor before
  // Manifest SETUP, otherwise the first BUSINESS resume would mistake a pristine clone for recovery work.
  const state = databaseIds.get("OS_STATE") as { db: string; ds: string };
  const stateRow = synthetic("install-os-state-current");
  const statePage: Page = {
    object: "page", id: stateRow, archived: false, last_edited_time: "2030-01-01T00:00:00.000Z",
    parent: { type: "data_source_id", data_source_id: state.ds },
    properties: {
      Name: property("title", "CURRENT"),
      "Build State": property("select", "B0_DISCOVERY"),
      "Current Gate": property("select", "B0_DISCOVERY"),
      "Current Gate Status": property("select", "HOLD"),
      "Persistence Health": property("select", "HOLD_REBIND_REQUIRED"),
      "Recovery Required": property("checkbox", false),
      "Open Blocker": property("rich_text", "CANDIDATE_TEMPLATE_UNBOUND — copied seed is not operational"),
      "Next Action": property("rich_text", "Run the technical installer against this template"),
      "Next Question": property("rich_text", ""),
      "Last Run Ref": property("rich_text", "RUN-FOREIGN"),
      "Last Verified Mutation": property("rich_text", "MUT-FOREIGN"),
      "Last Required Written At": property("date", null),
      "Last Verified At": property("date", null),
    },
  };
  map.set(`page:${stateRow}`, statePage);
  map.set(`query:${state.ds}`, { results: [statePage], has_more: false, next_cursor: null });

  const registry = databaseIds.get("REGISTRY") as { db: string; ds: string };
  const registryRows: Record<string, string> = {};
  const rows: Page[] = [];
  const registrySpecs = installResources.filter((s: InstallPhysicalResource) => s.registryKey);
  for (const spec of registrySpecs) {
    const key = spec.registryKey as string;
    const id = synthetic(`install-registry-row:${key}`);
    registryRows[key] = id;
    const row: Page = {
      object: "page", id, archived: false, last_edited_time: "2030-01-01T00:00:00.000Z",
      parent: { type: "data_source_id", data_source_id: registry.ds },
      properties: {
        Key: property("title", key), Required: property("checkbox", false),
        "Resource URL": property("url", `https://www.notion.so/${synthetic(`copied-foreign:${key}`)}`),
        "Resource Type": property("select", spec.objectType === "DATABASE" ? "PAGE" : "DATABASE"),
        Status: property("select", "RESOLVED"), Scope: property("select", "MASTER"),
        Notes: property("rich_text", `Foreign rep foreign-rep@example.invalid copied secret for ${key}`),
      },
    };
    rows.push(row);
    map.set(`page:${id}`, row);
  }
  map.set(`query:${registry.ds}`, { results: rows, has_more: false, next_cursor: null });

  const adapters = createAdapterRegistries();
  adapters.salesRuntime.register(SV.contract, salesContractAdapter(SV.contract, [SV.schema], { ...SGRAMMAR, bootTitle: "00 — BOOT & INSTANCE", controlPlane }, {
    gtm: false,
    defaultOperatingModes: ["SALES_OPERATIONS"],
    operatingModeRequirements: { SALES_OPERATIONS: SALES_OPERATIONS_REQUIREMENTS },
    capabilityProofResource: "SALES:CAPABILITY_PROOFS",
  }));
  let backend = new InMemorySalesRuntimeRegistry([{
    rep_identity_key: principal.rep_identity_key as string,
    status: options.registryStatus ?? "INSTALL_PENDING",
    root_ref: root,
    ...(options.omitExpectedInstanceId ? {} : { expected_instance_id: options.expectedInstanceId ?? "SALESOS-INSTALL-A" }),
    ...(options.omitExpectedGmailIdentity ? {} : { expected_gmail_identity: "rep-a@example.invalid" }),
    ...(options.objectivePackageRef ? { objective_package_ref: options.objectivePackageRef } : {}),
    pointer_generation: "7",
  }]);
  const deps: HarnessDeps = {
    config: loadConfig({ VERTIGO_META_SPEC_ROOT: "https://example.invalid/unused", HARNESS_ENV: "fixture", PRINCIPALS_FILE: "fixture" }),
    principals: new InMemoryPrincipalRegistry([principal]),
    store: createMemoryStore(), notion: new FixtureNotionReadClient(map), adapters,
    salesRegistry: {
      lookup: (key) => backend.lookup(key),
      activateInstallation: (expected, proof) => backend.activateInstallation(expected, proof),
    },
  };
  const registryRowsOf = (): Page[] => ((map.get(`query:${registry.ds}`) as { results?: Page[] } | undefined)?.results ?? []);
  const writeRegistryRows = (next: Page[]): void => { map.set(`query:${registry.ds}`, { results: next, has_more: false, next_cursor: null }); };

  return {
    map, deps,
    ids: { root, foreignMaster, manifestDb: manifest.db, manifestDs: manifest.ds, manifestRow, stateDb: state.db, stateDs: state.ds, stateRow, registryDb: registry.db, registryDs: registry.ds, registryRows, objectRefs },
    setRegistry(entries) { backend = new InMemorySalesRuntimeRegistry([...entries]); },
    lookupRegistry() { return backend.lookup(REP_A.rep_identity_key as string); },
    setRegistryRow(key, fields) {
      const id = registryRows[key];
      const row = map.get(`page:${id}`) as Page | undefined;
      if (!row) throw new Error(`fixture registry row ${key} missing`);
      const properties: Record<string, PageProperty> = { ...row.properties };
      for (const [field, value] of Object.entries(fields)) properties[field] = property(properties[field]?.type ?? "rich_text", value);
      const next: Page = { ...row, properties, last_edited_time: "2030-01-05T00:00:00.000Z" };
      map.set(`page:${id}`, next);
      writeRegistryRows(registryRowsOf().map((r) => (r.id === id ? next : r)));
    },
    addRegistryRow(id, fields) {
      const properties: Record<string, PageProperty> = {};
      const types: Record<string, string> = { Key: "title", Required: "checkbox", "Resource URL": "url", "Resource Type": "select", Status: "select", Scope: "select", Notes: "rich_text" };
      for (const [field, value] of Object.entries(fields)) properties[field] = property(types[field] ?? "rich_text", value);
      const row: Page = { object: "page", id, archived: false, last_edited_time: "2030-01-05T00:00:00.000Z", parent: { type: "data_source_id", data_source_id: registry.ds }, properties };
      map.set(`page:${id}`, row);
      writeRegistryRows([...registryRowsOf(), row]);
      return id;
    },
    removeRegistryRow(key) {
      const id = registryRows[key];
      writeRegistryRows(registryRowsOf().filter((r) => r.id !== id));
    },
    setManifest(fields) {
      const row = map.get(`page:${manifestRow}`) as Page;
      const properties: Record<string, PageProperty> = { ...row.properties };
      for (const [field, value] of Object.entries(fields)) properties[field] = property(properties[field]?.type ?? "rich_text", value);
      const next: Page = { ...row, properties, last_edited_time: "2030-01-05T00:00:00.000Z" };
      map.set(`page:${manifestRow}`, next);
      map.set(`query:${manifest.ds}`, { results: [next], has_more: false, next_cursor: null });
    },
    setState(fields) {
      const row = map.get(`page:${stateRow}`) as Page;
      const properties: Record<string, PageProperty> = { ...row.properties };
      for (const [field, value] of Object.entries(fields)) properties[field] = property(properties[field]?.type ?? "rich_text", value);
      const next: Page = { ...row, properties, last_edited_time: "2030-01-05T00:00:00.000Z" };
      map.set(`page:${stateRow}`, next);
      map.set(`query:${state.ds}`, { results: [next], has_more: false, next_cursor: null });
    },
  };
}
