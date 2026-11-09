import { test } from "node:test";
import assert from "node:assert/strict";
import { draftHistoricalSchemaAdditions, type HistoricalSchemaRequirements } from "../../src/migration/historicalSchemaDraft.ts";

const schema = () => ({ object: "data_source", id: "original-source", parent: { database_id: "original-parent" },
  properties: { Name: { id: "title", type: "title", title: {} }, Gate: { id: "gate", type: "rich_text", rich_text: {} },
    When: { id: "date", type: "date", date: {} },
    Status: { id: "status", type: "select", select: { options: [{ id: "old-option", name: "OLD", color: "green", extra: "preserve" }], extra: "keep" } },
    Account: { id: "relation", type: "relation", relation: { database_id: "related-db", type: "dual_property", dual_property: { synced_property_id: "backlink" } } },
    Computed: { id: "formula", type: "formula", formula: { expression: "1 + 1" } } }, extra: { source: "preserve entire object" } });

test("historical schema draft: scalar additions preserve every existing schema object and parent", () => {
  const input = schema(), before = structuredClone(input);
  const r = draftHistoricalSchemaAdditions(input, { properties: { Name: "title", Gate: "rich_text", LastRun: "rich_text", Counter: "number", Checked: "checkbox" } });
  assert.equal(r.status, "DRAFT_ADDITIONS_ONLY"); assert.equal(r.property_additions.length, 3);
  assert(r.projected_schema); const projected = r.projected_schema;
  assert.deepEqual(projected.parent, before.parent); assert.deepEqual(projected.extra, before.extra);
  for (const [name, value] of Object.entries(before.properties)) assert.deepEqual((projected.properties as Record<string, unknown>)[name], value);
  assert.deepEqual(input, before); assert.notEqual(r.source_schema_sha256, r.projected_schema_sha256);
  assert.equal(r.schema_admitted, false); assert.equal(r.execution_authorized, false); assert.equal(r.writer_authorized, false);
});

test("historical schema draft: exact select options append without dropping IDs/colors/metadata", () => {
  const input = schema(), before = structuredClone(input);
  const r = draftHistoricalSchemaAdditions(input, { properties: { Status: "select" }, selectOptions: { Status: ["OLD", "NEW", "old", " OLD "] } });
  assert.equal(r.option_additions.length, 3); assert.equal(r.status, "DRAFT_ADDITIONS_ONLY");
  const p = (r.projected_schema?.properties as typeof input.properties).Status;
  assert.deepEqual(p.select.options[0], before.properties.Status.select.options[0]); assert.equal(p.select.extra, "keep");
  assert.deepEqual(p.select.options.slice(1), [{ name: "NEW" }, { name: "old" }, { name: " OLD " }]); assert.deepEqual(input, before);
});

test("historical schema draft: conflicting rich_text/select and date/rich_text stay original and HOLD", () => {
  const input = schema(), r = draftHistoricalSchemaAdditions(input, { properties: { Gate: "select", When: "rich_text", Added: "rich_text" }, selectOptions: { Gate: ["READY"] } });
  assert.equal(r.status, "HOLD_STRUCTURAL_GAPS"); assert.equal(r.holds.filter(h => h.code === "PRESERVE_TYPE_CONFLICT").length, 2);
  const p = r.projected_schema?.properties as typeof input.properties;
  assert.deepEqual(p.Gate, input.properties.Gate); assert.deepEqual(p.When, input.properties.When);
  assert.equal(r.property_additions.length, 1); assert.equal(r.option_additions.length, 0); assert.equal(r.execution_authorized, false);
});

test("historical schema draft: absent or ambiguous title cannot become a new database/title", () => {
  for (const properties of [{}, { A: { type: "title" }, B: { type: "title" } }]) {
    const r = draftHistoricalSchemaAdditions({ properties }, { properties: { Name: "title", Added: "rich_text" } });
    assert.equal(r.status, "HOLD_STRUCTURAL_GAPS"); assert.equal(r.property_additions.length, 0);
    assert.equal(r.holds[0]?.code, "TITLE_MISSING_OR_AMBIGUOUS");
  }
  const r = draftHistoricalSchemaAdditions(schema(), { properties: { OtherTitle: "title" } });
  assert.equal(r.status, "HOLD_STRUCTURAL_GAPS"); assert.equal(r.property_additions.length, 0);
});

