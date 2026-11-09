/**
 * Backend SALES runtime registry (discovery only).
 *
 * Maps a principal's rep_identity_key to what the backend durably knows about that rep's Personal
 * SALES runtime. It is deployment configuration, never LLM input, and it is never authority over the
 * runtime's state: the canonical Manifest is always re-read. Four existence states are explicit:
 *   KNOWN            — a root pointer exists; the resolver must still prove it is a live instance.
 *   INSTALL_PENDING  — a provisioner assigned a non-template clone to this principal, but the clone is not yet a
 *                      business runtime. Only the dedicated, fail-closed installer may bind it.
 *   NOT_YET_CREATED  — a human/registry declaration that the runtime does not exist yet.
 *   (no entry)       — UNKNOWN: discovery finds nothing and nonexistence is NOT proven.
 *
 * DURABILITY INVARIANT (docs/CONFIGURATION.md § "Registry activation durability"). The file registry is the
 * authority for the INSTALL_PENDING → KNOWN transition, so that transition must be a real compare-and-swap even
 * when two harness processes race. A Promise-local mutation queue only serializes callers inside ONE process and
 * is NOT multi-process atomic; it is therefore deliberately not used. Instead every writer must:
 *   1. hold an exclusive `<registry>.lock` directory created with mkdir (atomic on a local POSIX filesystem);
 *   2. re-read the registry INSIDE the lock — the compare of status/pointer_generation happens on that read;
 *   3. write a temporary file, fsync it, rename it over the registry, then fsync the containing directory so the
 *      rename itself survives a power loss.
 * This is a SINGLE-HOST, LOCAL-FILESYSTEM invariant. Exclusive mkdir is not a reliable mutex over NFS/SMB, so a
 * multi-host deployment must move this registry into PostgreSQL instead of sharing the file.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { normalizeId } from "../notion/shapes.ts";

export interface SalesRuntimeEntry {
  /** Backend-only migration restriction, not a tool input or native permission. */
  readonly operation_policy?: "LEGACY_READ_ONLY";
  readonly rep_identity_key: string;
  readonly status: "KNOWN" | "INSTALL_PENDING" | "NOT_YET_CREATED";
  /** Physical root page id/url. Required when KNOWN. */
  readonly root_ref?: string;
  /** Identity claims the canonical Manifest must satisfy for ownership to be verified. */
  readonly expected_instance_id?: string;
  readonly expected_gmail_identity?: string;
  /** Operator opt-in for the first-link protocol only; does not grant access to a native app. */
  readonly source_identity_enrollment?: readonly string[];
  /** Bumped by a human when the runtime is rotated to a new root; folded into runtime generation. */
  readonly pointer_generation?: string;
  /** Backend-only proof that authorized an INSTALL_PENDING → KNOWN transition. */
  readonly activation_proof_plan_id?: string;
  /**
   * Optional backend-derived pointer to the objective package that governs this rep's runtime. Deployment
   * configuration only: it is surfaced as a read-only observation and is NEVER accepted from chat input,
   * from an LLM tool argument or from any copied Notion value (docs/CONFIGURATION.md).
   */
  readonly objective_package_ref?: string;
  readonly note?: string;
  /** Discovery-time cache of runtime state. Never authority: a fresh Manifest/OS State always wins and a difference is reported as a staleness warning. */
  readonly snapshot?: { readonly install_state?: string; readonly instance_status?: string; readonly current_gate?: string; readonly snapshot_at?: string };
}

export interface SalesRuntimeRegistry {
  lookup(repIdentityKey: string): Promise<SalesRuntimeEntry | undefined>;
  /** Read-only unique assignment, never a mailbox supplied as ownership authority by a caller. */
  uniqueMailboxAssignment?(mailbox: string): Promise<SalesRuntimeEntry | undefined>;
  /** Durable compare-and-swap after FINAL install proof. Returns undefined when the CAS did not apply. */
  activateInstallation(expected: InstallAssignmentSnapshot, proofPlanId: string): Promise<SalesRuntimeEntry | undefined>;
}

