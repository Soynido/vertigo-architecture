import { test } from "node:test";
import assert from "node:assert/strict";
import { generateHandle, handleMatches, hashHandle, runtimeGeneration } from "../../src/binding/handle.ts";
import { canMutate, nextBindingState } from "../../src/binding/store.ts";

test("handles are 32 random bytes base64url, stored as hash, and verify", () => {
  const h = generateHandle();
  assert.equal(Buffer.from(h, "base64url").length, 32);
  assert.notEqual(h, generateHandle());
  assert.ok(handleMatches(h, hashHandle(h)));
  assert.ok(!handleMatches(generateHandle(), hashHandle(h)));
});

test("runtime generation changes when root or manifest identity rotates", () => {
  const a = runtimeGeneration({ logicalKey: "VERTIGO/META", rootId: "root-a", manifestId: "man-a", pointerGeneration: "1" });
  assert.equal(a, runtimeGeneration({ logicalKey: "VERTIGO/META", rootId: "root-a", manifestId: "man-a", pointerGeneration: "1" }));
  assert.notEqual(a, runtimeGeneration({ logicalKey: "VERTIGO/META", rootId: "root-b", manifestId: "man-a", pointerGeneration: "1" }));
  assert.notEqual(a, runtimeGeneration({ logicalKey: "VERTIGO/META", rootId: "root-a", manifestId: "man-b", pointerGeneration: "1" }));
});

test("binding state machine: rotation ⇒ STALE and stale bindings cannot mutate", () => {
  assert.equal(nextBindingState("BOUND", "RUNTIME_UNCHANGED"), "BOUND");
  assert.equal(nextBindingState("BOUND", "RUNTIME_ROTATED"), "STALE");
  assert.equal(nextBindingState("BOUND", "AUTH_REVOKED"), "REVOKED");
  assert.equal(nextBindingState("BOUND", "TTL_EXCEEDED"), "EXPIRED");
  assert.equal(nextBindingState("STALE", "RUNTIME_UNCHANGED"), "STALE");
  assert.ok(canMutate("BOUND"));
  for (const s of ["STALE", "REVOKED", "EXPIRED"] as const) assert.ok(!canMutate(s));
});
