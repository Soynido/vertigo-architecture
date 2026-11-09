#!/usr/bin/env node
/**
 * Builds the ChatGPT plugin archive that Valentin uploads through « Téléverser une nouvelle version » —
 * the ONE file, produced from the repository, never hand-edited.
 *
 * FORMAT. ChatGPT's uploader looks for the Codex-scaffold manifest: "Each ZIP must contain one plugin folder
 * with `.codex-plugin/plugin.json` inside it" (developers.openai.com/api/docs/guides/agents-api/tools/plugins).
 * A first archive carrying only the portable root `plugin.json` was rejected with « Plugin not found ».
 * Codex also supports the portable Agent Plugins layout, and reads `.codex-plugin/plugin.json` as an overlay on
 * top of it (codex-rs/core-plugins/src/agent_plugin_mcp_overlay.rs), so this archive ships BOTH, declaring the
 * same MCP server under the same name in each:
 *
 *   vertigo-os/
 *   ├── .codex-plugin/plugin.json   scaffold manifest — what the uploader requires
 *   ├── .mcp.json                   its MCP companion: one remote server, bare `url` (loader_tests.rs)
 *   ├── plugin.json                 portable Agent Plugins manifest ($schema 1.0.0)
 *   ├── mcp.json                    its MCP companion: type `streamable-http` + url
 *   └── skills/vertigo-os/SKILL.md  the frozen skill, with the frontmatter the format requires
 *
 * ONE MCP SERVER. Both manifests declare exactly one server, VERTIGO's own. `--with-notion` (Notion's MCP server as a
 * second server of the same plugin) is withdrawn and refused: Notion writes belong to the backend (PV-WRITE-001).
 *
 * LIVE BY DEFAULT. Without a flag the archive ships `SKILL.md`, the six-tool LIVE skill, unchanged. `--candidate`
 * ships `SKILL.candidate.md` — the skill the candidate server serves — with the five-tool, backend-write interface;
 * it never falls back to the LIVE skill: a missing candidate skill stops the build.
 *
 * The scaffold manifest is validated exactly as OpenAI's own `validate_plugin.py` validates it (allowed keys,
 * strict semver, required author.name, required interface fields, ≤3 default prompts of ≤128 chars, #RRGGBB).
 *
 * VERSION. Strict semver, strictly greater than the installed one at every upload: <base>.<commit count>, base 1.0.
 *
 * SECRET. When the URL still carries a token in its path, the archive IS that seller's credential: it is written
 * under `.run/plugin/` (gitignored) and must never be committed, pasted or shared, and one is built per person.
 * With a tokenless URL (the endpoint's own /mcp), one archive serves the whole team and each application holds
 * its own token in its authentication field (PV-CRED-001).
 *
 * Usage, from the repository root:  node packages/plugin/scripts/build-archive.mjs [url-file] [--candidate]
 *
 * Behaviour ships through the backend (`next.conduct`, tools/conduct.ts). This archive changes only when the
 * manifest, the skill or the endpoint change — so a new upload is the exception, not the release.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
/**
 * Updating an existing plugin matches it by identity: OpenAI's API states « The request's name and description
 * must match the manifest », and ChatGPT answered « Plugin not found » to an archive whose name was not the one
 * the account already holds. So the identifier is an input, not a constant: pass the plugin's own name (and its
 * id when the page shows one) and the archive describes THAT plugin.
 *   node packages/plugin/scripts/build-archive.mjs [url-file] [--name <plugin-name>] [--id <plugin-id>] [--base-version 1.0]
 *   --candidate --apps-file <verified-app-file> --registered-app-only: existing native app, no bundled MCP or URL input.
 */
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3); };
const VALUE_FLAGS = ["--name", "--id", "--base-version", "--apps-file"];
const urlFile = resolve(root, args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1])) ?? ".run/connector-url-vps.local");
const pluginDir = join(root, "packages/plugin");
// A test build writes elsewhere and is exempt from the clean-tree rule: its version names nothing.
const testOut = process.env["VERTIGO_ARCHIVE_OUT"];
const PREPARATION = args.includes("--preparation-only");
if (PREPARATION && !args.includes("--candidate")) { console.error("--preparation-only requires --candidate; it is never a LIVE release"); process.exit(1); }
const NAME = flag("name") ?? "vertigo-os";
// --with-notion used to declare Notion's own MCP server as a second server of this plugin (2026-09-23). Withdrawn by
// W3.5: the archive declares one server, and a silently ignored flag would ship a plugin its builder did not ask for.
if (args.some((a) => a === "--with-notion" || a.startsWith("--with-notion="))) { console.error("--with-notion is withdrawn: the archive declares exactly one MCP server (VERTIGO's); Notion writes go through the backend"); process.exit(1); }
const CANDIDATE = args.includes("--candidate");
const REGISTERED_APP_ONLY = args.includes("--registered-app-only");
if (args.some((arg) => arg.startsWith("--registered-app-only="))) { console.error("--registered-app-only is a boolean flag; it takes no value"); process.exit(1); }
// An account update must retain a verified existing app binding, not invent a new one.
// Native preparation is also local-only: a referenced app is not proof of sharing or member access.
const appsFile = flag("apps-file");
const hasAppsFlag = args.some((arg) => arg === "--apps-file" || arg.startsWith("--apps-file="));
if (hasAppsFlag && (!appsFile || appsFile.startsWith("--"))) { console.error("--apps-file requires an existing verified app file"); process.exit(1); }
if (appsFile && (!CANDIDATE || (PREPARATION && !REGISTERED_APP_ONLY))) { console.error("--apps-file is only for a final private candidate update or native local preparation; never LIVE or shared MCP preparation"); process.exit(1); }
if (REGISTERED_APP_ONLY && (!CANDIDATE || !appsFile)) { console.error("--registered-app-only requires --candidate and verified --apps-file; never LIVE"); process.exit(1); }
let appsText;
if (appsFile) {
  try {
    appsText = readFileSync(resolve(root, appsFile), "utf8");
    const value = JSON.parse(appsText);
    const entries = value?.apps && typeof value.apps === "object" && !Array.isArray(value.apps) ? Object.values(value.apps) : [];
    if (Object.keys(value).some((key) => key !== "apps") || !entries.length || entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some((key) => key !== "id") || typeof entry.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(entry.id))) throw new Error("invalid app bindings");
    if (Object.keys(value.apps).some((key) => !/^[A-Za-z0-9_-]+$/.test(key)) || appsText.replace(/\s+/g, "") !== JSON.stringify(value)) throw new Error("hidden or duplicate app content");
    if (REGISTERED_APP_ONLY && (entries.length !== 1 || !/^(?:asdk_app_|connector_|templated_apps_)[A-Za-z0-9_-]+$/.test(entries[0].id))) throw new Error("one registered app required");
  } catch { console.error("--apps-file must contain only verified existing app IDs; no credential or endpoint is accepted"); process.exit(1); }
}
const skillFile = join(pluginDir, CANDIDATE ? "SKILL.candidate.md" : "SKILL.md");
// No fallback: a candidate archive carrying the LIVE skill would drive the candidate server with the LIVE choreography.
if (!existsSync(skillFile)) { console.error(`skill not found: ${skillFile}${CANDIDATE ? " (--candidate never falls back to SKILL.md)" : ""}`); process.exit(1); }
const ID = flag("id");
if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(NAME)) { console.error(`--name must be a plugin identifier (letters, digits, - _ .): ${NAME}`); process.exit(1); }
if (CANDIDATE && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(NAME) || NAME.length > 64)) { console.error("candidate --name must be lowercase kebab-case, at most 64 characters"); process.exit(1); }
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