function uniqueMailbox(entries: readonly SalesRuntimeEntry[], mailbox: string): SalesRuntimeEntry | undefined {
  const matches = entries.filter((e) => (e.status === "KNOWN" || e.status === "INSTALL_PENDING")
    && e.expected_gmail_identity?.trim().toLowerCase() === mailbox.trim().toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Complete INSTALL_PENDING authority observed by the caller before activation. Optional registry fields are
 * represented as null so absence is part of the comparison too: adding/removing an expected mailbox is a real
 * assignment change, not a harmless metadata edit.
 */
export interface InstallAssignmentSnapshot {
  readonly rep_identity_key: string;
  readonly status: "INSTALL_PENDING";
  readonly pointer_generation: string | null;
  readonly root_ref: string;
  readonly expected_instance_id: string;
  readonly expected_gmail_identity: string | null;
  readonly objective_package_ref: string | null;
  readonly activation_proof_plan_id: string | null;
}

const canonicalRoot = (value: string | undefined): string => normalizeId(value) ?? value?.trim() ?? "";
const canonicalMailbox = (value: string | undefined): string | null => value?.trim().toLowerCase() || null;

/** Captures the exact assignment compare-half. Non-pending/incomplete entries cannot authorize activation. */
export function installAssignmentSnapshot(entry: SalesRuntimeEntry | undefined): InstallAssignmentSnapshot | undefined {
  if (!entry || entry.status !== "INSTALL_PENDING") return undefined;
  const root = canonicalRoot(entry.root_ref);
  const instance = entry.expected_instance_id?.trim() ?? "";
  if (!root || !instance) return undefined;
  return {
    rep_identity_key: entry.rep_identity_key,
    status: "INSTALL_PENDING",
    pointer_generation: entry.pointer_generation ?? null,
    root_ref: root,
    expected_instance_id: instance,
    expected_gmail_identity: canonicalMailbox(entry.expected_gmail_identity),
    objective_package_ref: entry.objective_package_ref?.trim() || null,
    activation_proof_plan_id: entry.activation_proof_plan_id?.trim() || null,
  };
}

const sameAssignment = (current: InstallAssignmentSnapshot | undefined, expected: InstallAssignmentSnapshot): boolean =>
  current !== undefined
  && current.rep_identity_key === expected.rep_identity_key
  && current.status === expected.status
  && current.pointer_generation === expected.pointer_generation
  && current.root_ref === canonicalRoot(expected.root_ref)
  && current.expected_instance_id === expected.expected_instance_id.trim()
  && current.expected_gmail_identity === canonicalMailbox(expected.expected_gmail_identity ?? undefined)
  && current.objective_package_ref === (expected.objective_package_ref?.trim() || null)
  && current.activation_proof_plan_id === (expected.activation_proof_plan_id?.trim() || null);

/** The complete compare half of the CAS, shared by every implementation so file and memory can never diverge. */
function swap(current: SalesRuntimeEntry | undefined, expected: InstallAssignmentSnapshot, proofPlanId: string): SalesRuntimeEntry | undefined {
  if (!current || !sameAssignment(installAssignmentSnapshot(current), expected)) return undefined;
  return { ...current, status: "KNOWN", pointer_generation: bumpGeneration(current.pointer_generation), activation_proof_plan_id: proofPlanId };
}

export class InMemorySalesRuntimeRegistry implements SalesRuntimeRegistry {
  readonly #byKey: Map<string, SalesRuntimeEntry>;
  constructor(entries: readonly SalesRuntimeEntry[]) {
    this.#byKey = new Map(entries.map((e) => [e.rep_identity_key, e]));
  }
  async lookup(repIdentityKey: string): Promise<SalesRuntimeEntry | undefined> {
    return this.#byKey.get(repIdentityKey);
  }
  async uniqueMailboxAssignment(mailbox: string): Promise<SalesRuntimeEntry | undefined> {
    return uniqueMailbox([...this.#byKey.values()], mailbox);
  }
  async activateInstallation(expected: InstallAssignmentSnapshot, proofPlanId: string): Promise<SalesRuntimeEntry | undefined> {
    // Single-threaded by construction: no await separates the compare from the swap.
    const next = swap(this.#byKey.get(expected.rep_identity_key), expected, proofPlanId);
    if (next) this.#byKey.set(expected.rep_identity_key, next);
    return next;
  }
}

const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 15;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Exclusive inter-process lock around `${path}.lock`.
 *
 * The lock is a directory containing one unpredictable owner token. mkdir is the atomic arbiter. We deliberately
 * NEVER reap an existing lock: age-based stat→unlink has an unavoidable inode replacement race and can delete a
 * live writer's new lock. A crashed writer therefore fails closed after the bounded timeout and requires explicit
 * operator cleanup.
 *
 * Release is owner-safe even if an operator replaces the directory while the critical section runs: we remove
 * only our unpredictable token, then rmdir succeeds only when that exact directory is empty. It can never unlink
 * another owner's non-empty lock directory.
 */
export async function withRegistryLock<T>(path: string, fn: () => Promise<T>, options: { readonly acquireTimeoutMs?: number; readonly retryMs?: number } = {}): Promise<T> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + (options.acquireTimeoutMs ?? LOCK_ACQUIRE_TIMEOUT_MS);
  const token = `owner-${process.pid}-${randomBytes(16).toString("hex")}`;
  const ownerPath = join(lockPath, token);
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) throw new Error(`registry lock ${lockPath} is held; activation was not attempted. If its owner crashed, an operator must inspect and remove the abandoned lock directory explicitly`);
      await sleep(options.retryMs ?? LOCK_RETRY_MS);
      continue;
    }
    try {
      const owner = await open(ownerPath, "wx", 0o600);
      try {
        await owner.writeFile(JSON.stringify({ pid: process.pid, token, acquired_at: new Date().toISOString() }));
        await owner.sync();
      } finally {
        await owner.close();
      }
    } catch (err) {
      // mkdir succeeded, so this process owns the still-empty directory. Roll it back if publishing the owner
      // token fails; leaving a false lock would turn an I/O error into a permanent manual-cleanup incident.
      await rm(ownerPath, { force: true });
      await rmdir(lockPath).catch(() => undefined);
      throw err;
    }
    break;
  }
  try {
    return await fn();
  } finally {
    // If lockPath was replaced, ownerPath no longer names our token and this is a harmless ENOENT. If another
    // owner now occupies lockPath, rmdir fails ENOTEMPTY and their lock survives.
    await rm(ownerPath, { force: true });
    await rmdir(lockPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT" && err.code !== "ENOTEMPTY") throw err;
    });
  }
}

