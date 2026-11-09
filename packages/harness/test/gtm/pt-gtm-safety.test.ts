/**
 * GTM-W03 — static safety and determinism guard.
 *
 * Proves that the fixture package targets nothing live: no URL, no live mailbox domain, no runtime or page
 * identifier shape, no production provider adapter import, no external effect, no new tool. Also proves the
 * package is deterministic and that its reset contract rebuilds the pristine baseline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles, REPO_ROOT, scan } from "../arch/scan.ts";
import { FIXTURE_DOMAIN } from "./catalog.ts";
import { buildGtmWorld, canonicalize, fingerprint, resetGtmWorld, withCanceledEpisode } from "./world.ts";

const GTM_DIR = fileURLToPath(new URL("./", import.meta.url));
const SELF = "pt-gtm-safety.test.ts";
const files = async () => listFiles(GTM_DIR, [".ts", ".md", ".json"]);
const notSelf = (file: string) => file.endsWith(SELF);

// Built from parts so this guard never itself contains the value it forbids.
const LIVE_HOST = ["studio", "vertigo", ".io"].join("");
const LIVE_MAIL_HOSTS = [LIVE_HOST, ["gmail", ".com"].join(""), ["notion", ".so"].join(""), ["notion", ".site"].join("")];

test("GTM-W03/safety a: the package contains no live URL, host, mailbox domain or identifier shape", async () => {
  const patterns = [
    /https?:\/\//,
    ...LIVE_MAIL_HOSTS.map((h) => new RegExp(h.replace(/\./g, "\\."), "i")),
    /\b[0-9a-f]{32}\b/,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
    /collection:\/\//,
  ];
  const hits = await scan(await files(), patterns, notSelf);
  assert.deepEqual(hits, [], `live target found:\n${hits.map((h) => `${h.file}:${h.line} ${h.text}`).join("\n")}`);
});

test("GTM-W03/safety b: every identity in the package uses the reserved, unroutable fixture domain", async () => {
  const address = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g;
  const offenders: string[] = [];
  for (const file of await files()) {
    if (file.endsWith(SELF)) continue;
    const text = await readFile(file, "utf8");
    for (const match of text.match(address) ?? []) {
      if (!match.endsWith(`@${FIXTURE_DOMAIN}`)) offenders.push(`${file}: ${match}`);
    }
  }
  assert.deepEqual(offenders, []);
  const world = buildGtmWorld();
  for (const c of world.contacts) assert.ok(c.canonical_identity.endsWith(`@${FIXTURE_DOMAIN}`));
  for (const row of [...world.contacts, ...world.messages, ...world.episodes]) assert.equal(row.provenance.non_live, "NON_LIVE_SYNTHETIC_FIXTURE");
  for (const r of world.runtimes) assert.equal(r.runtime_scope, "FIXTURE");
});

test("GTM-W03/safety c: no production source import, no provider adapter, no external effect", async () => {
  const hits = await scan(await files(), [
    /from\s+["'][^"']*\/src\//, /require\(/, /\bfetch\(/, /node:fs(?!\/promises")/, /node:net|node:http|node:https|node:dgram/,
    /child_process|execSync|spawnSync/, /googleapis|nodemailer|@modelcontextprotocol|\bfrom\s+["']pg["']/,
    /process\.env/, /from\s+["'][^"']*(notion|gmail|google|calendar|provider|adapter)/i, /api\.(notion|google)/i,
  ], (file, line) => notSelf(file) || /^\s*\*/.test(line) || /^\s*\/\//.test(line));
  assert.deepEqual(hits, [], `forbidden dependency or effect:\n${hits.map((h) => `${h.file}:${h.line} ${h.text}`).join("\n")}`);

  // The only runtime imports the package makes are node:crypto (hashing) plus its own modules; the tests add
  // node:test, node:assert/strict, node:fs/promises, node:path and node:url for this static guard alone.
  const imports = new Set<string>();
  for (const file of await files()) {
    for (const m of (await readFile(file, "utf8")).matchAll(/from\s+["'](node:[^"']+)["']/g)) imports.add(m[1] as string);
  }
  assert.deepEqual([...imports].sort(), ["node:assert/strict", "node:crypto", "node:fs/promises", "node:path", "node:test", "node:url"]);
});

test("GTM-W03/safety d: the package adds no tool and leaves the six-tool surface untouched", async () => {
  const hits = await scan(await files(), [/\bos_(bind|resume|prepare|verify|handoff|control_status)\b/], notSelf);
  assert.deepEqual(hits, [], "the fixture package neither calls nor redefines a tool of the surface");
  const manifest = JSON.parse(await readFile(join(REPO_ROOT, "packages/plugin/manifest.json"), "utf8")) as { tools: readonly string[] };
  assert.deepEqual([...manifest.tools].sort(), ["os_bind", "os_control_status", "os_handoff", "os_prepare", "os_resume", "os_verify"]);
  assert.equal(manifest.tools.length, 6);
});

test("GTM-W03/safety e: the world is deterministic and the reset contract rebuilds the pristine baseline", () => {
  const a = buildGtmWorld();
  const b = buildGtmWorld();
  assert.deepEqual(a, b);
  assert.equal(fingerprint(a), fingerprint(b));
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(fingerprint(JSON.parse(JSON.stringify(a))), fingerprint(a), "the fingerprint survives a serialization round trip");
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.contacts) && Object.isFrozen(a.contacts[0]), "the baseline is deeply frozen");

  const derived = withCanceledEpisode(a, "EP-M01");
  assert.notEqual(fingerprint(derived), fingerprint(a));
  assert.deepEqual(buildGtmWorld(), a, "a derived variant never touches the baseline");
  assert.equal(fingerprint(resetGtmWorld()), fingerprint(a));
});
