/** PT-INST-036 — explicit Sales adapter/version matrix; registration never adopts a candidate. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Principal } from "../../src/auth/principal.ts";
import { FixtureNotionReadClient } from "../../src/notion/readClient.ts";
import { InMemorySalesRuntimeRegistry } from "../../src/registry/salesRuntimes.ts";
import { SalesRuntimeResolver } from "../../src/resolvers/sales.ts";
import { registerBuiltinSalesAdapters, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { EXTERNAL_INTERACTION_PROPERTIES, EXTERNAL_RECEIPT_PROPERTIES, EXTERNAL_RECEIPT_OPTIONS, SALES_CONTROL_PLANE_0511_CANDIDATE } from "../../src/versions/adapters/controlPlane.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";
import type { Block, Page, RichText } from "../../src/notion/shapes.ts";
import { childPage, synthetic, text } from "../unit/meta-fixtures.ts";

const ROOT = synthetic("candidate-051-root");
const BOOT = synthetic("candidate-051-boot");
const MANIFEST_DB = synthetic("candidate-051-manifest-db");
const MANIFEST_DS = synthetic("candidate-051-manifest-ds");
const MANIFEST = synthetic("candidate-051-manifest-row");

const rt = (value: string): RichText[] => [text(value)];
const pageList = (results: readonly Block[]) => ({ results, has_more: false, next_cursor: null });

function candidateWorld(contract: string, schema: string): FixtureNotionReadClient {
  const manifest: Page = {
    object: "page",
    id: MANIFEST,
    archived: false,
    last_edited_time: "2030-01-01T00:00:00.000Z",
    properties: {
      Name: { type: "title", title: rt("CURRENT") },
      "Root URL": { type: "url", url: "https://example.invalid/copied-template-root" },
      "Instance ID": { type: "rich_text", rich_text: rt("TEMPLATE-UNBOUND") },
      Owner: { type: "rich_text", rich_text: [] },
      "Gmail Identity": { type: "email", email: null },
      "Install State": { type: "select", select: { name: "UNBOUND" } },
      "Instance Status": { type: "select", select: { name: "ACTIVE" } },
      "Sales Contract Version": { type: "rich_text", rich_text: rt(contract) },
      "Sales Contract URL": { type: "url", url: null },
      "Schema Version": { type: "rich_text", rich_text: rt(schema) },
      "Strategy Version": { type: "rich_text", rich_text: [] },
      "Toolkit Version": { type: "rich_text", rich_text: [] },
      "Authority Version": { type: "rich_text", rich_text: [] },
      "Last Run Ref": { type: "rich_text", rich_text: [] },
    },
  };
  return new FixtureNotionReadClient(new Map<string, unknown>([
    [`page:${ROOT}`, { object: "page", id: ROOT, archived: false, properties: { title: { type: "title", title: rt("Valentin — Personal Sales OS — INSTALL CANDIDATE v0.5.1") } } }],
    [`children:${ROOT}`, pageList([childPage(BOOT, "00 — BOOT & INSTANCE")])],
    [`children:${BOOT}`, pageList([{ id: MANIFEST_DB, type: "child_database", child_database: { title: "Instance Manifest" } }])],
    [`database:${MANIFEST_DB}`, { object: "database", id: MANIFEST_DB, title: rt("Instance Manifest"), data_sources: [{ id: MANIFEST_DS, name: "Instance Manifest" }] }],
    [`query:${MANIFEST_DS}`, { results: [manifest] }],
    [`page:${MANIFEST}`, manifest],
  ]));
}

const principal: Principal = {
  principal_id: "p-valentin",
  display_name: "Valentin Galudec",
  status: "ACTIVE",
  allowed_projects: ["VERTIGO"],
  allowed_lanes: ["SALES"],
  rep_identity_key: "valentin",
};

function resolver(contract: string, schema: string): SalesRuntimeResolver {
  const adapters = createAdapterRegistries();
  registerBuiltinSalesAdapters(adapters.salesRuntime);
  return new SalesRuntimeResolver(
    candidateWorld(contract, schema),
    principal,
    "VERTIGO",
    new InMemorySalesRuntimeRegistry([{
      rep_identity_key: "valentin",
      status: "INSTALL_PENDING",
      root_ref: ROOT,
      expected_instance_id: "SALES-VALENTIN-20300101",
      expected_gmail_identity: "valentin@example.invalid",
      pointer_generation: "1",
    }]),
    adapters.salesRuntime,
  );
}

test("PT-INST-036: stable, install candidate, Calendar bridge, Sales V1 and GTM line remain explicit and distinct", async () => {
  const adapters = createAdapterRegistries();
  registerBuiltinSalesAdapters(adapters.salesRuntime);
  const supported = adapters.salesRuntime.supported();
  assert.equal(supported.length, 10);
  assert.deepEqual(supported.slice(0, 8).map((v) => v.split("/").at(-1)), ["0.5.0", "0.5.1-candidate", "0.5.2-candidate", "0.5.3-candidate", "0.5.4-candidate", "0.5.5-candidate", "0.5.6-candidate", "0.6.0"], "the original eight registrations retain their exact order");
  assert.ok(supported[8]?.endsWith("/0.5.13-candidate"), "the native-event candidate retains its exact registration");
  assert.ok(supported[9]?.endsWith("/0.5.14-candidate"), "only the B7 graph candidate is appended");

  // The setup line (0.5.6) is the OFFER line plus five catalog entries and strictly nothing else: same schema,
  // same resources, same capabilities. A line that changed anything else would not be a rollback target.
  const bySuffix = (suffix: string): SalesContractAdapter => {
    const v = supported.find((x) => x.endsWith(suffix));
    assert.ok(v, `no registered contract line ends with ${suffix}`);
    return adapters.salesRuntime.resolve(v) as SalesContractAdapter;
  };
  const offerLine = bySuffix("/0.5.5-candidate");
  const setupLine = bySuffix("/0.5.6-candidate");
  const eventLine = bySuffix("/0.5.13-candidate");
  assert.equal(eventLine.supportedSchemas.length, 1);
  assert.ok(eventLine.supportedSchemas[0]?.endsWith("/0.5.8-candidate"));
  assert.equal(eventLine.capabilities, setupLine.capabilities, "no new connector or effect permission");
  const eventResources = eventLine.grammar.controlPlane.resources ?? {};
  const inheritedResources = SALES_CONTROL_PLANE_0511_CANDIDATE.resources ?? {};
  assert.deepEqual(Object.keys(eventResources).filter((key) => !Object.hasOwn(inheritedResources, key)), ["SALES:SOURCE_IDENTITY", "SALES:INTERACTIONS", "SALES:RECEIPTS"]);
  assert.deepEqual(eventResources["SALES:SOURCE_IDENTITY"], { parentTitle: "00 — BOOT & INSTANCE", databaseTitle: "Instance Manifest",
    naturalKeyProperty: "Name", operations: ["UPDATE"], backendDerivedOnly: true,
    writableProperties: ["Gmail Identity"], protectedProperties: ["Name"], redactValues: true });
  assert.equal(eventLine.grammar.controlPlane.installContract?.physicalResources.some(r => r.key === "SOURCE_IDENTITY"), false, "an alias, never an added physical resource");
  for (const key of Object.keys(inheritedResources)) assert.deepEqual(eventResources[key], inheritedResources[key], `${key} remains unchanged`);
  const physical = eventLine.grammar.controlPlane.installContract?.physicalResources ?? [];
  for (const [key, parent, title, naturalKey, properties] of [
    ["SALES:INTERACTIONS", "04 — DATA & EVIDENCE", "Interactions", "Event Key", EXTERNAL_INTERACTION_PROPERTIES],
    ["SALES:RECEIPTS", "03 — CONTROL PLANE", "Receipts", "Idempotency Key", EXTERNAL_RECEIPT_PROPERTIES],
  ] as const) {
    const resource = eventResources[key]!;
    assert.deepEqual([resource.parentTitle, resource.databaseTitle, resource.naturalKeyProperty], [parent, title, naturalKey]);
    assert.deepEqual(resource.operations, ["CREATE"]);
    assert.equal(resource.backendDerivedOnly, true);
    assert.equal(resource.naturalKeyIsIdentity, true);
    assert.deepEqual(resource.writableProperties, Object.keys(properties));
    const installed = physical.filter((r) => r.key === key.split(":")[1]);
    assert.equal(installed.length, 1);
    assert.deepEqual(installed[0]!.path, [parent, title]);
    assert.deepEqual(installed[0]!.requiredProperties, properties);
  }
  assert.deepEqual(physical.find((r) => r.key === "RECEIPTS")?.requiredSelectOptions, EXTERNAL_RECEIPT_OPTIONS);
  assert.deepEqual(setupLine.supportedSchemas, offerLine.supportedSchemas);
  assert.deepEqual(setupLine.capabilities, offerLine.capabilities);
  assert.deepEqual(Object.keys(setupLine.grammar.controlPlane.resources ?? {}), Object.keys(offerLine.grammar.controlPlane.resources ?? {}));
  assert.equal((offerLine.grammar.controlPlane.cursorTransitions ?? []).length, 2);
  assert.equal((setupLine.grammar.controlPlane.cursorTransitions ?? []).length, 7);
  const stableContract = supported.find((version) => version.endsWith("/0.5.0"));
  const installContract = supported.find((version) => version.endsWith("/0.5.1-candidate"));
  const bridgeContract = supported.find((version) => version.endsWith("/0.5.2-candidate"));
  const salesV1Contract = supported.find((version) => Object.hasOwn((adapters.salesRuntime.resolve(version) as SalesContractAdapter).grammar.controlPlane.resources ?? {}, "SALES:ACCOUNTS"));
  const gtmContract = supported.find((version) => (adapters.salesRuntime.resolve(version) as SalesContractAdapter).capabilities.gtm);
  assert.ok(stableContract && installContract && bridgeContract && salesV1Contract && gtmContract);
  const stable = adapters.salesRuntime.resolve(stableContract) as SalesContractAdapter;
  const install = adapters.salesRuntime.resolve(installContract) as SalesContractAdapter;
  const bridge = adapters.salesRuntime.resolve(bridgeContract) as SalesContractAdapter;
  const salesV1 = adapters.salesRuntime.resolve(salesV1Contract) as SalesContractAdapter;
  const gtm = adapters.salesRuntime.resolve(gtmContract) as SalesContractAdapter;
  const installSchema = install.supportedSchemas[0] as string;
  assert.equal(installSchema.split("/").at(-1), "0.5.1-candidate");
  assert.deepEqual(install.capabilities, stable.capabilities);
  assert.deepEqual(bridge.supportedSchemas, [installSchema], "the bridge reuses the 0.5.1 schema exactly");
  assert.deepEqual(bridge.grammar.controlPlane.installContract?.physicalResources, install.grammar.controlPlane.installContract?.physicalResources, "the bridge adds no physical resource or schema requirement");
  assert.deepEqual(Object.keys(bridge.grammar.controlPlane.resources ?? {}), Object.keys(install.grammar.controlPlane.resources ?? {}), "the bridge adds no mutable resource");
  assert.equal(bridge.capabilities.gtm, false);
  assert.deepEqual(bridge.capabilities.operatingModeRequirements?.["SALES_OPERATIONS"]?.map((r) => [r.capability, r.competentSource]), [
    ["GMAIL_READ", "GMAIL"],
    ["CALENDAR_READ", "GOOGLE_CALENDAR"],
  ]);
  assert.equal(salesV1.supportedSchemas.length, 1);
  assert.notDeepEqual(salesV1.supportedSchemas, bridge.supportedSchemas, "Sales V1 needs the migrated pipeline schema; the bridge schema carries no outreach idempotency key");
  assert.equal(salesV1.capabilities, bridge.capabilities, "Sales V1 changes the transaction catalog, not connector behavior");
  assert.ok(Object.hasOwn(salesV1.grammar.controlPlane.resources ?? {}, "SALES:EXTERNAL_ACTIONS"));
  assert.ok(Object.hasOwn(salesV1.grammar.controlPlane.resources ?? {}, "SALES:ACCOUNTS"));
  assert.equal(gtm.capabilities.gtm, true);

  // The same-turn capture line is a behavioural amendment: identical schema, business resources and capabilities
  // to Sales V1, adding only the backend-derived durable cursor its own page authorizes.
  const captureContract = supported.find((version) => version.endsWith("/0.5.4-candidate")) as string;
  assert.ok(captureContract && captureContract !== salesV1Contract);
  const capture = adapters.salesRuntime.resolve(captureContract) as SalesContractAdapter;
  assert.deepEqual(capture.supportedSchemas, salesV1.supportedSchemas);
  assert.deepEqual(
    Object.keys(capture.grammar.controlPlane.resources ?? {}).filter((key) => !Object.hasOwn(salesV1.grammar.controlPlane.resources ?? {}, key)),
    ["SALES:OS_STATE"], "the amendment adds only the backend-derived cursor; every business resource is shared",
  );
  assert.equal(capture.capabilities, salesV1.capabilities);

  // The OFFER step line is the next amendment on the same terms: same schema, same resources, same
  // capabilities as the capture line, adding only the catalog entry that leaves B1_OFFER. Specifying a step
  // must never smuggle in a resource, a schema requirement or a connector change alongside it.
  const offerContract = supported.find((version) => version.endsWith("/0.5.5-candidate")) as string;
  assert.ok(offerContract && offerContract !== captureContract);
  const offer = adapters.salesRuntime.resolve(offerContract) as SalesContractAdapter;
  assert.deepEqual(offer.supportedSchemas, capture.supportedSchemas);
  assert.deepEqual(Object.keys(offer.grammar.controlPlane.resources ?? {}), Object.keys(capture.grammar.controlPlane.resources ?? {}));
  assert.equal(offer.capabilities, capture.capabilities);
  assert.deepEqual(
    (offer.grammar.controlPlane.cursorTransitions ?? []).map((t) => t.fromGate),
    ["B0_DISCOVERY", "B1_OFFER"], "the OFFER line specifies exactly one step more than the line it amends",
  );
  assert.deepEqual((capture.grammar.controlPlane.cursorTransitions ?? []).map((t) => t.fromGate), ["B0_DISCOVERY"], "and re-pinning that line removes it");

  for (const contract of [installContract, bridgeContract, salesV1Contract]) {
    const schema = (adapters.salesRuntime.resolve(contract) as SalesContractAdapter).supportedSchemas[0] as string;
    const result = await resolver(contract, schema).resolve();
    assert.equal(result.kind, "RESOLVED", JSON.stringify(result));
    if (result.kind !== "RESOLVED") continue;
    assert.equal(result.runtime.access_mode, "INSTALL_ONLY");
    assert.equal((result.runtime.versions.governing_spec as { value: string }).value, contract);
    assert.equal((result.runtime.versions.governing_schema as { value: string }).value, schema);
  }
});

test("PT-INST-036/b: each candidate rejects an unsupported schema instead of guessing", async () => {
  const adapters = createAdapterRegistries();
  registerBuiltinSalesAdapters(adapters.salesRuntime);
  const candidateContracts = adapters.salesRuntime.supported().filter((version) => version.endsWith("-candidate"));
  const stableContract = adapters.salesRuntime.supported().find((version) => version.endsWith("/0.5.0")) as string;
  const stableSchema = (adapters.salesRuntime.resolve(stableContract) as SalesContractAdapter).supportedSchemas[0] as string;
  for (const candidateContract of candidateContracts) {
    const candidateSchema = (adapters.salesRuntime.resolve(candidateContract) as SalesContractAdapter).supportedSchemas[0] as string;
    const unknownSchema = candidateSchema.replace(/\d+\.\d+\.\d+/, "9.9.9");
    for (const schema of [stableSchema, unknownSchema]) {
      const result = await resolver(candidateContract, schema).resolve();
      assert.equal(result.kind, "HOLD");
      assert.equal((result as { code: string }).code, "HOLD_UNSUPPORTED_GOVERNING_VERSION");
    }
  }
});
