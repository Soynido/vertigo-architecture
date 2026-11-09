/**
 * W3.6 local candidate fixture: one authenticated MCP HTTP entry on this laptop, for a real chat against a synthetic
 * world. It is NOT production adoption of Sales 0.5.11 and NOT a proof of 0.5.12: the business world is the
 * guardWorld() test world (rep A, cursor on B0, Sales 0.5.11 candidate adapter injected into this world only).
 *
 * What is real: createServer/startHttpServer, the five-tool surface, os_commit's executor and the PostgreSQL
 * transaction store (plans, journaled writes, receipts, leases, events, guard approval), all unchanged. What is
 * synthetic: the Notion world, held in a Map, snapshotted atomically after every applied write and restored before
 * serving, so the business rows and the transaction rows survive a restart together — or the process refuses.
 *
 *   node test/support/local-candidate.ts --database-url postgresql://<user>@127.0.0.1:5432/vertigo_w36_local \
 *     [--port 8787] [--host 127.0.0.1] [--state-dir <dir>] [--token-dir <dir>] [--allow-path-token]
 *
 * Refused before any connection: a non-loopback database or listener, any database other than vertigo_w36_local,
 * URL query parameters, a Notion token or a live HARNESS_ENV in the environment. The bearer token is generated once
 * (0600, never printed) and reused. The process clock is frozen on guardWorld's NOW, here only.
 */
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { approveGuard } from "../../src/cli/guard-approve.ts";
import { serverImplementationVersion } from "../../src/index.ts";
import type { NotionReadClient } from "../../src/notion/client.ts";
import { redactSecrets } from "../../src/server/redact.ts";
import { FileHttpTokenRegistry, sha256, startHttpServer } from "../../src/server/http.ts";
import { PostgresBackend } from "../../src/store/postgres.ts";
import type { CommitDeps } from "../../src/transactions/commit.ts";
import { OWNER } from "../unit/binding-fixtures.ts";
import { CLASSES, guardWorld, index, NOW } from "./guard-fixtures.ts";

export const W36_DATABASE = "vertigo_w36_local";
export const W36_SCHEMA = "w36_candidate";
export const TOKEN_FILE = "bearer.token";
export const SNAPSHOT_FILE = "world.snapshot.json";
const SNAPSHOT_FORMAT = "W36_LOCAL_WORLD_SNAPSHOT/1";
const FIXTURE_ID = "SALES_0511_GUARD_TEST_WORLD";
const DEFAULT_RUN_DIR = new URL("../../.run/w36-local/", import.meta.url);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
/** The sole principal: the guard world's owner, restricted to SALES so a bare os_bind infers the lane. */
const PRINCIPAL = { ...OWNER, allowed_lanes: ["SALES" as const] };

export class LocalCandidateRefusal extends Error {
  override readonly name = "LocalCandidateRefusal";
}

export interface LocalCandidateOptions {
  readonly databaseUrl: string | undefined;
  readonly host?: string;
  readonly port?: number;
  readonly schema?: string;
  readonly stateDir?: string;
  readonly tokenDir?: string;
  readonly allowPathToken?: boolean;
}

export interface LocalCandidateConfig {
  readonly scopedDatabaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly schema: string;
  readonly stateDir: string;
  readonly tokenDir: string;
  readonly allowPathToken: boolean;
}

