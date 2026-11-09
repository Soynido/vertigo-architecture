/**
 * ADMISSION-SALES-001 (DELIVERY_CONTRACT/0.1.0-rc2 §4) — the runtime is admitted to business work only when
 * every authoritative precondition is satisfied at once. The Manifest carries identity, install, versions and
 * blockers; OS State carries progression. A blocker declared on the Manifest is a blocker on the runtime even
 * when the progression row next to it is healthy: the two rows are a conjunction, never a fallback.
 *
 * This predicate is the single place that reads the Manifest's blockers. Resume derivation, TARGET and FINAL
 * all consult it; none of them keeps a private copy of the rule.
 */
import type { NotionReadClient } from "../notion/readClient.ts";
import type { Page } from "../notion/shapes.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import { readCursor } from "./readers.ts";
import type { CursorRow } from "./snapshot.ts";

/** Every blocker the Manifest declares, as evidence strings. Empty means the Manifest admits the runtime. */
export function manifestBlockers(manifest: CursorRow): string[] {
  const out: string[] = [];
  if (manifest.recovery_required === true) out.push("Manifest declares Recovery Required");
  if (typeof manifest.persistence_health === "string" && manifest.persistence_health.startsWith("HOLD")) out.push(`Manifest declares persistence health ${manifest.persistence_health}`);
  // An absent or unreadable health is UNKNOWN: no declaration is not a declared blocker. Any other value that is
  // not HEALTHY is one — HOLD, DEGRADED or whatever the owner wrote there.
  if (typeof manifest.health === "string" && manifest.health !== "HEALTHY" && manifest.health !== "UNKNOWN") out.push(`Manifest declares Health Status ${manifest.health}`);
  return out;
}

/** Blockers the progression row itself declares (or the Manifest, when it is the only cursor). */
export function cursorBlockers(cursor: CursorRow, label: "OS State" | "Manifest"): string[] {
  const out: string[] = [];
  if (cursor.recovery_required === true) out.push(`${label} declares Recovery Required`);
  if (typeof cursor.persistence_health === "string" && cursor.persistence_health.startsWith("HOLD")) out.push(`persistence health ${cursor.persistence_health}`);
  return out;
}

/** True when neither row declares a blocker: the conjunction the historical classifiers already relied on. */
export function admitted(cursor: CursorRow, manifest: CursorRow): boolean {
  return cursorBlockers(cursor, "OS State").length === 0 && manifestBlockers(manifest).length === 0;
}

/**
 * The Manifest re-read from Notion for a verification phase. TARGET and FINAL never trust the snapshot the plan
 * was prepared on: a Manifest that turned after prepare must stop the transaction before a receipt is issued.
 */
export async function readManifestBlockers(client: NotionReadClient, runtime: ResolvedRuntime): Promise<{ readonly blockers: string[] } | { readonly unreadable: string }> {
  try {
    const page = (await client.retrievePage(runtime.manifest_ref)) as Page;
    return { blockers: manifestBlockers(readCursor(page, runtime.adapter.controlPlane.manifestCursor)) };
  } catch (err) {
    return { unreadable: `Manifest ${runtime.manifest_ref} unreadable: ${(err as Error).message}` };
  }
}