test("historical schema draft: relation/formula/rollup/status and unknown additions need declarations, not inference", () => {
  const input = schema(), before = structuredClone(input);
  const r = draftHistoricalSchemaAdditions(input, { properties: { NewRelation: "relation", NewFormula: "formula", Roll: "rollup", State: "status", Unknown: "future_type" } });
  assert.equal(r.status, "HOLD_STRUCTURAL_GAPS"); assert.equal(r.holds.length, 5); assert.equal(r.property_additions.length, 0); assert.deepEqual(input, before);
});

test("historical schema draft: malformed or duplicate declarations do not append options", () => {
  for (const values of [["NEW", "NEW"], [""], [4], null]) {
    const input = schema(), before = structuredClone(input);
    const req = { properties: { Status: "select" }, selectOptions: { Status: values } } as unknown as HistoricalSchemaRequirements;
    const r = draftHistoricalSchemaAdditions(input, req); assert.equal(r.status, "HOLD_STRUCTURAL_GAPS");
    assert.equal(r.option_additions.length, 0); assert.deepEqual(input, before);
  }
});

test("historical schema draft: invalid existing options and status groups are preserved rather than rewritten", () => {
  const duplicate = schema(), originalOption = duplicate.properties.Status.select.options[0]; assert(originalOption);
  duplicate.properties.Status.select.options.push(structuredClone(originalOption));
  const r = draftHistoricalSchemaAdditions(duplicate, { properties: { Status: "select" }, selectOptions: { Status: ["NEW"] } });
  assert.equal(r.status, "HOLD_STRUCTURAL_GAPS"); assert.equal(r.option_additions.length, 0);
  assert.deepEqual(r.projected_schema, duplicate);
  const s = { properties: { Name: { type: "title" }, State: { type: "status", status: { options: [], groups: [{ id: "group", name: "source" }] } } } };
  const held = draftHistoricalSchemaAdditions(s, { properties: { State: "status" }, selectOptions: { State: ["NEW"] } });
  assert.equal(held.status, "HOLD_STRUCTURAL_GAPS"); assert.deepEqual(held.projected_schema, s);
});

test("historical schema draft: missing/non-JSON schema and invalid requirements HOLD with no executable plan", () => {
  for (const input of [undefined, null, [], "raw", {}, { properties: [] }, { properties: null }, { properties: () => {} }, { properties: {}, extra: 1n }]) {
    const r = draftHistoricalSchemaAdditions(input, { properties: { Name: "title" } });
    assert.equal(r.status, "HOLD_STRUCTURAL_GAPS"); assert.equal(r.projected_schema, null); assert.equal(r.execution_authorized, false);
  }
  const r = draftHistoricalSchemaAdditions(schema(), { properties: null } as unknown as HistoricalSchemaRequirements);
  assert.equal(r.status, "HOLD_STRUCTURAL_GAPS"); assert.equal(r.property_additions.length, 0);
});

test("historical schema draft: unchanged schema is not compatible/admitted/READY authority", () => {
  const r = draftHistoricalSchemaAdditions(schema(), { properties: { Name: "title", Gate: "rich_text", When: "date" } });
  assert.equal(r.status, "DRAFT_ADDITIONS_ONLY"); assert.equal(r.source_schema_sha256, r.projected_schema_sha256);
  assert.equal(r.schema_admitted, false); assert.equal(r.writer_authorized, false); assert.equal(r.execution_authorized, false);
  assert(!Object.hasOwn(r, "compatible")); assert(!Object.hasOwn(r, "write_instructions"));
});

test("historical schema draft: local output has no aliases to source and dangerous keys are own properties", () => {
  const input = schema(), before = structuredClone(input);
  const required = JSON.parse('{"properties":{"__proto__":"rich_text"}}') as HistoricalSchemaRequirements;
  const r = draftHistoricalSchemaAdditions(input, required); assert.equal(r.property_additions.length, 1);
  const p = r.projected_schema?.properties as Record<string, unknown>;
  assert(Object.hasOwn(p, "__proto__")); assert.equal(Object.getPrototypeOf(p), Object.prototype);
  ((p.Gate as Record<string, unknown>).id) = "changed-local-only";
  assert.deepEqual(input, before); assert.equal(({} as Record<string, unknown>).type, undefined);
});