/** Pure: everything that must be refused before a socket is opened. Never echoes the URL. */
export function validateLocalCandidate(o: LocalCandidateOptions, env: NodeJS.ProcessEnv = process.env): LocalCandidateConfig {
  for (const key of ["NOTION_TOKEN", "NOTION_READ_TOKEN"]) if (env[key]?.trim()) throw new LocalCandidateRefusal(`${key} is set: the local candidate never runs next to a Notion credential`);
  const harnessEnv = env["HARNESS_ENV"]?.trim();
  if (harnessEnv && harnessEnv !== "fixture") throw new LocalCandidateRefusal("HARNESS_ENV is not fixture: the local candidate never runs in a live environment");
  if (!o.databaseUrl) throw new LocalCandidateRefusal(`a database URL is required (local host, database ${W36_DATABASE})`);
  let url: URL;
  try { url = new URL(o.databaseUrl); } catch { throw new LocalCandidateRefusal("the database URL cannot be parsed"); }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new LocalCandidateRefusal("the database URL is not a PostgreSQL URL");
  if (!LOOPBACK.has(url.hostname)) throw new LocalCandidateRefusal("the database host is not loopback");
  if (decodeURIComponent(url.pathname.replace(/^\//, "")) !== W36_DATABASE) throw new LocalCandidateRefusal(`the database is not ${W36_DATABASE}`);
  // A query string can redirect the host (?host=) or the schema (?options=): none is accepted.
  if (url.search || url.hash) throw new LocalCandidateRefusal("the database URL must carry no query parameters");
  const host = o.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) throw new LocalCandidateRefusal("the listener host is not loopback");
  const port = o.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new LocalCandidateRefusal("the listener port is invalid");
  const schema = o.schema ?? W36_SCHEMA;
  if (!/^w36_(candidate|test_[0-9a-f]{8,32})$/.test(schema)) throw new LocalCandidateRefusal("the schema is not an isolated w36 schema");
  return {
    scopedDatabaseUrl: `${url.href}?options=${encodeURIComponent(`-c search_path=${schema}`)}`,
    host, port, schema,
    stateDir: resolve(o.stateDir ?? fileURLToPath(new URL("state/", DEFAULT_RUN_DIR))),
    tokenDir: resolve(o.tokenDir ?? fileURLToPath(new URL("token/", DEFAULT_RUN_DIR))),
    allowPathToken: o.allowPathToken ?? false,
  };
}

/** Owner-only or refused: a directory 0700, a file 0600, both owned by this user. */
function assertPrivate(path: string, kind: "dir" | "file"): void {
  const s = lstatSync(path);
  if (kind === "dir" ? !s.isDirectory() : !s.isFile()) throw new LocalCandidateRefusal(`a private ${kind} is expected`);
  if (typeof process.getuid === "function" && s.uid !== process.getuid()) throw new LocalCandidateRefusal(`a private ${kind} is owned by another user`);
  if ((s.mode & 0o077) !== 0) throw new LocalCandidateRefusal(`a private ${kind} is readable by group or others`);
}

function privateDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivate(dir, "dir");
}

/** Generates the bearer token once (never printed) and reuses it; only its hash is held in memory. */
export function ensureLocalToken(tokenDir: string): { readonly file: string; readonly sha256: string } {
  privateDir(tokenDir);
  const file = join(tokenDir, TOKEN_FILE);
  if (!existsSync(file)) writeFileSync(file, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
  assertPrivate(file, "file");
  const token = readFileSync(file, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{43,}$/.test(token)) throw new LocalCandidateRefusal("the token file does not hold a generated token");
  return { file, sha256: sha256(token) };
}

interface Snapshot { readonly format: string; readonly fixture: string; readonly schema: string; readonly applied_writes: number; readonly world: Record<string, unknown> }

/**
 * Restores the business world before serving, after checking it against the transaction store. Never resets either
 * side: missing snapshots, foreign snapshots and missing journaled created pages are refused. Ambiguous writes
 * remain the executor's recovery responsibility; this is not an equality check between the two stores.
 */
async function restoreWorld(map: Map<string, unknown>, file: string, backend: PostgresBackend, schema: string): Promise<number> {
  // A write that left PENDING may have reached the world; a PENDING one never did.
  const sent = (await backend.pool.query("select count(*)::int as n from plan_writes where status <> 'PENDING'")).rows[0]?.n as number;
  const created = (await backend.pool.query("select created_id from plan_writes where created_id is not null")).rows.map((r) => r.created_id as string);
  if (!existsSync(file)) {
    if (sent > 0) throw new LocalCandidateRefusal("the transaction store journals sent writes but no world snapshot exists");
    return 0;
  }
  assertPrivate(file, "file");
  const s = JSON.parse(readFileSync(file, "utf8")) as Partial<Snapshot>;
  if (s.format !== SNAPSHOT_FORMAT || s.fixture !== FIXTURE_ID || s.schema !== schema || typeof s.applied_writes !== "number" || !s.world || typeof s.world !== "object") {
    throw new LocalCandidateRefusal("the world snapshot does not belong to this fixture and schema");
  }
  if (s.applied_writes > 0 && sent === 0) throw new LocalCandidateRefusal("the world snapshot holds applied writes but the transaction store journals none");
  const world = new Map(Object.entries(s.world));
  if (created.some((id) => !world.has(`page:${id}`))) throw new LocalCandidateRefusal("a journaled created page is missing from the world snapshot");
  map.clear();
  for (const [k, v] of world) map.set(k, v);
  return s.applied_writes;
}

function writeSnapshot(file: string, map: ReadonlyMap<string, unknown>, schema: string, applied: number): void {
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, fixture: FIXTURE_ID, schema, applied_writes: applied, world: Object.fromEntries(map) };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600, flush: true });
  renameSync(tmp, file);
}

/** One synthetic approval of the guard, through the PostgreSQL store; an approval of another digest is a refusal. */
async function approveOnce(deps: CommitDeps, backend: PostgresBackend): Promise<void> {
  const req = { principal_id: PRINCIPAL.principal_id, project: "VERTIGO", operator_id: "w36-local-fixture", now: new Date(NOW.getTime()) };
  const preview = await approveGuard(deps, req);
  if (preview.kind !== "PREVIEW") throw new LocalCandidateRefusal(`the synthetic guard cannot be previewed (${preview.kind})`);
  const existing = (await backend.pool.query("select digest_sha256 from guard_approvals")).rows.map((r) => r.digest_sha256 as string);
  if (existing.length > 0) {
    if (existing.every((d) => d === preview.digest_sha256)) return;
    throw new LocalCandidateRefusal("the stored guard approval does not match the restored world");
  }
  const approved = await approveGuard(deps, { ...req, approve_digest: preview.digest_sha256 });
  if (approved.kind !== "APPROVED") throw new LocalCandidateRefusal("the synthetic guard approval was refused");
}