/** Durable replace: fsync the payload, rename it into place, then fsync the directory holding the rename. */
async function writeDurable(path: string, text: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
  const dir = await open(dirname(path), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

export class FileSalesRuntimeRegistry implements SalesRuntimeRegistry {
  readonly #path: string;
  constructor(path: string) {
    this.#path = path;
  }
  async uniqueMailboxAssignment(mailbox: string): Promise<SalesRuntimeEntry | undefined> {
    const raw = JSON.parse(await readFile(this.#path, "utf8")) as { runtimes: SalesRuntimeEntry[] };
    return uniqueMailbox(raw.runtimes, mailbox);
  }
  async lookup(repIdentityKey: string): Promise<SalesRuntimeEntry | undefined> {
    // Fresh-read every resolution. A provisioning activation must be visible immediately; a process-lifetime cache
    // would leave old handles authoritative after the backend generation changed.
    const raw = JSON.parse(await readFile(this.#path, "utf8")) as { runtimes: SalesRuntimeEntry[] };
    return raw.runtimes.find((e) => e.rep_identity_key === repIdentityKey);
  }
  /** Operator only, not exposed by the MCP interface. Caller must first prove the target's live identity/pins. */
  async bridgeLegacyRead(expectedSha256: string, target: { readonly rep_identity_key: string; readonly root_ref: string; readonly expected_instance_id: string }, backupPath: string): Promise<LegacyRegistryReceipt | null> {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256) || !/^[a-f0-9]{32}$/i.test(target.root_ref)
      || !target.rep_identity_key || !target.expected_instance_id || !isAbsolute(backupPath) || resolve(backupPath) === resolve(this.#path)) throw new Error("invalid private legacy bridge request");
    return withRegistryLock(this.#path, async () => {
      const before = await readFile(this.#path), hash = registrySha(before);
      if (hash !== expectedSha256) return null; // Preserve ANY concurrent owner's change, not just this entry.
      const raw = JSON.parse(before.toString()) as { runtimes: SalesRuntimeEntry[] };
      const matches = raw.runtimes.map((e, i) => e.rep_identity_key === target.rep_identity_key ? i : -1).filter(i => i >= 0);
      if (matches.length !== 1) throw new Error("legacy assignment missing or ambiguous");
      const index = matches[0]!, previous = raw.runtimes[index]!;
      if (previous.status !== "KNOWN" || !previous.root_ref || !previous.expected_instance_id || previous.operation_policy !== undefined)
        throw new Error("legacy bridge requires a known, non-bridged baseline");
      const { activation_proof_plan_id: _pilotProof, snapshot: _pilotSnapshot, source_identity_enrollment: _pilotEnrollment, ...preserved } = previous;
      raw.runtimes[index] = { ...preserved, root_ref: target.root_ref.toLowerCase(), expected_instance_id: target.expected_instance_id,
        pointer_generation: bumpGeneration(previous.pointer_generation), operation_policy: "LEGACY_READ_ONLY" };
      const candidate = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);
      const backup = await open(backupPath, "wx", 0o600);
      try { await backup.writeFile(before); await backup.sync(); } finally { await backup.close(); }
      if (registrySha(await readFile(backupPath)) !== hash) throw new Error("legacy backup verification failed");
      const backupDir = await open(dirname(backupPath), "r"); try { await backupDir.sync(); } finally { await backupDir.close(); }
      await writeDurable(this.#path, candidate.toString());
      if (registrySha(await readFile(this.#path)) !== registrySha(candidate)) throw new Error("legacy routing readback failed");
      return { kind: "LEGACY_REGISTRY_READ_BRIDGE/1", changed: true, backup_path: backupPath, before_sha256: hash, candidate_sha256: registrySha(candidate) };
    });
  }
  /** A rollback is refused after any intervening registry edit; never erase legitimate concurrent work. */
  async restoreLegacyRead(receipt: LegacyRegistryReceipt): Promise<boolean> {
    if (receipt.kind !== "LEGACY_REGISTRY_READ_BRIDGE/1" || !isAbsolute(receipt.backup_path)
      || resolve(receipt.backup_path) === resolve(this.#path) || !/^[a-f0-9]{64}$/.test(receipt.before_sha256)
      || !/^[a-f0-9]{64}$/.test(receipt.candidate_sha256)) throw new Error("invalid legacy rollback receipt");
    return withRegistryLock(this.#path, async () => {
      if (registrySha(await readFile(this.#path)) !== receipt.candidate_sha256) return false;
      const before = await readFile(receipt.backup_path);
      if (registrySha(before) !== receipt.before_sha256) throw new Error("legacy rollback backup mismatch");
      await writeDurable(this.#path, before.toString());
      return registrySha(await readFile(this.#path)) === receipt.before_sha256;
    });
  }
  async activateInstallation(expected: InstallAssignmentSnapshot, proofPlanId: string): Promise<SalesRuntimeEntry | undefined> {
    return withRegistryLock(this.#path, async () => {
      const raw = JSON.parse(await readFile(this.#path, "utf8")) as { runtimes: SalesRuntimeEntry[] };
      const index = raw.runtimes.findIndex((e) => e.rep_identity_key === expected.rep_identity_key);
      const next = swap(raw.runtimes[index], expected, proofPlanId);
      if (!next) return undefined;
      raw.runtimes[index] = next;
      await writeDurable(this.#path, `${JSON.stringify(raw, null, 2)}\n`);
      return next;
    });
  }
}

export interface LegacyRegistryReceipt {
  readonly kind: "LEGACY_REGISTRY_READ_BRIDGE/1";
  readonly changed: true;
  readonly backup_path: string;
  readonly before_sha256: string;
  readonly candidate_sha256: string;
}
const registrySha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function bumpGeneration(value: string | undefined): string {
  const n = Number(value);
  return value !== undefined && Number.isSafeInteger(n) && n >= 0 ? String(n + 1) : `${value ?? "0"}.installed`;
}

/** Registry configured with nothing: every lookup is UNKNOWN (never NOT_YET_CREATED). */
export const EMPTY_SALES_REGISTRY: SalesRuntimeRegistry = { async lookup() { return undefined; }, async activateInstallation() { return undefined; } };
