/**
 * PT-PROP-001 — parity: `materialize ∘ encode` reads back exactly as the former fixture writer did, for every
 * property form the existing fixtures write; readSchema captures enumeration options.
 * PT-PROP-002 — governed enumerations (D11): a value outside the options is HOLD_SCHEMA_VALUE_UNSUPPORTED before
 * any write; unreadable options prove nothing; an extensible list accepts a new value.
 * PT-PROP-003 — strict edges: checkbox "false" is false, text is chunked at 2000 characters, `files` is refused.
 * PV-WRITE-001 / W1.3.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeProperty, materializeProperty, RICH_TEXT_CHUNK, type EncodeContext } from "../../src/notion/properties.ts";
import { mentionedPageIds, plainText, propRelationIds, propText, type Page, type PageProperty, type RichText } from "../../src/notion/shapes.ts";
import { readSchema } from "../../src/plans/resources.ts";
import { FixtureNotionReadClient } from "../../src/notion/readClient.ts";
import { mention, synthetic, text } from "./meta-fixtures.ts";

const NOW = "2030-01-01T00:30:00.000Z";
const A = synthetic("prop-a");
const B = synthetic("prop-b");
const ctx: EncodeContext = { now: NOW, resolveCreated: (s) => (s === "ROW" ? B : undefined), extensible: true };

function roundTrip(type: string, value: unknown, c: EncodeContext = ctx): PageProperty {
  const e = encodeProperty(type, value, c);
  assert.ok(e.ok, `${type} ${JSON.stringify(value)}: ${e.ok ? "" : e.evidence}`);
  return materializeProperty(type, e.value);
}
const page = (p: Record<string, PageProperty>): Page => ({ id: A, properties: p });

test("PT-PROP-001/a: every form the fixtures write reads back as the former writer produced it", () => {
  // The former fixture writer's read forms, verbatim.
  const cases: Array<[string, unknown, PageProperty]> = [
    ["title", "PLUGIN — x", { type: "title", title: [text("PLUGIN — x")] }],
    ["title", "$created:ROW", { type: "title", title: [mention(B)] }],
    ["rich_text", "answer", { type: "rich_text", rich_text: [text("answer")] }],
    ["rich_text", `page:${A}`, { type: "rich_text", rich_text: [mention(A)] }],
    ["rich_text", "$now", { type: "rich_text", rich_text: [text(NOW)] }],
    ["rich_text", null, { type: "rich_text", rich_text: [text("")] }],
    ["rich_text", 42, { type: "rich_text", rich_text: [text("42")] }],
    ["select", "RUNNING", { type: "select", select: { name: "RUNNING" } }],
    ["select", null, { type: "select", select: null }],
    ["status", "Done", { type: "status", status: { name: "Done" } } as unknown as PageProperty],
    ["number", 3, { type: "number", number: 3 }],
    ["number", "7", { type: "number", number: 7 }],
    ["number", null, { type: "number", number: null }],
    ["checkbox", true, { type: "checkbox", checkbox: true }],
    ["checkbox", false, { type: "checkbox", checkbox: false }],
    ["date", "2030-01-03", { type: "date", date: { start: "2030-01-03" } }],
    ["date", "$now", { type: "date", date: { start: NOW } }],
    ["date", null, { type: "date", date: null }],
    ["url", "https://example.invalid/a", { type: "url", url: "https://example.invalid/a" }],
    ["url", null, { type: "url", url: null }],
    ["email", "a@example.invalid", { type: "email", email: "a@example.invalid" }],
    ["relation", `page:${A}`, { type: "relation", relation: [{ id: A }] } as unknown as PageProperty],
    ["relation", [`page:${A}`, "$created:ROW"], { type: "relation", relation: [{ id: A }, { id: B }] } as unknown as PageProperty],
    ["relation", null, { type: "relation", relation: [] } as unknown as PageProperty],
  ];
  for (const [type, value, expected] of cases) assert.deepEqual(roundTrip(type, value), expected, `${type} ${JSON.stringify(value)}`);
});

test("PT-PROP-001/b: the readers see the same facts through the new writer", () => {
  const p = page({
    T: roundTrip("title", "Row"), R: roundTrip("rich_text", `page:${A}`), S: roundTrip("select", "OPEN"),
    C: roundTrip("checkbox", "false"), N: roundTrip("number", 2), D: roundTrip("date", "2030-01-03"),
    U: roundTrip("url", "https://example.invalid"), P: roundTrip("phone_number", "+33 1 23 45 67 89"), L: roundTrip("relation", [B, A]),
  });
  assert.deepEqual([propText(p, "T"), propText(p, "S"), propText(p, "C"), propText(p, "N"), propText(p, "D"), propText(p, "U"), propText(p, "P")],
    ["Row", "OPEN", "false", "2", "2030-01-03", "https://example.invalid", "+33 1 23 45 67 89"]);
  assert.deepEqual(mentionedPageIds((p.properties["R"] as unknown as { rich_text: RichText[] }).rich_text), [A]);
  assert.deepEqual(propRelationIds(p, "L"), [A, B].sort());
});

test("PT-PROP-001/c: the REST value is the exact create/update body Notion accepts", () => {
  const e = (t: string, v: unknown, c: EncodeContext = ctx) => { const r = encodeProperty(t, v, c); assert.ok(r.ok); return r.value; };
  assert.deepEqual(e("title", "x"), { title: [{ type: "text", text: { content: "x" } }] });
  assert.deepEqual(e("rich_text", `page:${A}`), { rich_text: [{ type: "mention", mention: { type: "page", page: { id: A } } }] });
  assert.deepEqual(e("select", "OPEN"), { select: { name: "OPEN" } });
  assert.deepEqual(e("multi_select", ["a", "b", "a"]), { multi_select: [{ name: "a" }, { name: "b" }] });
  assert.deepEqual(e("people", ["u1"]), { people: [{ object: "user", id: "u1" }] });
  assert.deepEqual(e("relation", [`page:${A}`, `page:${A}`]), { relation: [{ id: A }] });
  assert.deepEqual(e("url", ""), { url: null });
});

test("PT-PROP-001/d: readSchema captures select, status and multi_select options", async () => {
  const ds = synthetic("prop-ds");
  const client = new FixtureNotionReadClient(new Map([[`data_source:${ds}`, { properties: {
    State: { type: "select", select: { options: [{ name: "OPEN" }, { name: "CLOSED" }] } },
    Stage: { type: "status", status: { options: [{ name: "Not started" }, { name: "Done" }] } },
    Tags: { type: "multi_select", multi_select: { options: [{ name: "a" }] } },
    Name: { type: "title", title: {} },
  } }]]));
  const schema = await readSchema(client, ds);
  assert.ok(schema);
  assert.deepEqual(Object.fromEntries(schema.options), { State: ["OPEN", "CLOSED"], Stage: ["Not started", "Done"], Tags: ["a"] });
  assert.equal(schema.properties.get("Name"), "title");
});

test("PT-PROP-002: a governed enumeration refuses an unknown value before any write; an extensible one accepts it", () => {
  const governed: EncodeContext = { options: ["OPEN", "CLOSED"] };
  for (const type of ["select", "status"]) {
    assert.ok(encodeProperty(type, "OPEN", governed).ok);
    const bad = encodeProperty(type, "REOPENED", governed);
    assert.equal(bad.ok ? "" : bad.code, "HOLD_SCHEMA_VALUE_UNSUPPORTED", type);
    assert.equal((encodeProperty(type, "open", governed) as { code?: string }).code, "HOLD_SCHEMA_VALUE_UNSUPPORTED", "options are exact, case included");
    assert.ok(encodeProperty(type, null, governed).ok, "clearing is not a new option");
    // Options that could not be read prove nothing: refused, never guessed.
    assert.equal((encodeProperty(type, "OPEN", {}) as { code?: string }).code, "HOLD_SCHEMA_VALUE_UNSUPPORTED");
    // Declared extensible by the contract: a new option is allowed.
    assert.ok(encodeProperty(type, "REOPENED", { ...governed, extensible: true }).ok);
  }
  assert.equal((encodeProperty("multi_select", ["OPEN", "NEW"], governed) as { code?: string }).code, "HOLD_SCHEMA_VALUE_UNSUPPORTED");
  assert.ok(encodeProperty("multi_select", ["OPEN", "CLOSED"], governed).ok);
  assert.ok(encodeProperty("multi_select", ["NEW"], { ...governed, extensible: true }).ok);
});

test("PT-PROP-003/a: checkbox is strict — the string \"false\" is false, anything else ambiguous is refused", () => {
  const c = (v: unknown) => { const r = encodeProperty("checkbox", v); return r.ok ? (r.value as { checkbox: boolean }).checkbox : r.code; };
  assert.deepEqual([true, "true", "__YES__"].map(c), [true, true, true]);
  assert.deepEqual([false, "false", "__NO__", null].map(c), [false, false, false, false]);
  for (const v of ["yes", "False", "", 1, 0, "on", {}]) assert.equal(c(v), "HOLD_SCHEMA_MISMATCH", JSON.stringify(v));
});

test("PT-PROP-003/b: text is split into 2000-character objects and read back whole; beyond 100 objects it is refused", () => {
  const long = "é".repeat(RICH_TEXT_CHUNK * 2 + 500);
  const e = encodeProperty("rich_text", long);
  assert.ok(e.ok);
  const items = (e.value as { rich_text: Array<{ text: { content: string } }> }).rich_text;
  assert.deepEqual(items.map((i) => i.text.content.length), [2000, 2000, 500]);
  assert.equal(plainText((materializeProperty("rich_text", e.value) as unknown as { rich_text: RichText[] }).rich_text), long);
  assert.ok(encodeProperty("title", "x".repeat(RICH_TEXT_CHUNK * 100)).ok);
  assert.equal((encodeProperty("title", "x".repeat(RICH_TEXT_CHUNK * 100 + 1)) as { code?: string }).code, "HOLD_SCHEMA_MISMATCH");
});

test("PT-PROP-003/c: files and non-writable types are refused; bad values never coerce", () => {
  assert.equal((encodeProperty("files", [{ name: "a.pdf" }]) as { code?: string }).code, "HOLD_UNSUPPORTED_OPERATION");
  for (const t of ["formula", "rollup", "created_time", "unique_id", "button", "UNKNOWN"]) assert.equal((encodeProperty(t, "x") as { code?: string }).code, "HOLD_UNSUPPORTED_OPERATION", t);
  const mismatch: Array<[string, unknown]> = [["number", "abc"], ["number", ""], ["date", "tomorrow"], ["date", "2030-13-45"], ["url", 5], ["rich_text", { a: 1 }], ["select", ["a"]], ["relation", [5]], ["people", [""]]];
  for (const [t, v] of mismatch) assert.equal((encodeProperty(t, v, { extensible: true }) as { code?: string }).code, "HOLD_SCHEMA_MISMATCH", `${t} ${JSON.stringify(v)}`);
  // The executor has no fallback for a reference to a row not created yet.
  assert.equal((encodeProperty("relation", "$created:MISSING", { resolveCreated: () => undefined }) as { code?: string }).code, "HOLD_SCHEMA_MISMATCH");
  assert.equal((encodeProperty("rich_text", "$created:MISSING", {}) as { code?: string }).code, "HOLD_SCHEMA_MISMATCH");
});