export interface LocalCandidate { readonly port: number; readonly version: string; close(): Promise<void> }

/** Starts the entry. Requires the frozen process clock: only this file's standalone process sets it. */
export async function startLocalCandidate(c: LocalCandidateConfig): Promise<LocalCandidate> {
  if (Date.now() !== NOW.getTime()) throw new LocalCandidateRefusal("the process clock is not frozen on the fixture NOW");
  privateDir(c.stateDir);
  const token = ensureLocalToken(c.tokenDir);
  const snapshotFile = join(c.stateDir, SNAPSHOT_FILE);

  const admin = new PostgresBackend(c.scopedDatabaseUrl);
  try { await admin.pool.query(`create schema if not exists ${c.schema}`); } finally { await admin.close(); }
  const backend = new PostgresBackend(c.scopedDatabaseUrl);
  try {
    const where = (await backend.pool.query("select current_database() as db, current_schema() as schema")).rows[0] as { db: string; schema: string };
    if (where.db !== W36_DATABASE || where.schema !== c.schema) throw new LocalCandidateRefusal("the connection is not scoped to the w36 database and schema");
    await backend.migrateAll(new URL("../../migrations/", import.meta.url));

    // Serve the exact UPSERT intent delivered by os_resume, not the legacy CREATE-only fixture shortcut.
    const g = guardWorld({ doc: index([], [
      { ...CLASSES.b0Answer, operation: "UPSERT", allowed_fields: [...CLASSES.b0Answer.allowed_fields] },
      CLASSES.cursor(),
    ]) });
    g.w.setPrincipals([PRINCIPAL]);
    let applied = await restoreWorld(g.map, snapshotFile, backend, c.schema);
    g.client.onWrite = () => {
      applied += 1;
      writeSnapshot(snapshotFile, g.map, c.schema, applied);
      console.error(`w36 trace=snapshot applied_writes=${applied}`);
    };
    // The read surface only reads; the fixture client is held as the executor's writer and nowhere else.
    const reads: NotionReadClient = {
      retrievePage: (id) => g.client.retrievePage(id),
      retrieveDatabase: (id) => g.client.retrieveDatabase(id),
      retrieveDataSource: (id) => g.client.retrieveDataSource(id),
      retrieveBlockChildren: (id) => g.client.retrieveBlockChildren(id),
      queryDataSource: (ds) => g.client.queryDataSource(ds),
    };
    const deps: CommitDeps = { ...g.deps, store: backend.store(), notion: reads, notionWriter: g.client, clock: () => new Date(NOW.getTime()) };
    await approveOnce(deps, backend);

    const tokens = new FileHttpTokenRegistry([{ token_sha256: token.sha256, principal_id: PRINCIPAL.principal_id }]);
    const listening = await startHttpServer(deps, tokens, c.port, c.host, c.allowPathToken);
    const version = serverImplementationVersion(deps.config);
    return {
      port: listening.port, version,
      async close() { try { await listening.close(); } finally { await backend.close(); } },
    };
  } catch (err) {
    await backend.close();
    throw err;
  }
}

/** Frozen on guardWorld's NOW for this standalone process only; a test importing this file keeps its own clock. */
function freezeProcessClock(at: Date): void {
  const fixed = at.getTime();
  const Real = Date;
  class Frozen extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed);
      else super(...(args as [number]));
    }
    static override now(): number { return fixed; }
  }
  globalThis.Date = Frozen as DateConstructor;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  let config: LocalCandidateConfig;
  try {
    const port = arg("--port");
    config = validateLocalCandidate({
      databaseUrl: arg("--database-url") ?? process.env["W36_DATABASE_URL"],
      ...(arg("--host") ? { host: arg("--host") as string } : {}),
      ...(port !== undefined ? { port: Number(port) } : {}),
      ...(arg("--schema") ? { schema: arg("--schema") as string } : {}),
      ...(arg("--state-dir") ? { stateDir: arg("--state-dir") as string } : {}),
      ...(arg("--token-dir") ? { tokenDir: arg("--token-dir") as string } : {}),
      allowPathToken: process.argv.includes("--allow-path-token"),
    });
  } catch (err) {
    console.error(`w36-local-candidate refused: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    process.exit(2);
  }
  freezeProcessClock(NOW);
  let running: LocalCandidate;
  try {
    running = await startLocalCandidate(config);
  } catch (err) {
    console.error(`w36-local-candidate refused: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    process.exit(err instanceof LocalCandidateRefusal ? 2 : 1);
  }
  console.log(`w36-local-candidate ready port=${running.port} version=${running.version} persistence=postgresql+world-snapshot`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    running.close().then(() => { console.error("w36-local-candidate stopped"); process.exit(0); }, () => process.exit(1));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
