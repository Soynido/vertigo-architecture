import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("./probe-w47-event-profile.mjs", import.meta.url));

test("readonly profile check exits before credential/network work", () => {
  const out = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8", timeout: 5000 });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /no credential\/network access/);
  assert.ok(!out.stdout.includes("binding_handle"));
});

test("readonly profile rejects authority arguments before credential/network work", () => {
  for (const args of [["--plan", "foreign"], ["--operator", "other"]]) {
    const out = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 5000 });
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /fixed readonly diagnostic; no authority arguments/);
    assert.equal(out.stdout, "");
  }
});

test("authorized burst10 mode stays offline when checked and still rejects authority flags", () => {
  const out = spawnSync(process.execPath, [script, "--burst10", "--check"], { encoding: "utf8", timeout: 5000 });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /burst10; no credential\/network access/);
  for (const args of [["--burst10", "--plan", "foreign"], ["--burst10", "--burst10"], ["--burst", "100"]]) {
    const invalid = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 5000 });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /fixed readonly diagnostic; no authority arguments/);
  }
});
