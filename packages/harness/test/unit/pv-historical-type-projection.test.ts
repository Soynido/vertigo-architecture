/** Offline feasibility only: no schema conversion, write authority, adopted contract or collaborator PASS. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { qualifyHistoricalLiteral } from "../support/historical-type-projection.ts";

const sha = (v: string): string => createHash("sha256").update(v).digest("hex");
const gate = (value: string) => ({ id: "gate-property", type: "rich_text", rich_text: [{ type: "text",
  text: { content: value, link: null }, plain_text: value, href: null,
  annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }] });
const date = (start: string | null) => ({ id: "stamp-property", type: "date", date: start === null ? null : { start, end: null, time_zone: null } });

test("historical literal: unformatted gate read agrees with propText without inventing an enum", () => {
  const p = gate("READY"), before = structuredClone(p), r = qualifyHistoricalLiteral(p, "GATE_SELECT");
  assert.equal(r.read_shape, "LOSSLESS_LITERAL_READ");
  assert.equal(r.literal_sha256, sha("READY")); assert.equal(r.production_literal_sha256, r.literal_sha256);
  assert.equal(r.enum_membership, "NOT_DECLARED"); assert.equal(r.schema_admitted, false);
  assert.equal(r.apply_allowed, false); assert.equal(r.writer_authorized, false);
  assert.deepEqual(p, before); assert(!JSON.stringify(r).includes("READY"));
});

test("historical literal: exact declared enum match never makes schema/write admission", () => {
  const match = qualifyHistoricalLiteral(gate("READY"), "GATE_SELECT", ["READY"]);
  assert.equal(match.enum_membership, "MATCH"); assert.equal(match.schema_admitted, false);
  for (const value of ["ready", " READY", "READY ", "B0_DISCOVERY"]) {
    assert.equal(qualifyHistoricalLiteral(gate(value), "GATE_SELECT", ["READY"]).enum_membership, "NO_MATCH");
  }
  assert.equal(qualifyHistoricalLiteral(gate("READY"), "GATE_SELECT", []).enum_membership, "NO_MATCH");
  assert.equal(qualifyHistoricalLiteral(gate("READY"), "GATE_SELECT", ["READY", "READY"]).enum_membership, "INVALID_DECLARATION");
});

test("historical literal: formatted, linked, split, mentioned or divergent rich text is not silently scalarized", () => {
  const variants = [
    { ...gate("READY"), rich_text: [] },
    { ...gate("READY"), rich_text: [...gate("READY").rich_text, ...gate("READY").rich_text] },
    { ...gate("READY"), rich_text: [{ ...gate("READY").rich_text[0], type: "mention" }] },
    { ...gate("READY"), rich_text: [{ ...gate("READY").rich_text[0], type: "equation" }] },
    { ...gate("READY"), rich_text: [{ ...gate("READY").rich_text[0], plain_text: "DIFFERENT" }] },
    { ...gate("READY"), rich_text: [{ ...gate("READY").rich_text[0], href: "https://example.com" }] },
    { ...gate("READY"), rich_text: [{ ...gate("READY").rich_text[0], text: { content: "READY", link: { url: "https://example.com" } } }] },
    { ...gate("READY"), rich_text: [{ ...gate("READY").rich_text[0], annotations: { bold: true } }] },
    { ...gate("READY"), rich_text: [{ ...gate("READY").rich_text[0], annotations: { color: "red" } }] },
    { ...gate("READY"), rich_text: [{ ...gate("READY").rich_text[0], future_semantics: "unknown" }] },
  ];
  for (const p of variants) { const before = structuredClone(p), r = qualifyHistoricalLiteral(p, "GATE_SELECT");
    assert.notEqual(r.read_shape, "LOSSLESS_LITERAL_READ"); assert.equal(r.literal_sha256, null); assert.deepEqual(p, before);
  }
});

test("historical literal: Unicode and whitespace stay literal, not a normalized gate", () => {
  for (const value of ["ÉTAPE 🟢", " READY ", "Reprise\nconfirmée"]) {
    const r = qualifyHistoricalLiteral(gate(value), "GATE_SELECT");
    assert.equal(r.literal_sha256, sha(value)); assert.equal(r.enum_membership, "NOT_DECLARED");
  }
});

test("historical literal: date-only and offset timestamps are read verbatim with no timezone inference", () => {
  for (const [value, precision] of [
    ["2024-02-29", "DATE_ONLY"], ["2026-10-12T18:00:00.123+02:00", "DATETIME_OFFSET"],
    ["2026-10-12T16:00:00Z", "DATETIME_OFFSET"], ["2026-10-12T16:00:00.123456789Z", "DATETIME_OFFSET"],
  ] as const) {
    const p = date(value), before = structuredClone(p), r = qualifyHistoricalLiteral(p, "RECEIPT_TEXT");
    assert.equal(r.read_shape, "LOSSLESS_LITERAL_READ"); assert.equal(r.literal_precision, precision);
    assert.equal(r.literal_sha256, sha(value)); assert.equal(r.production_literal_sha256, r.literal_sha256);
    assert.equal(r.timezone_inferred, false); assert.equal(r.enum_membership, "NOT_APPLICABLE"); assert.deepEqual(p, before);
  }
});

test("historical literal: null/empty remains unknown, never now, UTC or READY", () => {
  for (const [p, kind] of [[date(null), "RECEIPT_TEXT"], [gate(""), "GATE_SELECT"], [{ type: "rich_text", rich_text: [] }, "GATE_SELECT"]] as const) {
    const r = qualifyHistoricalLiteral(p, kind);
    assert.equal(r.read_shape, "UNKNOWN_EMPTY"); assert.equal(r.literal_sha256, null);
    assert.equal(r.timezone_inferred, false); assert.equal(r.writer_authorized, false);
  }
});

test("historical literal: a range, timezone or unknown date metadata cannot be dropped", () => {
  const p = date("2026-10-12T16:00:00Z"); assert(p.date);
  for (const changed of [
    { ...p, date: { ...p.date, end: "2026-10-13T16:00:00Z" } },
    { ...p, date: { ...p.date, time_zone: "Europe/Paris" } },
    { ...p, date: { ...p.date, future_semantics: true } },
  ]) { const r = qualifyHistoricalLiteral(changed, "RECEIPT_TEXT");
    assert.equal(r.read_shape, "HOLD_UNSUPPORTED_OR_LOSSY_SHAPE"); assert.equal(r.literal_sha256, null);
  }
});

test("historical literal: invalid dates and ambiguous timestamps are refused without normalization", () => {
  for (const value of ["2025-02-29", "2026-02-30", "2026-13-01", "2026-00-01", "2026-10-12T24:00:00Z",
    "2026-10-12T16:60:00Z", "2026-10-12T16:00:60Z", "2026-10-12T16:00:00+14:30", "2026-10-12T16:00:00",
    "12/10/2026", " 2026-10-12", "2026-10-12 ", "now"]) {
    assert.equal(qualifyHistoricalLiteral(date(value), "RECEIPT_TEXT").read_shape, "HOLD_UNSUPPORTED_OR_LOSSY_SHAPE");
  }
});

test("historical literal: property ID and full metadata contribute to source hashes", () => {
  const a = qualifyHistoricalLiteral(date("2026-10-12"), "RECEIPT_TEXT");
  const b = qualifyHistoricalLiteral({ ...date("2026-10-12"), id: "different-id" }, "RECEIPT_TEXT");
  assert.equal(a.literal_sha256, b.literal_sha256); assert.notEqual(a.source_property_sha256, b.source_property_sha256);
  const whole = { ...date("2026-10-12"), future_semantics: "preserve" }, before = structuredClone(whole);
  assert.equal(qualifyHistoricalLiteral(whole, "RECEIPT_TEXT").read_shape, "HOLD_UNSUPPORTED_OR_LOSSY_SHAPE");
  assert.deepEqual(whole, before);
});

test("historical literal: wrong types, missing fields and unsupported inputs fail closed", () => {
  for (const value of [undefined, null, [], "raw text", { type: "select", select: { name: "READY" } }, { type: "rich_text" }, { type: "date" }]) {
    const r = qualifyHistoricalLiteral(value, "GATE_SELECT");
    assert.notEqual(r.read_shape, "LOSSLESS_LITERAL_READ"); assert.equal(r.schema_admitted, false);
  }
  assert.equal(qualifyHistoricalLiteral(gate("READY"), "RECEIPT_TEXT").read_shape, "HOLD_UNSUPPORTED_OR_LOSSY_SHAPE");
  assert.equal(qualifyHistoricalLiteral(date("2026-10-12"), "GATE_SELECT").read_shape, "HOLD_UNSUPPORTED_OR_LOSSY_SHAPE");
});
