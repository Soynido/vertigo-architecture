/**
 * W3.6 local candidate fixture (test/support/local-candidate.ts): refusals before any connection, a private reused
 * token, then — against the designated local database only — one standalone process answering the MCP initialize,
 * the exact five tools, a bare os_bind, os_resume and the B0 answer through os_commit (PERSISTED, journaled), and a
 * restart that resumes the moved cursor and replays the answer without a second mutation.
 *
 * Synthetic Sales 0.5.11 test world: no production adoption, no 0.5.12 proof, no live Notion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { propText, type Page } from "../../src/notion/shapes.ts";
import { PostgresBackend } from "../../src/store/postgres.ts";
import { SALES_CONTROL_PLANE_0511_CANDIDATE } from "../../src/versions/adapters/controlPlane.ts";
import { ensureLocalToken, LocalCandidateRefusal, SNAPSHOT_FILE, TOKEN_FILE, validateLocalCandidate, W36_DATABASE } from "../support/local-candidate.ts";
import { B0_KEY, G, OUTCOME } from "../support/guard-fixtures.ts";

const url = process.env["HARNESS_TEST_DATABASE_URL"];
const designated = url !== undefined && /^postgres(ql)?:\/\/[^/]*@?(127\.0\.0\.1|localhost)(:\d+)?\/vertigo_w36_local$/.test(url);
const LOCAL = `postgresql://fixture@127.0.0.1:5432/${W36_DATABASE}`;
const SCRIPT = fileURLToPath(new URL("../support/local-candidate.ts", import.meta.url));
const HARNESS = fileURLToPath(new URL("../../", import.meta.url));
const b0Gate = () => SALES_CONTROL_PLANE_0511_CANDIDATE.cursorTransitions?.find((t) => t.fromGate === "B0_DISCOVERY")?.set["Current Gate"];

const privateTemp = (label: string) => { const d = mkdtempSync(join(tmpdir(), `w36-${label}-`)); chmodSync(d, 0o700); return d; };
/** The child never inherits a Notion credential or a live environment from the test runner. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ["NOTION_TOKEN", "NOTION_READ_TOKEN", "HARNESS_ENV", "DATABASE_URL", "W36_DATABASE_URL"]) delete env[k];
  return env;
}

interface Run { readonly code: Promise<number | null>; readonly stdout: () => string; readonly stderr: () => string; ready(): Promise<number>; stop(): Promise<number | null> }
/** Every launched child until it exits, so a failed assertion never leaves a listener or a pool behind. */
const live = new Map<ChildProcess, Promise<number | null>>();
async function reap(): Promise<void> {
  for (const [child, code] of live) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await code;
    clearTimeout(timer);
  }
}
function launch(args: readonly string[], options: { readonly executable?: string; readonly cwd?: string } = {}): Run {
  const child = spawn(options.executable ?? process.execPath, [SCRIPT, ...args], { cwd: options.cwd ?? HARNESS, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
  child.stderr.on("data", (b: Buffer) => { err += b.toString(); });
  const code = new Promise<number | null>((done, fail) => {
    child.once("error", (error) => { live.delete(child); fail(error); });
    child.once("exit", (c) => { live.delete(child); done(c); });
  });
  live.set(child, code);
  return {
    code, stdout: () => out, stderr: () => err,
    ready: () => new Promise<number>((done, fail) => {
      const tick = setInterval(() => { const m = /ready port=(\d+)/.exec(out); if (m) { clearInterval(tick); done(Number(m[1])); } }, 25);
      void code.then((c) => { clearInterval(tick); fail(new Error(`exited ${c} before ready: ${err}`)); }, (error) => { clearInterval(tick); fail(error); });
    }),
    stop: () => { child.kill("SIGTERM"); return code; },
  };
}

/* ───────────────────────────── refusals ───────────────────────────── */

test("W3.6R: filesystem defaults preserve URL-encoded spaces and launcher errors/early exits reject promptly", { timeout: 5000 }, async () => {
  const config = validateLocalCandidate({ databaseUrl: LOCAL }, {});
  assert.equal(config.stateDir, fileURLToPath(new URL("../../.run/w36-local/state/", import.meta.url)).replace(/\/$/, ""));
  assert.equal(config.tokenDir, fileURLToPath(new URL("../../.run/w36-local/token/", import.meta.url)).replace(/\/$/, ""));
  const missing = join(tmpdir(), `w36-missing-${randomBytes(6).toString("hex")}`);
  await assert.rejects(launch([], { executable: missing }).ready(), /ENOENT/);
  await assert.rejects(launch([], { cwd: missing }).ready(), /ENOENT/);
  const refused = launch(["--database-url", `postgresql://u@203.0.113.1:5432/${W36_DATABASE}`]);
  await assert.rejects(refused.ready(), /exited 2 before ready/);
  assert.equal(await refused.code, 2, "refusal happens before a database connection");
});

test("W3.6 local: remote, redirected, live or mismatched settings are refused before any connection", async (t) => {
  t.after(reap);
  const refuses = (o: Parameters<typeof validateLocalCandidate>[0], env: NodeJS.ProcessEnv, why: RegExp) =>
    assert.throws(() => validateLocalCandidate(o, env), (e: unknown) => e instanceof LocalCandidateRefusal && why.test(e.message) && !e.message.includes("postgres"));
  refuses({ databaseUrl: `postgresql://u@db.example.com:5432/${W36_DATABASE}` }, {}, /host is not loopback/);
  refuses({ databaseUrl: `postgresql://u@127.0.0.1:5432/${W36_DATABASE}?host=10.0.0.1` }, {}, /no query parameters/);
  refuses({ databaseUrl: `postgresql://u@127.0.0.1:5432/${W36_DATABASE}?options=-c%20search_path%3Dpublic` }, {}, /no query parameters/);
  refuses({ databaseUrl: "postgresql://u@127.0.0.1:5432/postgres" }, {}, /database is not vertigo_w36_local/);
  refuses({ databaseUrl: `mysql://u@127.0.0.1:3306/${W36_DATABASE}` }, {}, /not a PostgreSQL URL/);
  refuses({ databaseUrl: undefined }, {}, /database URL is required/);
  refuses({ databaseUrl: LOCAL }, { NOTION_TOKEN: "secret_x" }, /NOTION_TOKEN/);
  refuses({ databaseUrl: LOCAL }, { NOTION_READ_TOKEN: "secret_x" }, /NOTION_READ_TOKEN/);
  refuses({ databaseUrl: LOCAL }, { HARNESS_ENV: "live" }, /live environment/);
  refuses({ databaseUrl: LOCAL, host: "0.0.0.0" }, {}, /listener host is not loopback/);
  refuses({ databaseUrl: LOCAL, schema: "public" }, {}, /isolated w36 schema/);

  const ok = validateLocalCandidate({ databaseUrl: LOCAL }, {});
  assert.deepEqual([ok.host, ok.schema, ok.allowPathToken], ["127.0.0.1", "w36_candidate", false]);
  assert.ok(ok.scopedDatabaseUrl.endsWith(`/${W36_DATABASE}?options=${encodeURIComponent("-c search_path=w36_candidate")}`));
  assert.ok(ok.stateDir.includes("/.run/w36-local/") && ok.tokenDir.includes("/.run/w36-local/"), "default state lives in the ignored .run");

  // The standalone process exits on the refusal: a TEST-NET address would hang on connect, so no socket was opened.
  const [s, tk] = [privateTemp("s"), privateTemp("t")];
  const remote = launch(["--database-url", `postgresql://u@203.0.113.1:5432/${W36_DATABASE}`, "--state-dir", s, "--token-dir", tk]);
  assert.equal(await remote.code, 2);
  for (const d of [s, tk]) rmSync(d, { recursive: true, force: true });
  assert.match(remote.stderr(), /refused: the database host is not loopback/);
  assert.equal(remote.stdout(), "");
});

test("W3.6 local: the token is generated once, private, reused, and refused when its permissions widen", (t) => {
  const dir = join(privateTemp("tok"), "token");
  const open = join(privateTemp("open"), "token");
  t.after(() => { for (const d of [dir, open]) rmSync(join(d, ".."), { recursive: true, force: true }); });
  const first = ensureLocalToken(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(first.file).mode & 0o777, 0o600);
  assert.equal(ensureLocalToken(dir).sha256, first.sha256, "reused, not regenerated");
  chmodSync(first.file, 0o644);
  assert.throws(() => ensureLocalToken(dir), /readable by group or others/);
  mkdirSync(open, { mode: 0o755 });
  chmodSync(open, 0o755);
  assert.throws(() => ensureLocalToken(open), /readable by group or others/);
});

/* ───────────────────────────── served, restarted ───────────────────────────── */

const text = (r: Record<string, unknown>) => JSON.parse((r["content"] as Array<{ text: string }>)[0]?.text ?? "{}") as Record<string, unknown>;
async function connect(port: number, token: string): Promise<Client> {
  const c = new Client({ name: "w36-local-test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as unknown as Parameters<typeof c.connect>[0]);
  return c;
}
const gateOf = (e: Record<string, unknown>) => (e["result"] as { gate?: { gate_key?: string } } | undefined)?.gate?.gate_key;
const b0Rows = (stateDir: string) => {
  const s = JSON.parse(readFileSync(join(stateDir, SNAPSHOT_FILE), "utf8")) as { applied_writes: number; world: Record<string, { results?: Page[] }> };
  return { applied: s.applied_writes, rows: (s.world[`query:${G.configDs}`]?.results ?? []).filter((p) => propText(p, "Config Item") === B0_KEY) };
};

test("W3.6 local [postgres]: initialize, five tools, bare bind, resume, B0 PERSISTED; restart resumes and replays without a second mutation", { skip: !designated && "HARNESS_TEST_DATABASE_URL is not the local vertigo_w36_local database", timeout: 120_000 }, async (t) => {
  const schema = `w36_test_${randomBytes(6).toString("hex")}`;
  const stateDir = privateTemp("state");
  const emptyDir = privateTemp("empty");
  const tokenDir = join(privateTemp("token"), "t");
  const args = ["--database-url", url as string, "--schema", schema, "--state-dir", stateDir, "--token-dir", tokenDir, "--port", "0"];
  const scoped = validateLocalCandidate({ databaseUrl: url, schema }, {}).scopedDatabaseUrl;
  const pg = new PostgresBackend(scoped);
  const logs: string[] = [];
  t.after(async () => {
    // Children first: no process may hold the schema or the state while it is removed.
    await reap();
    // Only the schema this test created, by its exact generated name.
    if (/^w36_test_[0-9a-f]{12}$/.test(schema)) await pg.pool.query(`drop schema if exists ${schema} cascade`).catch(() => undefined);
    await pg.close();
    for (const d of [stateDir, emptyDir]) rmSync(d, { recursive: true, force: true });
    rmSync(join(tokenDir, ".."), { recursive: true, force: true });
  });

  /* first life */
  const one = launch(args);
  const port1 = await one.ready();
  assert.match(one.stdout().trim(), /^w36-local-candidate ready port=\d+ version=\S+ persistence=\S+$/, "the ready line carries only port, version and persistence");
  const token = readFileSync(join(tokenDir, TOKEN_FILE), "utf8").trim();
  assert.ok(!one.stdout().includes(token));
  const c1 = await connect(port1, token);
  let planId = "";
  let derivedPlanId = "";
  let servedIntent: Record<string, unknown> = {};
  const handles: string[] = [];
  try {
    assert.equal(c1.getServerVersion()?.name, "vertigo-os-harness");
    assert.ok(one.stdout().includes(`version=${c1.getServerVersion()?.version}`), "initialize announces the version the ready line printed");
    assert.deepEqual((await c1.listTools()).tools.map((x) => x.name), ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"]);
    const bound = text(await c1.callTool({ name: "os_bind", arguments: {} }));
    assert.equal(bound["code"], "BOUND", JSON.stringify(bound));
    const h = (bound["result"] as { binding_handle: string }).binding_handle;
    handles.push(h);
    const resumed = text(await c1.callTool({ name: "os_resume", arguments: { binding_handle: h } }));
    assert.equal(gateOf(resumed), "B0_DISCOVERY", JSON.stringify(resumed));
    const next = resumed["next"] as { prepare_intent?: Record<string, unknown>; conduct?: string };
    assert.ok(next.prepare_intent, "the answer must use the intent actually served by os_resume");
    assert.ok(next.conduct?.includes("os_commit"), "candidate conduct names the transactional writer");
    assert.ok(!next.conduct?.includes("os_prepare"), "no legacy writer choreography");
    servedIntent = JSON.parse(JSON.stringify(next.prepare_intent).replaceAll("$answer", OUTCOME)) as Record<string, unknown>;
    assert.equal((servedIntent["mutations"] as Array<{ operation: string }>)[0]?.operation, "UPSERT");
    const out = text(await c1.callTool({ name: "os_commit", arguments: { binding_handle: h, intent: servedIntent } }));
    assert.deepEqual([out["kind"], out["repeated"], out["step_moved"], out["next_gate"], out["derived_move"]], ["PERSISTED", false, true, b0Gate(), "PERSISTED"], JSON.stringify(out));
    planId = out["plan_id"] as string;
    derivedPlanId = out["derived_plan_id"] as string;
    assert.ok(typeof derivedPlanId === "string" && derivedPlanId !== "" && derivedPlanId !== planId, "the cursor transition is its own plan");
    // The compound outcome counts the answer plan and the derived cursor plan: each fully DONE and FINAL, together writes_sent.
    let journaled = 0;
    for (const id of [planId, derivedPlanId]) {
      const journal = (await pg.pool.query("select status, count(*)::int as n from plan_writes where plan_id = $1 group by status", [id])).rows as Array<{ status: string; n: number }>;
      assert.deepEqual(journal.map((r) => r.status), ["DONE"], "every journaled write is DONE");
      assert.ok((journal[0]?.n ?? 0) > 0, "each plan of the chain journaled its writes");
      journaled += journal[0]?.n ?? 0;
      const events = (await pg.pool.query("select event_type from transaction_events where plan_id = $1", [id])).rows.map((r) => r.event_type as string);
      for (const e of ["PLAN_FINAL_VERIFIED", "FINAL_RECEIPT_ISSUED", "LEASE_RELEASED"]) assert.ok(events.includes(e), e);
    }
    assert.equal(journaled, out["writes_sent"], "writes_sent covers the full chain");
    assert.equal((await pg.pool.query("select count(*)::int as n from plan_writes where plan_id <> all($1)", [[planId, derivedPlanId]])).rows[0]?.n, 0, "no write outside the chain");
    assert.equal((await pg.pool.query("select count(*)::int as n from guard_approvals")).rows[0]?.n, 1, "the synthetic approval lives in PostgreSQL");
  } finally { await c1.close(); }
  assert.equal(statSync(join(stateDir, SNAPSHOT_FILE)).mode & 0o777, 0o600);
  const before = b0Rows(stateDir);
  assert.equal(before.rows.length, 1, "one answer row in the business fixture");
  assert.equal(before.applied, (await pg.pool.query("select count(*)::int as n from plan_writes where status = 'DONE'")).rows[0]?.n);
  assert.equal(await one.stop(), 0, "clean shutdown");
  logs.push(one.stderr());

  /* second life: same token, same schema, restored world */
  const two = launch(args);
  const port2 = await two.ready();
  assert.equal(readFileSync(join(tokenDir, TOKEN_FILE), "utf8").trim(), token, "the token is reused");
  const writesBefore = (await pg.pool.query("select count(*)::int as n from plan_writes")).rows[0]?.n as number;
  const c2 = await connect(port2, token);
  try {
    const bound = text(await c2.callTool({ name: "os_bind", arguments: {} }));
    const h = (bound["result"] as { binding_handle: string }).binding_handle;
    handles.push(h);
    const resumed = text(await c2.callTool({ name: "os_resume", arguments: { binding_handle: h } }));
    assert.equal(gateOf(resumed), b0Gate(), `the moved cursor survived the restart: ${JSON.stringify(resumed)}`);
    const replay = text(await c2.callTool({ name: "os_commit", arguments: { binding_handle: h, intent: servedIntent } }));
    assert.deepEqual([replay["kind"], replay["repeated"], replay["writes_sent"], replay["plan_id"]], ["PERSISTED", true, 0, planId], JSON.stringify(replay));
  } finally { await c2.close(); }
  assert.equal((await pg.pool.query("select count(*)::int as n from plan_writes")).rows[0]?.n, writesBefore, "no new journaled write");
  assert.deepEqual([b0Rows(stateDir).rows.length, b0Rows(stateDir).applied], [1, before.applied], "no second mutation of the business fixture");
  assert.equal(await two.stop(), 0);
  logs.push(two.stderr());

  /* a store without its world is refused, never reset */
  const orphan = launch([...args.slice(0, 4), "--state-dir", emptyDir, "--token-dir", tokenDir, "--port", "0"]);
  assert.equal(await orphan.code, 2);
  assert.match(orphan.stderr(), /refused: the transaction store journals sent writes but no world snapshot exists/);
  assert.equal((await pg.pool.query("select count(*)::int as n from plan_writes")).rows[0]?.n, writesBefore, "nothing was reset");
  logs.push(orphan.stderr());

  // Traces carry enums and counts: no token, business value, handle or id.
  const all = logs.join("\n");
  for (const secret of [token, OUTCOME, planId, derivedPlanId, ...handles]) assert.ok(!all.includes(secret), "a trace leaked a value");
  assert.ok(!/[0-9a-f]{32}/.test(all), "a trace leaked an id");
  assert.match(all, /tool=os_commit outcome=PERSISTED code=NONE/);
  assert.match(all, /w36 trace=snapshot applied_writes=\d+/);
});
