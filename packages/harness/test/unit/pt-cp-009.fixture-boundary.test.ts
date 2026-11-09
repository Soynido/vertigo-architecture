/** PV0-024F — controlled, non-LIVE second SALES fixture boundary for PT-CP-009. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "../../src/config/index.ts";
import { buildDeps } from "../../src/index.ts";
import { dispatch } from "../../src/tools/handlers.ts";
import { handleOf } from "./binding-fixtures.ts";
import { writePtCp009Fixture } from "../support/pt-cp-009-fixture.ts";

test("PV0-024F: live mode refuses a serialized fixture world", () => {
  assert.throws(() => loadConfig({
    VERTIGO_META_SPEC_ROOT: "https://example.invalid/spec-root",
    HARNESS_ENV: "live_readonly",
    NOTION_READ_TOKEN: "read-only-token",
    PRINCIPALS_FILE: "principals.json",
    HARNESS_FIXTURE_WORLD_FILE: "world.json",
  }), ConfigError);
});

test("PT-CP-009 fixture: rep A has the recoverable intent and rep B cannot observe its refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vertigo-pt-cp-009-"));
  const tokenSource = join(dir, "token-source.json");
  await writeFile(tokenSource, `${JSON.stringify({ tokens: [{ token_sha256: "a".repeat(64), principal_id: "live-principal-must-not-survive" }] })}\n`, "utf8");
  const paths = await writePtCp009Fixture(join(dir, "fixture"), tokenSource);
  const deps = buildDeps({
    VERTIGO_META_SPEC_ROOT: "https://example.invalid/spec-root",
    HARNESS_ENV: "fixture",
    PRINCIPALS_FILE: paths.principals,
    SALES_RUNTIME_REGISTRY_FILE: paths.runtimes,
    HARNESS_FIXTURE_WORLD_FILE: paths.world,
  });

  const bindA = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, { principal_id: "p-rep-a" }, deps);
  const handleA = handleOf(bindA);
  const q3 = await dispatch("os_resume", { binding_handle: handleA, topic_hint: "SALES_EXTERNAL_ACTION" }, { principal_id: "p-rep-a" }, deps);
  const q4 = await dispatch("os_resume", { binding_handle: handleA, topic_hint: "SALES_EMAIL_RECONCILIATION" }, { principal_id: "p-rep-a" }, deps);
  const pack3 = (q3.status === "OK" ? (q3.result as Record<string, unknown>) : q3.observations)["contract_pack"] as { selected_pointers: Array<{ resource_key: string; refs: string[] }> };
  const pack4 = (q4.status === "OK" ? (q4.result as Record<string, unknown>) : q4.observations)["contract_pack"] as { selected_pointers: Array<{ resource_key: string; refs: string[]; selectors?: Array<{ recipient: string; thread_ref?: string }> }> };
  assert.deepEqual(pack3.selected_pointers.map((p) => p.resource_key), ["SALES:EXTERNAL_ACTIONS"]);
  assert.equal(pack3.selected_pointers[0]?.refs.length, 1);
  assert.deepEqual(pack4.selected_pointers.map((p) => p.resource_key), ["SALES:EXTERNAL_ACTIONS", "SALES:GMAIL_RECONCILIATION"]);
  assert.equal(pack4.selected_pointers[1]?.selectors?.[0]?.recipient, "prospect@example.invalid");
  assert.equal(pack4.selected_pointers[1]?.selectors?.[0]?.thread_ref, "fixture-thread-42");

  const bindB = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES" }, { principal_id: "p-rep-b" }, deps);
  const q3b = await dispatch("os_resume", { binding_handle: handleOf(bindB), topic_hint: "SALES_EXTERNAL_ACTION" }, { principal_id: "p-rep-b" }, deps);
  const packB = (q3b.status === "OK" ? (q3b.result as Record<string, unknown>) : q3b.observations)["contract_pack"] as { selected_pointers: Array<{ refs: string[] }> };
  assert.deepEqual(packB.selected_pointers[0]?.refs, []);
  assert.equal(JSON.stringify(q3b).includes(pack3.selected_pointers[0]!.refs[0]!), false, "rep B response must not contain rep A's intent ref");

  const generatedTokens = JSON.parse(await readFile(paths.tokens, "utf8")) as { tokens: Array<{ principal_id: string; token_sha256: string }> };
  assert.deepEqual(generatedTokens.tokens, [{ principal_id: "p-rep-a", token_sha256: "a".repeat(64) }]);
  for (const path of [paths.world, paths.principals, paths.runtimes]) {
    const content = await readFile(path, "utf8");
    const forbidden = [["ar", "on"].join(""), "valentin", ["studio", "vertigo.io"].join("")];
    assert.equal(forbidden.some((value) => content.toLowerCase().includes(value)), false, `${path} must contain no LIVE identity or host`);
  }
});
