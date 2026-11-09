import { test } from "node:test";
import assert from "node:assert/strict";
import { ID, locatorChildren, manifestPage, resolver, rootPage } from "./meta-fixtures.ts";
import { registerBuiltinMetaAdapters } from "../../src/versions/adapters/meta.ts";
import { createAdapterRegistries } from "../../src/versions/registry.ts";

test("runtime generation is stable for identical addressing and changes on root, manifest or pointer generation change", async () => {
  const base = await resolver().resolve();
  const same = await resolver().resolve();
  const rotatedPointer = await resolver({ locator: locatorChildren({ pointerGeneration: "2" }) }).resolve();
  const rotatedRoot = await resolver({ locator: locatorChildren({ rootId: ID.rootB }), manifest: manifestPage({ rootId: ID.rootB }), root: rootPage(ID.rootB) }).resolve();
  for (const r of [base, same, rotatedPointer, rotatedRoot]) assert.equal(r.kind, "RESOLVED");
  const gen = (r: typeof base) => (r as { runtime: { runtime_generation: string } }).runtime.runtime_generation;
  assert.equal(gen(base), gen(same));
  assert.notEqual(gen(base), gen(rotatedPointer));
  assert.notEqual(gen(base), gen(rotatedRoot));
});

test("locator descriptive fields lagging the Manifest produce warnings, not a HOLD", async () => {
  const r = await resolver({ locator: locatorChildren({ runtimeState: "INSTALLING" }), manifest: manifestPage({ runtimeState: "SETUP" }) }).resolve();
  assert.equal(r.kind, "RESOLVED");
  if (r.kind !== "RESOLVED") return;
  assert.equal(r.runtime.lifecycle_state, "SETUP", "Manifest wins over locator prose");
  assert.ok(r.runtime.warnings.some((w) => w.startsWith("locator_descriptive_state_stale")));
});

test("built-in adapter registry declares at least one supported META spec line, keyed by version token", () => {
  const r = createAdapterRegistries();
  registerBuiltinMetaAdapters(r.metaRuntime);
  const supported = r.metaRuntime.supported();
  assert.ok(supported.length >= 1);
  for (const v of supported) assert.match(v, /^[A-Z_]+\/\d+\.\d+\.\d+$/);
});
