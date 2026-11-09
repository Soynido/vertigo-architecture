import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig } from "../../src/config/index.ts";

const base = { VERTIGO_META_SPEC_ROOT: "https://example.invalid/root", HARNESS_ENV: "fixture", PRINCIPALS_FILE: "./p.json" };

test("defaults TTLs are server-owned and positive", () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.bindingTtlHours, 24);
  assert.equal(cfg.planTtlMinutes, 15);
  assert.equal(cfg.targetReceiptTtlMinutes, 10);
  assert.equal(cfg.databaseUrl, undefined);
});

test("live requires a Notion token; canonical and legacy names both load (W3.5a)", () => {
  for (const HARNESS_ENV of ["live", "live_readonly"]) {
    assert.throws(() => loadConfig({ ...base, HARNESS_ENV }), ConfigError);
    assert.equal(loadConfig({ ...base, HARNESS_ENV, NOTION_TOKEN: "t" }).notionReadToken, "t");
    assert.equal(loadConfig({ ...base, HARNESS_ENV, NOTION_READ_TOKEN: "t" }).notionReadToken, "t");
    assert.equal(loadConfig({ ...base, HARNESS_ENV, NOTION_TOKEN: "t" }).harnessEnv, "live_readonly");
  }
});

test("NOTION_TOKEN and NOTION_READ_TOKEN: equal values load, different values fail closed", () => {
  assert.equal(loadConfig({ ...base, HARNESS_ENV: "live", NOTION_TOKEN: "t", NOTION_READ_TOKEN: "t" }).notionReadToken, "t");
  for (const HARNESS_ENV of ["fixture", "live", "live_readonly"]) {
    assert.throws(() => loadConfig({ ...base, HARNESS_ENV, NOTION_TOKEN: "a", NOTION_READ_TOKEN: "b" }), (err: unknown) => err instanceof ConfigError && err.message.includes("differ"));
  }
});

test("serialized fixture worlds fail closed outside fixture mode", () => {
  assert.equal(loadConfig({ ...base, HARNESS_FIXTURE_WORLD_FILE: "world.json" }).fixtureWorldFile, "world.json");
  assert.throws(() => loadConfig({ ...base, HARNESS_ENV: "live_readonly", NOTION_READ_TOKEN: "t", HARNESS_FIXTURE_WORLD_FILE: "world.json" }), ConfigError);
  assert.throws(() => loadConfig({ ...base, HARNESS_ENV: "live", NOTION_TOKEN: "t", HARNESS_FIXTURE_WORLD_FILE: "world.json" }), ConfigError);
});

test("live HTTP still requires the served-build attestation under the canonical name", () => {
  const http = { ...base, HARNESS_ENV: "live", NOTION_TOKEN: "t", HARNESS_TRANSPORT: "http", HARNESS_HTTP_TOKENS_FILE: "./t.json" };
  assert.throws(() => loadConfig(http), (err: unknown) => err instanceof ConfigError && err.message.includes("HARNESS_BUILD_REVISION"));
  assert.doesNotThrow(() => loadConfig({ ...http, HARNESS_BUILD_REVISION: "a".repeat(40), HARNESS_BUILD_DIRTY: "false", HARNESS_CONFIG_FINGERPRINT: "b".repeat(64) }));
});

test("rejects unknown HARNESS_ENV and missing SPEC_ROOT", () => {
  assert.throws(() => loadConfig({ ...base, HARNESS_ENV: "prod" }), ConfigError);
  assert.throws(() => loadConfig({ ...base, HARNESS_ENV: "LIVE" }), ConfigError);
  assert.throws(() => loadConfig({ HARNESS_ENV: "fixture", PRINCIPALS_FILE: "p" }), ConfigError);
});