let url;
let carriesToken = false;
if (!REGISTERED_APP_ONLY) {
  if (!existsSync(urlFile)) { console.error(`connector URL file not found: ${urlFile}`); process.exit(1); }
  url = readFileSync(urlFile, "utf8").trim();
  if (!/^https:\/\/[^\s/]+\/mcp(?:\/[^\s]+)?$/.test(url)) { console.error("the connector URL file does not hold an https://<host>/mcp URL"); process.exit(1); }
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { console.error("invalid connector URL"); process.exit(1); }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || /[?#]/.test(url)) { console.error("connector URL must not contain userinfo, query or fragment"); process.exit(1); }
  // A URL whose path carries the token IS the credential, so that archive belongs to one seller and cannot be
  // shared (PV-CRED-001). A tokenless URL makes one archive serve the whole team, each application holding its
  // own token in its authentication field.
  carriesToken = /\/mcp\/.+$/.test(url);
  if (PREPARATION && url !== `${parsedUrl.origin}/mcp`) { console.error("preparation requires a bare /mcp endpoint: no credential may enter the shared candidate archive"); process.exit(1); }
}
const pluginTreeDirty = git("status", "--porcelain", "--", "packages/plugin").length > 0;
if (!testOut && !PREPARATION && pluginTreeDirty) { console.error("packages/plugin has uncommitted changes: commit first, the archive's version names a revision"); process.exit(1); }
// Preparation may inspect a working delta, never label it a release or overwrite a rollback archive.
if (PREPARATION && !testOut) mkdirSync(join(root, ".run"), { recursive: true, mode: 0o700 });
const outRoot = testOut ? resolve(testOut) : PREPARATION ? mkdtempSync(join(root, ".run/plugin-preparation-")) : join(root, ".run/plugin");
const stage = join(outRoot, NAME);
const archive = join(outRoot, `${NAME}.zip`);

const repoManifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));
const skill = readFileSync(skillFile, "utf8");
const rev = git("rev-parse", "--short", "HEAD");
// The plugin ChatGPT already holds is at 1.0.0, and a new version must be strictly greater than the installed
// one — 0.3.x was below it. The plugin's version line is therefore its own (default 1.0), independent of the
// repository manifest's PLUGIN_SPEC line, and the patch is the commit count so every upload is strictly newer.
const base = flag("base-version") ?? "1.0";
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(base)) { console.error(`--base-version must be <major>.<minor>: ${base}`); process.exit(1); }
const version = `${base}.${git("rev-list", "--count", "HEAD")}${PREPARATION ? `-preparation.rev-${rev}` : ""}`;
void repoManifest;

