import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnose, schemaDefects } from "./probe-w51-diagnose.mjs";

test("W5.1 diagnosis: incompatible or missing schemas are explicit, never fabricated", () => {
  assert.deepEqual(schemaDefects({ Name: { type: "title" } }, { Name: ["title"], "Production Health": ["select"] }),
    [{ column: "Production Health", actual: "ABSENT", expected: ["select"] }]);
  assert.deepEqual(schemaDefects({ Value: { type: "number" } }, { Value: ["rich_text"] }),
    [{ column: "Value", actual: "number", expected: ["rich_text"] }]);
  assert.deepEqual(schemaDefects({ "Received At": { type: "created_time" } }, { "Received At": ["date", "created_time"] }), []);
});
test("W5.1 diagnosis: offline check uses no network or credential", async () => {
  const fetch = globalThis.fetch; globalThis.fetch = () => { throw Error("network forbidden"); };
  try { assert.deepEqual(await diagnose(["--check"]), { result: "OFFLINE_ONLY", network_calls: 0 }); }
  finally { globalThis.fetch = fetch; }
  await assert.rejects(() => diagnose(["--root", "foreign"]));
});
