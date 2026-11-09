/**
 * SPEC_ROOT bootstrap grammar and version classification (07 — VERSION RESOLUTION & CONTROL).
 *
 * The bootstrap grammar is the one fixed convention needed to read anything at all: the SPEC_ROOT
 * page carries a "Status" section of `Key: value` items and a list of child pages. Everything
 * discovered here is classified GOVERNING / CHANGE_CANDIDATE / HISTORICAL_PIN; only GOVERNING may
 * select an adapter or control behavior.
 */
import { childPageTitle, keyValueItems, sectionItems, versionFamily, versionTokens, type Block } from "../notion/shapes.ts";
import { isNonGoverningMarker, type ClassifiedVersion } from "./registry.ts";

export interface SpecRootStatus {
  readonly entries: Readonly<Record<string, string>>;
}

export interface SpecRootChildPage {
  readonly id: string;
  readonly title: string;
}

export interface SpecRootState {
  readonly status: SpecRootStatus;
  readonly children: readonly SpecRootChildPage[];
}

/** Status keys of the bootstrap grammar. These name the governing values; they are not the values. */
export const STATUS_KEYS = {
  spec: "Spec current",
  schema: "META runtime schema",
  control: "Deterministic control contract",
  readiness: "Spec readiness",
} as const;

/** Readiness values that make the declared versions governing. Anything else cannot govern new work. */
const GOVERNING_READINESS = new Set(["SPEC_FROZEN", "FROZEN", "CURRENT", "GOVERNING"]);

export function parseSpecRoot(children: readonly Block[]): SpecRootState {
  const entries: Record<string, string> = {};
  for (const kv of keyValueItems(sectionItems(children, "Status"))) entries[kv.key] = kv.value;
  const pages: SpecRootChildPage[] = [];
  for (const b of children) {
    const title = childPageTitle(b);
    if (title !== undefined) pages.push({ id: b.id.replace(/-/g, "").toLowerCase(), title });
  }
  return { status: { entries }, children: pages };
}

export interface GoverningVersions {
  readonly spec: ClassifiedVersion;
  readonly schema: ClassifiedVersion;
  readonly control: ClassifiedVersion;
}

export type GoverningResolution =
  | { readonly ok: true; readonly governing: GoverningVersions; readonly candidates: readonly ClassifiedVersion[]; readonly adopted: readonly ClassifiedVersion[]; readonly readiness: string }
  | { readonly ok: false; readonly evidence: readonly string[] };

/**
 * Governing = the Status block values, only when readiness explicitly makes them governing.
 * Candidates = version tokens found in child pages marked non-normative/candidate/draft/proposed whose
 * value differs from the governing value of the same family. A candidate page whose versions all equal
 * the governing ones is an adopted record, reported separately and never as a candidate.
 */
export function classifyVersions(state: SpecRootState, specRootRef: string): GoverningResolution {
  const e = state.status.entries;
  const readiness = e[STATUS_KEYS.readiness];
  const missing = [STATUS_KEYS.spec, STATUS_KEYS.schema, STATUS_KEYS.control, STATUS_KEYS.readiness].filter((k) => !e[k]);
  if (missing.length > 0) return { ok: false, evidence: missing.map((k) => `SPEC_ROOT Status is missing "${k}"`) };
  if (!readiness || !GOVERNING_READINESS.has(readiness.toUpperCase())) {
    return { ok: false, evidence: [`SPEC_ROOT readiness "${readiness}" does not make the declared versions governing`] };
  }
  for (const k of [STATUS_KEYS.spec, STATUS_KEYS.schema, STATUS_KEYS.control]) {
    const v = e[k] as string;
    if (isNonGoverningMarker(v)) return { ok: false, evidence: [`SPEC_ROOT "${k}" carries a non-governing marker: ${v}`] };
    if (versionTokens(v).length !== 1) return { ok: false, evidence: [`SPEC_ROOT "${k}" is not a single version token: ${v}`] };
  }
  const gov = (k: string): ClassifiedVersion => ({ value: versionTokens(e[k] as string)[0] as string, klass: "GOVERNING", evidence_ref: `${specRootRef}#Status/${k}` });
  const governing: GoverningVersions = { spec: gov(STATUS_KEYS.spec), schema: gov(STATUS_KEYS.schema), control: gov(STATUS_KEYS.control) };
  const governingByFamily = new Map<string, string>([governing.spec, governing.schema, governing.control].map((v) => [versionFamily(v.value), v.value]));

  const candidates: ClassifiedVersion[] = [];
  const adopted: ClassifiedVersion[] = [];
  for (const page of state.children) {
    if (!isNonGoverningMarker(page.title)) continue;
    const tokens = versionTokens(page.title);
    if (tokens.length === 0) continue;
    const allAdopted = tokens.every((t) => governingByFamily.get(versionFamily(t)) === t);
    for (const t of tokens) {
      const entry: ClassifiedVersion = { value: t, klass: "CHANGE_CANDIDATE", evidence_ref: `${page.id}:${page.title}` };
      if (allAdopted) adopted.push({ ...entry, klass: "HISTORICAL_PIN" });
      else if (governingByFamily.get(versionFamily(t)) !== t) candidates.push(entry);
    }
  }
  return { ok: true, governing, candidates, adopted, readiness };
}
