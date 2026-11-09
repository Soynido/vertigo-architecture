/**
 * PT-IMG-001 — secrets never enter the image or a log line (PV-WRITE-001 / W1.2).
 *
 * a: the Dockerfile copies only the workspace manifests and the two packages, and declares no secret.
 * b: the Docker build context (repository root minus .dockerignore) holds no secret: no config/, no .run/, no
 *    *.local* file, no env file other than a template. Every secret-looking file present on disk is excluded.
 * c: the real server, started over HTTP, logs its start line, access lines and `tool=` lines without ever
 *    printing a credential — neither the bearer token, nor the path token, nor the Notion token.
 * Only file NAMES are read under the repository; no secret file is opened.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../../src/server/http.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const HARNESS = fileURLToPath(new URL("../../", import.meta.url));

/** .dockerignore semantics: patterns relative to the context root, `**` spans directories, a match on a directory excludes its contents, `!` re-includes, the last matching rule wins. */
function dockerIgnore(text: string): (path: string) => boolean {
  const rules = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
    const negate = l.startsWith("!");
    const body = (negate ? l.slice(1) : l).replace(/^\/+|\/+$/g, "");
    let re = "";
    for (let i = 0; i < body.length; i += 1) {
      const c = body[i]!;
      if (body.startsWith("**/", i)) { re += "(?:.*/)?"; i += 2; }
      else if (body.startsWith("**", i)) { re += ".*"; i += 1; }
      else if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return { negate, re: new RegExp(`^${re}$`) };
  });
  return (path) => {
    const parts = path.split("/");
    const candidates = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    let excluded = false;
    for (const r of rules) if (candidates.some((c) => r.re.test(c))) excluded = !r.negate;
    return excluded;
  };
}

const SECRET_NAME = (path: string): boolean => {
  const base = path.split("/").at(-1)!;
  return /^config\//.test(path) || /^\.run\//.test(path) || /\.local(\.|$)/.test(base) || (/^\.env(\..+)?$/.test(base) && base !== ".env.example");
};

async function walk(dir: string, keep: (rel: string, isDir: boolean) => boolean, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = relative(REPO, join(dir, e.name));
    if (!keep(rel, e.isDirectory())) continue;
    if (e.isDirectory()) await walk(join(dir, e.name), keep, out);
    else out.push(rel);
  }
  return out;
}

test("PT-IMG-001/a: the Dockerfile copies only manifests and the two packages, and declares no secret", async () => {
  const docker = await readFile(join(REPO, "deploy/Dockerfile"), "utf8");
  const lines = docker.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.ok(!lines.some((l) => /^ADD\s/i.test(l)), "no ADD: it can fetch or unpack anything");
  const sources = lines.filter((l) => /^COPY\s/i.test(l)).flatMap((l) => l.split(/\s+/).slice(1, -1)).filter((s) => !s.startsWith("--"));
  const allowed = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "packages/harness/package.json", "packages/harness/", "packages/plugin/"]);
  assert.deepEqual(sources.filter((s) => !allowed.has(s)), [], "COPY sources outside the allowlist");
  for (const l of lines.filter((x) => /^(ENV|ARG)\s/i.test(x))) assert.doesNotMatch(l, /NOTION|TOKEN|PASSWORD|SECRET|DATABASE_URL/i, l);
  assert.ok(!lines.some((l) => /--env-file/.test(l)), "no env file is read at build or run time");
});