const DISPLAY = "VERTIGO OS harness";
const SHORT = CANDIDATE ? "Votre espace VERTIGO" : "Opérez votre espace VERTIGO depuis un chat ordinaire.";
const LONG = CANDIDATE
  ? "Cinq outils : os_bind, os_resume, os_commit, os_handoff, os_control_status. os_commit écrit le changement dans Notion côté serveur, le relit et le prouve ; l'application Notion native n'écrit aucun enregistrement VERTIGO. Rien n'est déclaré enregistré avant cette preuve."
  : "Six outils en lecture seule sur Notion : os_bind, os_resume, os_prepare, os_verify, os_handoff, os_control_status. Les écritures Notion sont exécutées par l'application Notion native, exactement comme le plan les rend, puis vérifiées en deux temps. Rien n'est déclaré enregistré avant cette vérification.";
const DESCRIPTION = "Opère VERTIGO META OS ou un Personal SALES OS depuis un chat ordinaire. Notion reste la vérité durable ; chaque changement est vérifié.";
const PROMPTS = ["On reprend où on en est.", "Voici ma réponse à la question en cours.", "Passe-moi le relais pour cette conversation."];

const interfaceBlock = {
  displayName: DISPLAY,
  shortDescription: SHORT,
  longDescription: LONG,
  developerName: "Studio Vertigo",
  category: "Productivity",
  capabilities: CANDIDATE ? ["Read", "Write"] : ["Read"],
  websiteURL: "https://studiovertigo.io",
  defaultPrompt: PROMPTS,
  brandColor: "#1F2937",
};
// Scaffold manifest: the validator rejects any key outside this set, and `$schema` is NOT one of them.
const scaffoldManifest = {
  ...(ID ? { id: ID } : {}),
  name: NAME,
  version,
  description: DESCRIPTION,
  author: { name: "Studio Vertigo", url: "https://studiovertigo.io" },
  ...(appsText ? { apps: "./.app.json", keywords: ["vertigo", "notion", "sales"] } : {}),
  skills: "./skills/",
  ...(!REGISTERED_APP_ONLY ? { mcpServers: "./.mcp.json" } : {}),
  interface: interfaceBlock,
};
const portableManifest = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: NAME,
  version,
  description: DESCRIPTION,
  author: { name: "Studio Vertigo", url: "https://studiovertigo.io" },
  keywords: ["vertigo", "notion", "sales"],
  extensions: { "com.openai": { ...(appsText ? { apps: "./.app.json" } : {}), interface: interfaceBlock } },
};
// The skill's description is its trigger: a plugin skill is loaded when the model judges it relevant, so it must
// name every way a seller opens the subject, and say what the first action is.
const SKILL_DESCRIPTION = "Use for ANY message about the user's VERTIGO space, Sales OS, META OS, prospection, pilotage, a step (B0…B7, gate, curseur), « on reprend », a decision to record, or anything to enregistrer/vérifier in Notion. The first action of every such conversation is os_bind, then os_resume: nothing about the space is known before they return, and chat memory is never state. Every reply carries `say` (what the user hears) and `next.conduct` (what to do with that reply).";
const skillMd = `---\nname: ${NAME}\ndescription: ${JSON.stringify(SKILL_DESCRIPTION)}\n---\n\n${skill}`;

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, ".codex-plugin"), { recursive: true });
mkdirSync(join(stage, "skills", NAME), { recursive: true });
const write = (rel, data) => writeFileSync(join(stage, rel), typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
write(".codex-plugin/plugin.json", scaffoldManifest);
if (!REGISTERED_APP_ONLY) write(".mcp.json", { mcpServers: { [NAME]: { url } } });
write("plugin.json", portableManifest);
if (appsText) write(".app.json", appsText);
if (!REGISTERED_APP_ONLY) write("mcp.json", { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { [NAME]: { type: "streamable-http", url } } });
write(`skills/${NAME}/SKILL.md`, skillMd);

rmSync(archive, { force: true });
execFileSync("zip", ["-q", "-r", "-X", archive, NAME], { cwd: outRoot });
if (PREPARATION) {
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const files = REGISTERED_APP_ONLY
    ? [".codex-plugin/plugin.json", "plugin.json", ".app.json", `skills/${NAME}/SKILL.md`]
    : [".codex-plugin/plugin.json", ".mcp.json", "plugin.json", "mcp.json", `skills/${NAME}/SKILL.md`];
  const receipt = {
    kind: "asdk_app_EXAMPLE/1", status: "NOT_RELEASE", upload_allowed: false,
    backend_served_proved: false, plugin_name: NAME, version, base_revision: git("rev-parse", "HEAD"),
    connection_mode: REGISTERED_APP_ONLY ? "REGISTERED_APP_ONLY" : "EMBEDDED_MCP", member_access_proved: false,
    plugin_tree_dirty: pluginTreeDirty, archive_sha256: hash(readFileSync(archive)),
    source_hashes: { "scripts/build-archive.mjs": hash(readFileSync(fileURLToPath(import.meta.url))), "SKILL.candidate.md": hash(skill), ...(appsText ? { ".app.json": hash(appsText) } : {}) },
    payload_hashes: Object.fromEntries(files.map((f) => [f, hash(readFileSync(join(stage, f)))])),
    final_rebuild_required: "After explicitly approved W3.3L cutover; this archive is local preparation only.",
  };
  writeFileSync(join(outRoot, "PREPARATION.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  console.log("PREPARATION ONLY: NOT RELEASE; do not upload, install or distribute. Rebuild after approved cutover.");
}

console.log(`archive: ${archive}`);
console.log(`plugin  ${NAME} version ${version} (revision ${rev})`);
console.log(`skill   ${CANDIDATE ? "CANDIDATE (SKILL.candidate.md, five tools, backend writes)" : "LIVE (SKILL.md, six tools)"}`);
if (appsText) console.log("Existing app bindings preserved byte-for-byte; this does not prove sharing, host installation or authentication.");
console.log(execFileSync("unzip", ["-l", archive], { encoding: "utf8" }).split("\n").filter((l) => /vertigo-os\/\S/.test(l)).map((l) => "  " + l.trim()).join("\n"));
if (REGISTERED_APP_ONLY) {
  console.log("PRIVATE registered-app-only update: no MCP declaration, server URL or credential is embedded. Authentication remains with the existing app; host compatibility is not yet proved.");
} else {
  console.log(`mcp endpoint: ${new URL(url).origin}/mcp${carriesToken ? " + a token in the path" : ""}`);
  console.log(carriesToken
    ? "WARNING: this archive embeds a credential in its URL. It belongs to ONE seller: never share it, and build a\n         separate archive per person. Move the token to the application's authentication field to share one archive."
    : "This archive carries no credential: the same file serves everyone, and each application holds its own token.");
}
