/**
 * PT-PKG-009 — the uploadable archive is correct before anyone uploads it.
 *
 * The plugin now reaches ChatGPT as one .zip that Valentin drops into « Téléverser une nouvelle version ».
 * A first archive was rejected with « Plugin not found » because it carried only the portable root manifest:
 * the uploader requires one plugin folder with `.codex-plugin/plugin.json` inside it. That failure cost an
 * upload round trip, which is exactly what this test exists to prevent — the archive is built and checked here.
 * Green proves its local format only, not publication, authentication, installed host or served backend.
 *
 * The rules below are OpenAI's own, read from the plugin-creator validator (validate_plugin.py) and from the
 * loader tests in openai/codex: allowed manifest keys, strict semver, required author.name, the five required
 * interface fields, at most three starter prompts of at most 128 characters, and #RRGGBB.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const builder = fileURLToPath(new URL("../scripts/build-archive.mjs", import.meta.url));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MANIFEST_KEYS = new Set(["id", "name", "version", "description", "skills", "apps", "mcpServers", "interface", "author", "homepage", "repository", "license", "keywords"]);
const INTERFACE_KEYS = new Set(["displayName", "shortDescription", "longDescription", "developerName", "category", "capabilities", "websiteURL", "privacyPolicyURL", "termsOfServiceURL", "brandColor", "composerIcon", "logo", "logoDark", "screenshots", "defaultPrompt", "default_prompt"]);
/** A stand-in endpoint: the real one carries an access token and never enters a test or the repository. */
const URL_UNDER_TEST = "https://vertigo-os.example/mcp/0123456789abcdef";

function build(...flags) {
  const out = mkdtempSync(join(tmpdir(), "vertigo-archive-"));
  const urlFile = join(out, "url.local");
  writeFileSync(urlFile, URL_UNDER_TEST + "\n");
  execFileSync("node", [builder, urlFile, ...flags], { cwd: repoRoot, env: { ...process.env, VERTIGO_ARCHIVE_OUT: out }, encoding: "utf8" });
  const read = (rel) => readFileSync(join(out, "vertigo-os", rel), "utf8");
  const listing = execFileSync("unzip", ["-Z1", join(out, "vertigo-os.zip")], { encoding: "utf8" }).split("\n").filter(Boolean);
  return { out, listing, read, json: (rel) => JSON.parse(read(rel)) };
}