test("PT-IMG-001/b: the build context excludes every secret, and nothing secret-looking remains in it", async () => {
  const ignored = dockerIgnore(await readFile(join(REPO, ".dockerignore"), "utf8"));
  // What is on disk that looks secret (names only), wherever it is — including trees the context excludes.
  const secretsOnDisk = await walk(REPO, (rel, isDir) => !(isDir && /(^|\/)(node_modules|\.git)$/.test(rel)));
  const secretLooking = secretsOnDisk.filter(SECRET_NAME);
  for (const s of secretLooking) assert.ok(ignored(s), `secret-looking file enters the Docker context: ${s}`);
  // The context itself: every path .dockerignore keeps.
  const context = await walk(REPO, (rel) => !ignored(rel));
  assert.deepEqual(context.filter(SECRET_NAME), []);
  // Structural rules hold even on a machine that has no secret file today.
  for (const p of ["config/http-tokens.local.json", "config/principals.local.json", "config/http-token.p-x.local", ".run/harness.log", ".env", "deploy/.env", "packages/harness/.env", "packages/harness/x.local.json", "packages/plugin/.env.production"]) {
    assert.ok(ignored(p), `must be excluded: ${p}`);
  }
  for (const p of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "packages/harness/src/index.ts", "packages/plugin/SKILL.md", "deploy/.env.example"]) {
    assert.ok(!ignored(p), `must stay in the context: ${p}`);
  }
});

test("PT-IMG-001/c: the served process logs no credential — start line, access lines and tool= lines scanned", async (t) => {
  const BEARER = `img001-bearer-${"b".repeat(24)}`;
  const PATH_TOKEN = `img001-path-${"p".repeat(24)}`;
  const NOTION = `img001-notion-${"n".repeat(24)}`;
  const dir = await mkdtemp(join(tmpdir(), "pt-img-001-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "tokens.json"), JSON.stringify({ tokens: [{ token_sha256: sha256(BEARER), principal_id: "p-img" }, { token_sha256: sha256(PATH_TOKEN), principal_id: "p-img" }] }));
  await writeFile(join(dir, "principals.json"), JSON.stringify({ principals: [{ principal_id: "p-img", status: "ACTIVE", allowed_projects: ["VERTIGO"], allowed_lanes: ["META", "SALES"] }] }));
  const port = 41_000 + Math.floor(Math.random() * 9_000);
  const child = spawn(process.execPath, ["src/index.ts"], {
    cwd: HARNESS,
    env: {
      PATH: process.env["PATH"] ?? "",
      HARNESS_ENV: "fixture",
      HARNESS_TRANSPORT: "http",
      HARNESS_HTTP_HOST: "127.0.0.1",
      HARNESS_HTTP_PORT: String(port),
      HARNESS_HTTP_TOKENS_FILE: join(dir, "tokens.json"),
      PRINCIPALS_FILE: join(dir, "principals.json"),
      VERTIGO_META_SPEC_ROOT: "https://example.invalid/root",
      NOTION_READ_TOKEN: NOTION,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { child.kill(); });
  let log = "";
  child.stdout.on("data", (d: Buffer) => { log += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { log += d.toString(); });
  const until = async (pred: () => boolean, what: string) => {
    for (let i = 0; i < 200 && !pred(); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.ok(pred(), `${what} — log so far:\n${log.replaceAll(BEARER, "<B>").replaceAll(PATH_TOKEN, "<P>").replaceAll(NOTION, "<N>")}`);
  };
  await until(() => log.includes("listening on"), "server start line");

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pt-img-001", version: "0" } } };
  const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "os_bind", arguments: { project: "VERTIGO", lane: "META" } } };
  assert.equal((await post("/mcp", init, { authorization: `Bearer ${BEARER}` })).status, 200);
  const r = await post(`/mcp/${PATH_TOKEN}`, call);
  assert.equal(r.status, 200);
  assert.doesNotMatch(await r.text(), new RegExp(`${BEARER}|${PATH_TOKEN}|${NOTION}`), "a response body carries a credential");
  assert.equal((await post(`/mcp/${PATH_TOKEN}x?token=${BEARER}`, call)).status, 401);
  await until(() => log.includes("tool=os_bind") && (log.match(/event=HTTP_END /g) ?? []).length >= 3, "tool= and access lines");

  for (const secret of [BEARER, PATH_TOKEN, NOTION]) assert.ok(!log.includes(secret), "a log line carries a credential");
  assert.match(log, /tool=os_bind status=\w+ code=\w+/);
  assert.match(log, /event=HTTP_END .*method=POST delivery=FINISHED http_status=200/);
  assert.match(log, /event=HTTP_AUTH .*auth=DENIED/);
  assert.match(log, /event=HTTP_END .*http_status=401/);
});