test("PT-PKG-009: the archive is one plugin folder holding the manifest ChatGPT's uploader looks for", () => {
  const { out, listing } = build();
  try {
    assert.ok(listing.includes("vertigo-os/.codex-plugin/plugin.json"), `the scaffold manifest is what « Plugin not found » was about: ${listing.join(", ")}`);
    assert.deepEqual([...new Set(listing.map((p) => p.split("/")[0]))], ["vertigo-os"], "exactly one plugin folder at the archive root");
    for (const required of ["vertigo-os/.mcp.json", "vertigo-os/plugin.json", "vertigo-os/mcp.json", "vertigo-os/skills/vertigo-os/SKILL.md"]) {
      assert.ok(listing.includes(required), `archive lacks ${required}`);
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("PT-PKG-009/l: candidate follows the portable name/subtitle limits without changing LIVE presentation or prompts", () => {
  const candidate = build("--candidate");
  const live = build();
  try {
    for (const rel of ["plugin.json", ".codex-plugin/plugin.json"]) {
      const c = candidate.json(rel);
      const iface = c.interface ?? c.extensions["com.openai"].interface;
      assert.match(c.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.ok(c.name.length <= 64);
      assert.ok(iface.shortDescription.length <= 30);
      assert.equal(iface.displayName, "VERTIGO OS harness");
      assert.deepEqual(iface.defaultPrompt, live.json(".codex-plugin/plugin.json").interface.defaultPrompt);
    }
    assert.equal(live.json(".codex-plugin/plugin.json").interface.shortDescription, "Opérez votre espace VERTIGO depuis un chat ordinaire.");
  } finally { rmSync(candidate.out, { recursive: true, force: true }); rmSync(live.out, { recursive: true, force: true }); }
});

test("PT-PKG-009/m: preparation is a hash-bound, secret-free candidate, never a release claim", () => {
  const out = mkdtempSync(join(tmpdir(), "vertigo-archive-preparation-"));
  try {
    const urlFile = join(out, "url.local");
    writeFileSync(urlFile, "https://vertigo-os.example/mcp\n");
    const log = execFileSync("node", [builder, urlFile, "--candidate", "--preparation-only"], { cwd: repoRoot, env: { ...process.env, VERTIGO_ARCHIVE_OUT: out }, encoding: "utf8" });
    const receipt = JSON.parse(readFileSync(join(out, "PREPARATION.json"), "utf8"));
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    assert.equal(receipt.status, "NOT_RELEASE");
    assert.equal(receipt.upload_allowed, false);
    assert.equal(receipt.backend_served_proved, false);
    assert.equal(typeof receipt.plugin_tree_dirty, "boolean");
    assert.match(receipt.base_revision, /^[a-f0-9]{40}$/);
    assert.match(receipt.version, SEMVER);
    assert.match(receipt.version, /-preparation\.rev-[a-f0-9]+$/);
    assert.match(log, /PREPARATION ONLY: NOT RELEASE; do not upload, install or distribute/);
    assert.equal(receipt.archive_sha256, hash(readFileSync(join(out, "vertigo-os.zip"))));
    assert.equal(receipt.source_hashes["scripts/build-archive.mjs"], hash(readFileSync(builder)));
    const canonical = readFileSync(fileURLToPath(new URL("../SKILL.candidate.md", import.meta.url)), "utf8");
    assert.equal(receipt.source_hashes["SKILL.candidate.md"], hash(canonical));
    const expected = [".codex-plugin/plugin.json", ".mcp.json", "plugin.json", "mcp.json", "skills/vertigo-os/SKILL.md"];
    assert.deepEqual(Object.keys(receipt.payload_hashes), expected);
    const entries = execFileSync("unzip", ["-Z1", join(out, "vertigo-os.zip")], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(entries.filter((p) => !p.endsWith("/")).sort(), expected.map((p) => `vertigo-os/${p}`).sort(), "only the five explicitly authored files, no credentials/dependencies/docs/receipts");
    for (const rel of expected) {
      const bytes = execFileSync("unzip", ["-p", join(out, "vertigo-os.zip"), `vertigo-os/${rel}`]);
      assert.equal(hash(bytes), receipt.payload_hashes[rel], `ZIP bytes bound for ${rel}`);
    }
    for (const rel of ["plugin.json", ".codex-plugin/plugin.json"]) assert.equal(JSON.parse(readFileSync(join(out, "vertigo-os", rel), "utf8")).version, receipt.version);
    for (const rel of ["mcp.json", ".mcp.json"]) assert.equal(JSON.parse(readFileSync(join(out, "vertigo-os", rel), "utf8")).mcpServers["vertigo-os"].url, "https://vertigo-os.example/mcp");
    const shipped = readFileSync(join(out, "vertigo-os/skills/vertigo-os/SKILL.md"), "utf8");
    assert.equal(shipped.slice(shipped.indexOf("\n---", 4) + "\n---\n\n".length), canonical);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("PT-PKG-009/n: shared preparation refuses secrets, URL decorations and LIVE, without leaking inputs", () => {
  const out = mkdtempSync(join(tmpdir(), "vertigo-archive-preparation-refused-"));
  try {
    const urlFile = join(out, "url.local");
    for (const url of [URL_UNDER_TEST, "https://test-user:test-password@vertigo-os.example/mcp", "https://vertigo-os.example/mcp?token=test-secret", "https://vertigo-os.example/mcp#test-secret", "https://vertigo-os.example/mcp?", "https://vertigo-os.example/mcp#", "https://vertigo-os.example/mcp/test-secret/../../mcp", "https://vertigo-os.example/mcp/test-secret/%2e%2e/%2e%2e/mcp"]) {
      writeFileSync(urlFile, url);
      const run = spawnSync("node", [builder, urlFile, "--candidate", "--preparation-only"], { cwd: repoRoot, env: { ...process.env, VERTIGO_ARCHIVE_OUT: out }, encoding: "utf8" });
      assert.notEqual(run.status, 0);
      assert.doesNotMatch(run.stdout + run.stderr, /0123456789abcdef|test-password|test-secret/);
      assert.ok(!existsSync(join(out, "vertigo-os.zip")));
      assert.ok(!existsSync(join(out, "PREPARATION.json")));
    }
    writeFileSync(urlFile, "https://vertigo-os.example/mcp");
    const run = spawnSync("node", [builder, urlFile, "--preparation-only"], { cwd: repoRoot, env: { ...process.env, VERTIGO_ARCHIVE_OUT: out }, encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /requires --candidate/);
    assert.ok(!existsSync(join(out, "vertigo-os.zip")));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("PT-PKG-009/o: portable candidate names reject incompatible identities before packaging", () => {
  const out = mkdtempSync(join(tmpdir(), "vertigo-archive-name-refused-"));
  try {
    const urlFile = join(out, "url.local");
    writeFileSync(urlFile, "https://vertigo-os.example/mcp");
    for (const name of ["Vertigo", "vertigo_os", "vertigo.os", "a".repeat(65), "../vertigo"]) {
      const run = spawnSync("node", [builder, urlFile, "--candidate", "--name", name], { cwd: repoRoot, env: { ...process.env, VERTIGO_ARCHIVE_OUT: out }, encoding: "utf8" });
      assert.notEqual(run.status, 0);
      assert.ok(!existsSync(join(out, `${name}.zip`)));
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("PT-PKG-009/p: candidate install separates operator/member from historical engineering without host-ready claims", () => {
  const install = readFileSync(fileURLToPath(new URL("../docs/INSTALL.md", import.meta.url)), "utf8");
  const candidate = install.slice(0, install.indexOf("## Référence LIVE / ingénierie historique"));
  assert.match(candidate, /BUILD TARGET — NOT ADOPTED/);
  assert.match(candidate, /Aucun terminal, Git, Node\/PostgreSQL, mode développeur, clé Notion/);
  assert.match(candidate, /n'exige pas de connecteur Notion natif pour ses écritures/);
  assert.match(candidate, /chat ChatGPT ordinaire neuf, jamais Work\/Codex/);
  assert.match(candidate, /`@` puis son nom exact/);
  assert.match(candidate, /critère à tester en W7\.3/);
  assert.match(candidate, /authentification par personne/);
  assert.match(candidate, /seulement après.*validation de la remplaçante/s);
  assert.match(candidate, /GW7\.1 reste DEFERRED_NOT_PASS/);
  assert.match(candidate, /VPS≤10USD\/mois/);
  assert.doesNotMatch(candidate, /This archive.*serves everyone/);
});

test("PT-PKG-009/b: the scaffold manifest satisfies every rule OpenAI's own validator enforces", () => {
  const { out, json } = build();
  try {
    const m = json(".codex-plugin/plugin.json");
    assert.deepEqual([...Object.keys(m)].filter((k) => !MANIFEST_KEYS.has(k)), [], "a key outside the allowed set is refused, `$schema` included");
    assert.match(m.name, /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/);
    assert.match(m.version, SEMVER, "strict semver");
    assert.ok(m.description?.trim());
    assert.ok(m.author?.name?.trim(), "author.name is required");
    assert.deepEqual([...Object.keys(m.author)].filter((k) => !["name", "email", "url"].includes(k)), []);
    assert.ok(m.author.url === undefined || m.author.url.startsWith("https://"));
    assert.equal(m.skills, "./skills/", "a declared skills path must resolve to `skills`");
    assert.equal(m.mcpServers, "./.mcp.json", "a string mcpServers path must resolve to `.mcp.json`");
    const i = m.interface;
    assert.ok(i, "interface is required");
    assert.deepEqual([...Object.keys(i)].filter((k) => !INTERFACE_KEYS.has(k)), []);
    for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) assert.ok(i[field]?.trim(), `interface.${field} is required`);
    assert.ok(Array.isArray(i.capabilities) && i.capabilities.every((c) => typeof c === "string" && c.trim()));
    assert.ok(Array.isArray(i.defaultPrompt) && i.defaultPrompt.length > 0 && i.defaultPrompt.length <= 3, "at most three starter prompts, and at least one is required");
    for (const p of i.defaultPrompt) assert.ok(p.length <= 128, `starter prompt over 128 chars: ${p}`);
    assert.match(i.brandColor, /^#[0-9A-Fa-f]{6}$/);
    for (const field of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL"]) if (i[field] !== undefined) assert.ok(i[field].startsWith("https://"), `interface.${field} must be https`);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("PT-PKG-009/c: both layouts describe the same plugin and the same single remote MCP server", () => {
  const { out, json } = build();
  try {
    const scaffold = json(".codex-plugin/plugin.json");
    const portable = json("plugin.json");
    assert.equal(portable.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    assert.equal(portable.name, scaffold.name);
    assert.equal(portable.version, scaffold.version, "a divergent version would install two different plugins");
    const legacy = json(".mcp.json");
    const agent = json("mcp.json");
    assert.deepEqual(Object.keys(legacy.mcpServers), ["vertigo-os"]);
    assert.deepEqual(Object.keys(agent.mcpServers), ["vertigo-os"], "the overlay only reaches a server of the same name");
    assert.deepEqual(Object.keys(legacy.mcpServers["vertigo-os"]), ["url"], "the legacy entry is the bare-url shape the loader tests use");
    assert.equal(agent.mcpServers["vertigo-os"].type, "streamable-http");
    assert.equal(legacy.mcpServers["vertigo-os"].url, URL_UNDER_TEST);
    assert.equal(agent.mcpServers["vertigo-os"].url, URL_UNDER_TEST);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("PT-PKG-009/e: a tokenless endpoint produces one archive the whole team can install", () => {
  // The point of PV-CRED-001: with the credential in each application's authentication field instead of the URL,
  // the archive stops being a secret, so it is built once and installed by everyone.
  const out = mkdtempSync(join(tmpdir(), "vertigo-archive-shared-"));
  try {
    const urlFile = join(out, "url.local");
    writeFileSync(urlFile, "https://vertigo-os.example/mcp\n");
    const log = execFileSync("node", [builder, urlFile], { cwd: repoRoot, env: { ...process.env, VERTIGO_ARCHIVE_OUT: out }, encoding: "utf8" });
    assert.match(log, /carries no credential/);
    assert.doesNotMatch(log, /WARNING/);
    for (const rel of [".mcp.json", "mcp.json"]) {
      const servers = JSON.parse(readFileSync(join(out, "vertigo-os", rel), "utf8")).mcpServers["vertigo-os"];
      assert.equal(servers.url, "https://vertigo-os.example/mcp", `${rel} carries the bare endpoint`);
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("PT-PKG-009/q: a private candidate update preserves verified app bytes and both manifest bindings", () => {
  const input = mkdtempSync(join(tmpdir(), "vertigo-existing-app-"));
  let built;
  try {
    const appsText = JSON.stringify({ apps: { connector: { id: "asdk_app_EXAMPLE" } } }, null, 2) + "\n";
    const appsFile = join(input, "apps.json");
    writeFileSync(appsFile, appsText);
    built = build("--candidate", "--apps-file", appsFile);
    assert.equal(built.read(".app.json"), appsText);
    assert.equal(execFileSync("unzip", ["-p", join(built.out, "vertigo-os.zip"), "vertigo-os/.app.json"], { encoding: "utf8" }), appsText);
    const scaffold = built.json(".codex-plugin/plugin.json");
    const portable = built.json("plugin.json");
    assert.equal(scaffold.apps, "./.app.json");
    assert.equal(portable.extensions["com.openai"].apps, scaffold.apps);
    assert.deepEqual(scaffold.keywords, portable.keywords);
    assert.deepEqual(scaffold.interface, portable.extensions["com.openai"].interface);
    assert.deepEqual(scaffold.interface.defaultPrompt, ["On reprend où on en est.", "Voici ma réponse à la question en cours.", "Passe-moi le relais pour cette conversation."]);
    for (const rel of ["mcp.json", ".mcp.json"]) {
      const servers = built.json(rel).mcpServers;
      assert.deepEqual(Object.keys(servers), ["vertigo-os"]);
      assert.equal(servers["vertigo-os"].url, URL_UNDER_TEST, "the existing operator connection is retained, never inferred from the app ID");
    }
    assert.equal(built.listing.filter((p) => !p.endsWith("/")).length, 6);
  } finally { if (built) rmSync(built.out, { recursive: true, force: true }); rmSync(input, { recursive: true, force: true }); }
});

test("PT-PKG-009/s: registered-app-only private candidate has no bundled MCP or endpoint, but preserves its skill and app", () => {
  const input = mkdtempSync(join(tmpdir(), "vertigo-registered-app-"));
  let built;
  try {
    const appsText = JSON.stringify({ apps: { connector: { id: "asdk_app_EXAMPLE" } } }, null, 2) + "\n";
    const appsFile = join(input, "apps.json");
    writeFileSync(appsFile, appsText);
    built = build("--candidate", "--apps-file", appsFile, "--registered-app-only");
    const overlay = built.json(".codex-plugin/plugin.json");
    const portable = built.json("plugin.json");
    assert.equal(overlay.apps, "./.app.json");
    assert.equal(portable.extensions["com.openai"].apps, overlay.apps);
    assert.equal(built.read(".app.json"), appsText);
    assert.equal(overlay.mcpServers, undefined);
    assert.equal(portable.mcpServers, undefined);
    assert.equal(portable.extensions["com.openai"].mcpServers, undefined);
    assert.ok(!existsSync(join(built.out, "vertigo-os/.mcp.json")));
    assert.ok(!existsSync(join(built.out, "vertigo-os/mcp.json")));
    assert.equal(built.listing.filter((p) => !p.endsWith("/")).length, 4);
    for (const path of built.listing.filter((p) => !p.endsWith("/"))) {
      const text = execFileSync("unzip", ["-p", join(built.out, "vertigo-os.zip"), path], { encoding: "utf8" });
      assert.ok(!text.includes(URL_UNDER_TEST), "unused credential URL must never enter the registered-app package");
      assert.ok(!text.includes("0123456789abcdef"));
    }
    const candidate = build("--candidate");
    try {
      assert.equal(built.read("skills/vertigo-os/SKILL.md"), candidate.read("skills/vertigo-os/SKILL.md"));
      assert.deepEqual(overlay.interface, candidate.json(".codex-plugin/plugin.json").interface);
    } finally { rmSync(candidate.out, { recursive: true, force: true }); }
    // An app reference is the connection: this mode must not read an obsolete URL file at all.
    const absent = spawnSync("node", [builder, join(input, "absent.url"), "--candidate", "--apps-file", appsFile, "--registered-app-only"], { cwd: repoRoot, env: { ...process.env, VERTIGO_ARCHIVE_OUT: built.out }, encoding: "utf8" });
    assert.equal(absent.status, 0, absent.stderr);
    assert.doesNotMatch(absent.stdout, /same file serves everyone|mcp endpoint:/);
  } finally { if (built) rmSync(built.out, { recursive: true, force: true }); rmSync(input, { recursive: true, force: true }); }
});

test("PT-PKG-009/u: native candidate preparation hashes four secret-free files without claiming member access", () => {
  const out = mkdtempSync(join(tmpdir(), "vertigo-native-preparation-"));
  try {
    const appsFile = join(out, "apps.json");
    const appsText = JSON.stringify({ apps: { connector: { id: "asdk_app_EXAMPLE" } } });
    writeFileSync(appsFile, appsText);
    // The same app file without native-only mode must still refuse shared/MCP preparation.
    const refused = spawnSync("node", [builder, "--candidate", "--preparation-only", "--apps-file", appsFile], { cwd: repoRoot, env: { ...process.env, VERTIGO_ARCHIVE_OUT: out }, encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.ok(!existsSync(join(out, "vertigo-os.zip")));
    assert.ok(!existsSync(join(out, "PREPARATION.json")));
    const log = execFileSync("node", [builder, join(out, "absent.url"), "--candidate", "--preparation-only", "--registered-app-only", "--apps-file", appsFile], { cwd: repoRoot, env: { ...process.env, VERTIGO_ARCHIVE_OUT: out }, encoding: "utf8" });
    const receipt = JSON.parse(readFileSync(join(out, "PREPARATION.json"), "utf8"));
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const expected = [".codex-plugin/plugin.json", "plugin.json", ".app.json", "skills/vertigo-os/SKILL.md"];
    assert.equal(receipt.status, "NOT_RELEASE");
    assert.equal(receipt.upload_allowed, false);
    assert.equal(receipt.backend_served_proved, false);
    assert.equal(receipt.connection_mode, "REGISTERED_APP_ONLY");
    assert.equal(receipt.member_access_proved, false);
    assert.match(receipt.version, /-preparation\.rev-[a-f0-9]+$/);
    assert.equal(receipt.archive_sha256, hash(readFileSync(join(out, "vertigo-os.zip"))));
    assert.equal(receipt.source_hashes[".app.json"], hash(appsText));
    assert.deepEqual(Object.keys(receipt.payload_hashes), expected);
    const entries = execFileSync("unzip", ["-Z1", join(out, "vertigo-os.zip")], { encoding: "utf8" }).trim().split("\n").filter(p => !p.endsWith("/"));
    assert.deepEqual(entries.sort(), expected.map(p => `vertigo-os/${p}`).sort());
    for (const rel of expected) {
      const bytes = execFileSync("unzip", ["-p", join(out, "vertigo-os.zip"), `vertigo-os/${rel}`]);
      assert.equal(hash(bytes), receipt.payload_hashes[rel]);
      assert.doesNotMatch(bytes.toString(), /https:\/\/vertigo-os\.example|0123456789abcdef/);
    }
    for (const rel of ["plugin.json", ".codex-plugin/plugin.json"]) {
      const m = JSON.parse(readFileSync(join(out, "vertigo-os", rel), "utf8"));
      assert.equal(m.version, receipt.version);
      assert.equal(m.mcpServers, undefined);
      assert.equal(m.apps ?? m.extensions["com.openai"].apps, "./.app.json");
    }
    assert.equal(readFileSync(join(out, "vertigo-os/.app.json"), "utf8"), appsText);
    const skill = readFileSync(join(out, "vertigo-os/skills/vertigo-os/SKILL.md"), "utf8");
    const prefix = skill.match(/^---\n[\s\S]*?\n---\n\n/)[0];
    assert.equal(skill.slice(prefix.length), readFileSync(fileURLToPath(new URL("../SKILL.candidate.md", import.meta.url)), "utf8"));
    assert.match(log, /PREPARATION ONLY: NOT RELEASE/);
    assert.doesNotMatch(log, /same file serves everyone|mcp endpoint:/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("PT-PKG-009/t: registered-app-only refuses missing/unregistered apps, LIVE and decorated mode", () => {
  const input = mkdtempSync(join(tmpdir(), "vertigo-registered-app-refused-"));
  try {
    const appsFile = join(input, "apps.json");
    for (const [apps, flags] of [
      [{ apps: { connector: { id: "asdk_app_fixture" } } }, ["--candidate"]],
      [{ apps: { connector: { id: "asdk_app_fixture" } } }, ["--apps-file", appsFile]],
      [{ apps: { connector: { id: "fixture" } } }, ["--candidate", "--apps-file", appsFile]],
      [{ apps: { a: { id: "asdk_app_a" }, b: { id: "asdk_app_b" } } }, ["--candidate", "--apps-file", appsFile]],
    ]) {
      writeFileSync(appsFile, JSON.stringify(apps));
      const out = mkdtempSync(join(input, "refused-"));
      const run = spawnSync("node", [builder, "--registered-app-only", ...flags], { cwd: repoRoot, env: { ...process.env, VERTIGO_ARCHIVE_OUT: out }, encoding: "utf8" });
      assert.notEqual(run.status, 0);
      assert.ok(!existsSync(join(out, "vertigo-os.zip")));
    }
    const out = mkdtempSync(join(input, "decorated-"));
    writeFileSync(appsFile, JSON.stringify({ apps: { connector: { id: "asdk_app_fixture" } } }));
    const run = spawnSync("node", [builder, "--candidate", "--apps-file", appsFile, "--registered-app-only=true"], { cwd: repoRoot, env: { ...process.env, VERTIGO_ARCHIVE_OUT: out }, encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /registered-app-only/);
    assert.ok(!existsSync(join(out, "vertigo-os.zip")));
  } finally { rmSync(input, { recursive: true, force: true }); }
});

test("PT-PKG-009/r: app preservation refuses LIVE, shared preparation and credential-bearing app files", () => {
  const out = mkdtempSync(join(tmpdir(), "vertigo-app-preservation-refused-"));
  try {
    const urlFile = join(out, "url.local");
    const appsFile = join(out, "apps.json");
    writeFileSync(urlFile, "https://vertigo-os.example/mcp\n");
    const valid = JSON.stringify({ apps: { connector: { id: "asdk_app_EXAMPLE" } } });
    for (const flags of [["--apps-file"], ["--apps-file="], ["--apps-file", "--candidate"]]) {
      const run = spawnSync("node", [builder, urlFile, "--candidate", ...flags], { cwd: repoRoot, env: { ...process.env, VERTIGO_ARCHIVE_OUT: out }, encoding: "utf8" });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /requires an existing verified app file/);
      assert.ok(!existsSync(join(out, "vertigo-os.zip")));
    }
    for (const flags of [[], ["--candidate", "--preparation-only"]]) {
      writeFileSync(appsFile, valid);
      const run = spawnSync("node", [builder, urlFile, ...flags, "--apps-file", appsFile], { cwd: repoRoot, env: { ...process.env, VERTIGO_ARCHIVE_OUT: out }, encoding: "utf8" });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /only for a final private candidate update/);
      assert.ok(!existsSync(join(out, "vertigo-os.zip")));
    }
    for (const value of ["not JSON", "null", JSON.stringify({ apps: {} }), JSON.stringify({ apps: { connector: { id: "asdk_app_EXAMPLE", token: "test-private-credential" } } }), JSON.stringify({ apps: { connector: { id: "https://example.test/test-private-credential" } } }), '{"apps":{"connector":{"id":"fixture","token":"test-private-credential"}},"apps":{"connector":{"id":"fixture"}}}', '{"apps":{"connector":{"id":"https://example.test/test-private-credential","id":"fixture"}}}', JSON.stringify({ apps: { "https://example.test/test-private-credential": { id: "fixture" } } })]) {
      writeFileSync(appsFile, value);
      const run = spawnSync("node", [builder, urlFile, "--candidate", "--apps-file", appsFile], { cwd: repoRoot, env: { ...process.env, VERTIGO_ARCHIVE_OUT: out }, encoding: "utf8" });
      assert.notEqual(run.status, 0);
      assert.doesNotMatch(run.stdout + run.stderr, /test-private-credential/);
      assert.ok(!existsSync(join(out, "vertigo-os.zip")));
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("PT-PKG-009/f: an archive that still embeds a token says so, loudly, because it belongs to one person", () => {
  const { out, listing } = build();
  try {
    const log = execFileSync("node", [builder, join(out, "url.local")], { cwd: repoRoot, env: { ...process.env, VERTIGO_ARCHIVE_OUT: out }, encoding: "utf8" });
    assert.match(log, /WARNING: this archive embeds a credential/);
    assert.match(log, /never share it/);
    assert.ok(listing.length > 0);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("PT-PKG-009/d: the shipped skill is the repository's, with the frontmatter the format needs and no endpoint token", () => {
  const { out, read, listing } = build();
  try {
    const shipped = read("skills/vertigo-os/SKILL.md");
    const canonical = readFileSync(fileURLToPath(new URL("../SKILL.md", import.meta.url)), "utf8");
    assert.ok(shipped.startsWith("---\nname: vertigo-os\ndescription: "), "YAML frontmatter, opened on the first line");
    const end = shipped.indexOf("\n---", 4);
    assert.ok(end > 0, "the frontmatter is closed");
    assert.equal(shipped.slice(end + "\n---\n\n".length), canonical, "the body is the canonical skill, byte for byte");
    assert.ok(shipped.includes("next.conduct"), "the conduct meta-rule travels with the upload");
    for (const entry of listing.filter((p) => p.endsWith("SKILL.md"))) assert.ok(!read(entry.replace("vertigo-os/", "")).includes("/mcp/"), "no endpoint token inside a skill");
  } finally { rmSync(out, { recursive: true, force: true }); }
});

/** The version ChatGPT holds today, read from the upload page on 2026-09-29: every new archive must exceed it. */
const INSTALLED_VERSION = "1.0.142";
const numeric = (v) => v.split(/[-+]/)[0].split(".").map(Number);
const newer = (a, b) => { const [x, y] = [numeric(a), numeric(b)]; for (let k = 0; k < 3; k++) if (x[k] !== y[k]) return x[k] > y[k]; return false; };

test("PT-PKG-009/g: --candidate ships the skill the candidate server serves, byte for byte, under one MCP server", () => {
  const { out, read, json, listing } = build("--candidate");
  try {
    const shipped = read("skills/vertigo-os/SKILL.md");
    const candidate = readFileSync(fileURLToPath(new URL("../SKILL.candidate.md", import.meta.url)), "utf8");
    const live = readFileSync(fileURLToPath(new URL("../SKILL.md", import.meta.url)), "utf8");
    assert.ok(shipped.startsWith("---\nname: vertigo-os\ndescription: "));
    const body = shipped.slice(shipped.indexOf("\n---", 4) + "\n---\n\n".length);
    assert.equal(body, candidate, "the body is SKILL.candidate.md, byte for byte");
    assert.notEqual(body, live, "never the LIVE skill");
    assert.deepEqual(listing.filter((p) => p.endsWith("SKILL.md")), ["vertigo-os/skills/vertigo-os/SKILL.md"], "one skill, no LIVE copy beside it");
    for (const rel of [".mcp.json", "mcp.json"]) {
      const servers = json(rel).mcpServers;
      assert.deepEqual(Object.keys(servers), ["vertigo-os"], `${rel} declares exactly one server`);
      assert.equal(servers["vertigo-os"].url, URL_UNDER_TEST);
    }
    assert.ok(!body.includes("/mcp/"), "no endpoint token inside the skill");
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("PT-PKG-009/h: the candidate manifest describes five tools and backend writes; the LIVE default stays read-only", () => {
  const cand = build("--candidate");
  const live = build();
  try {
    const c = cand.json(".codex-plugin/plugin.json");
    const l = live.json(".codex-plugin/plugin.json");
    assert.deepEqual([...Object.keys(c)].filter((k) => !MANIFEST_KEYS.has(k)), []);
    assert.deepEqual([...Object.keys(c.interface)].filter((k) => !INTERFACE_KEYS.has(k)), []);
    assert.deepEqual(c.interface.capabilities, ["Read", "Write"]);
    assert.deepEqual(l.interface.capabilities, ["Read"], "Write is declared by the candidate only");
    const text = c.interface.longDescription;
    for (const tool of ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"]) assert.ok(text.includes(tool), `longDescription names ${tool}`);
    for (const gone of ["os_prepare", "os_verify", "Six outils"]) assert.ok(!text.includes(gone), `longDescription still says ${gone}`);
    assert.match(text, /^Cinq outils/);
    assert.match(l.interface.longDescription, /^Six outils/);
    assert.deepEqual(cand.json("plugin.json").extensions["com.openai"].interface, c.interface, "both layouts carry the same interface");
    // Updating the installed plugin matches it by name and description: the candidate must not change either.
    assert.equal(c.name, l.name);
    assert.equal(c.description, l.description);
    assert.equal(cand.read("skills/vertigo-os/SKILL.md").split("\n---", 1)[0], live.read("skills/vertigo-os/SKILL.md").split("\n---", 1)[0], "the same skill trigger");
  } finally { rmSync(cand.out, { recursive: true, force: true }); rmSync(live.out, { recursive: true, force: true }); }
});

test("PT-PKG-009/i: the archive version is strictly greater than the installed one", () => {
  const { out, json } = build("--candidate");
  try {
    for (const rel of [".codex-plugin/plugin.json", "plugin.json"]) {
      const { version } = json(rel);
      assert.match(version, SEMVER);
      assert.ok(newer(version, INSTALLED_VERSION), `${rel} version ${version} must exceed the installed ${INSTALLED_VERSION}`);
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("PT-PKG-009/j: --with-notion is refused, and no archive is written", () => {
  const out = mkdtempSync(join(tmpdir(), "vertigo-archive-notion-"));
  try {
    const urlFile = join(out, "url.local");
    writeFileSync(urlFile, URL_UNDER_TEST + "\n");
    for (const extra of [["--with-notion"], ["--candidate", "--with-notion"], ["--with-notion=1"]]) {
      const run = spawnSync("node", [builder, urlFile, ...extra], { cwd: repoRoot, env: { ...process.env, VERTIGO_ARCHIVE_OUT: out }, encoding: "utf8" });
      assert.notEqual(run.status, 0, `${extra.join(" ")} must fail`);
      assert.match(run.stderr, /--with-notion is withdrawn/);
      assert.ok(!existsSync(join(out, "vertigo-os.zip")), "nothing is packaged");
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("PT-PKG-009/k: without SKILL.candidate.md, --candidate stops instead of shipping the LIVE skill", () => {
  // A copy of the builder in a tree that holds only the LIVE skill: the candidate build must fail, not fall back.
  const tree = mkdtempSync(join(tmpdir(), "vertigo-archive-nocandidate-"));
  try {
    const scripts = join(tree, "packages/plugin/scripts");
    mkdirSync(scripts, { recursive: true });
    copyFileSync(builder, join(scripts, "build-archive.mjs"));
    copyFileSync(fileURLToPath(new URL("../SKILL.md", import.meta.url)), join(tree, "packages/plugin/SKILL.md"));
    writeFileSync(join(tree, "url.local"), URL_UNDER_TEST + "\n");
    const run = spawnSync("node", [join(scripts, "build-archive.mjs"), join(tree, "url.local"), "--candidate"], { cwd: tree, env: { ...process.env, VERTIGO_ARCHIVE_OUT: join(tree, "out") }, encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /SKILL\.candidate\.md.*never falls back/);
    assert.ok(!existsSync(join(tree, "out", "vertigo-os.zip")));
  } finally { rmSync(tree, { recursive: true, force: true }); }
});
