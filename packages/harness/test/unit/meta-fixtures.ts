/**
 * REST-shaped META fixtures. All identities and versions are synthetic (TEST_SPEC / TEST_SCHEMA /
 * TEST_CONTROL families, fabricated ids) so that PT-ARCH-002 keeps holding.
 */
import { FixtureNotionReadClient } from "../../src/notion/readClient.ts";
import type { Block, Page, RichText } from "../../src/notion/shapes.ts";
import { metaSpecAdapter, type MetaAddressingGrammar } from "../../src/versions/adapters/meta.ts";
import { META_CONTROL_PLANE_06 } from "../../src/versions/adapters/controlPlane.ts";
import { createAdapterRegistries, type AdapterRegistries } from "../../src/versions/registry.ts";
import { MetaRuntimeResolver } from "../../src/resolvers/meta.ts";
import { createHash } from "node:crypto";

/** Synthetic 32-hex ids derived from a label at import time, so no page id literal exists in source. */
export function synthetic(label: string): string {
  return createHash("sha256").update(`fixture:${label}`).digest("hex").slice(0, 32);
}

export const ID = {
  specRoot: synthetic("spec-root"),
  locator: synthetic("locator"),
  rootA: synthetic("root-a"),
  rootB: synthetic("root-b"),
  manifest: synthetic("manifest"),
  runOld: synthetic("run-old"),
  candidatePage: synthetic("candidate-page"),
} as const;

export const V: Record<"specA" | "specB" | "specCandidate" | "schema" | "controlA" | "controlB", string> = {
  specA: "TEST_SPEC/1.0.0",
  specB: "TEST_SPEC/2.0.0",
  specCandidate: "TEST_SPEC/2.1.0",
  schema: "TEST_SCHEMA/1.0.0",
  controlA: "TEST_CONTROL/1.0",
  controlB: "TEST_CONTROL/1.1",
};

export const GRAMMAR: MetaAddressingGrammar = {
  locatorTitle: "LOCATOR — OPERATIONAL",
  locatorKeys: { currentRoot: "Current root", currentManifest: "Current Manifest", runtimeId: "Runtime ID", pointerGeneration: "Pointer generation", locatorVersion: "Locator version" },
  manifestProps: { rootUrl: "Root URL", runtimeId: "Runtime ID", specRootUrl: "Spec Root URL", specVersion: "Spec Version", schemaVersion: "Schema Version", controlVersion: "Control Version", runtimeState: "Runtime State", lastRunRef: "Last Run Ref" },
  runProps: { runId: "Run ID", status: "Status", specVersion: "Spec Version", schemaVersion: "Schema Version", controlVersion: "Control Version" },
  controlPlane: META_CONTROL_PLANE_06,
};

export function text(s: string, code = false): RichText {
  return { type: "text", plain_text: s, annotations: { code } };
}
export function mention(id: string): RichText {
  return { type: "mention", plain_text: "Untitled", mention: { type: "page", page: { id } } };
}
export function bullet(rich: RichText[]): Block {
  return { id: `blk-${Math.random().toString(16).slice(2)}`, type: "bulleted_list_item", bulleted_list_item: { rich_text: rich } };
}
export function heading(s: string): Block {
  return { id: `h-${s}`, type: "heading_2", heading_2: { rich_text: [text(s)] } };
}
export function childPage(id: string, title: string): Block {
  return { id, type: "child_page", child_page: { title } };
}
export function kv(key: string, value: string, code = true): Block {
  return bullet([text(`${key}: `), text(value, code)]);
}
export function kvMention(key: string, id: string): Block {
  return bullet([text(`${key}: `), mention(id)]);
}

export interface SpecRootOptions {
  spec?: string;
  schema?: string;
  control?: string;
  readiness?: string;
  extraChildren?: Block[];
  omitLocator?: boolean;
  duplicateLocator?: boolean;
}

export function specRootChildren(o: SpecRootOptions = {}): Block[] {
  const children: Block[] = [
    heading("Status"),
    kv("Spec current", o.spec ?? V.specA),
    kv("META runtime schema", o.schema ?? V.schema),
    kv("Deterministic control contract", o.control ?? V.controlA),
    kv("Spec readiness", o.readiness ?? "SPEC_FROZEN"),
    heading("Reading order"),
    childPage(synthetic("purpose-page"), "00 — PURPOSE"),
  ];
  if (!o.omitLocator) children.push(childPage(ID.locator, GRAMMAR.locatorTitle));
  if (o.duplicateLocator) children.push(childPage(synthetic("duplicate-locator"), GRAMMAR.locatorTitle));
  children.push(...(o.extraChildren ?? []));
  return children;
}

export interface LocatorOptions {
  rootId?: string;
  manifestId?: string;
  runtimeId?: string;
  pointerGeneration?: string;
  runtimeState?: string;
  control?: string;
}

export function locatorChildren(o: LocatorOptions = {}): Block[] {
  return [
    heading("Current runtime pointer"),
    kv("Locator version", "TEST_LOCATOR/1.0"),
    kvMention("Current root", o.rootId ?? ID.rootA),
    kvMention("Current Manifest", o.manifestId ?? ID.manifest),
    kv("Runtime ID", o.runtimeId ?? "RT-TEST-01"),
    kv("Runtime state", o.runtimeState ?? "SETUP", false),
    kv("Control contract", o.control ?? V.controlA),
    kv("Pointer generation", o.pointerGeneration ?? "1"),
    heading("Mandatory discovery algorithm"),
    bullet([text("1. Fetch SPEC_ROOT.")]),
  ];
}

export interface ManifestOptions {
  rootId?: string;
  runtimeId?: string;
  specRootId?: string;
  spec?: string;
  schema?: string;
  control?: string;
  runtimeState?: string;
  lastRunId?: string | null;
  archived?: boolean;
}

export function manifestPage(o: ManifestOptions = {}): Page {
  const lastRun = o.lastRunId === undefined ? ID.runOld : o.lastRunId;
  return {
    object: "page",
    id: ID.manifest,
    archived: o.archived ?? false,
    last_edited_time: "2030-01-01T00:00:00.000Z",
    properties: {
      Name: { type: "title", title: [text("CURRENT")] },
      "Root URL": { type: "url", url: `https://example.invalid/p/${o.rootId ?? ID.rootA}` },
      "Runtime ID": { type: "rich_text", rich_text: [text(o.runtimeId ?? "RT-TEST-01")] },
      "Spec Root URL": { type: "url", url: `https://example.invalid/p/${o.specRootId ?? ID.specRoot}` },
      "Spec Version": { type: "rich_text", rich_text: [text(o.spec ?? V.specA)] },
      "Schema Version": { type: "rich_text", rich_text: [text(o.schema ?? V.schema)] },
      "Control Version": { type: "rich_text", rich_text: [text(o.control ?? V.controlA)] },
      "Runtime State": { type: "select", select: { name: o.runtimeState ?? "SETUP" } },
      "Last Run Ref": { type: "rich_text", rich_text: lastRun ? [text("RUN-9 | "), mention(lastRun)] : [] },
    },
  };
}

export function rootPage(id: string, archived = false): Page {
  return { object: "page", id, archived, properties: { title: { type: "title", title: [text("ROOT")] } } };
}

export function runPage(id: string, pins: { spec: string; schema: string; control: string; status?: string }): Page {
  return {
    object: "page",
    id,
    archived: false,
    properties: {
      Run: { type: "title", title: [text("historical run")] },
      "Run ID": { type: "unique_id", unique_id: { prefix: "RUN", number: 9 } },
      Status: { type: "select", select: { name: pins.status ?? "COMPLETED" } },
      "Spec Version": { type: "rich_text", rich_text: [text(pins.spec)] },
      "Schema Version": { type: "rich_text", rich_text: [text(pins.schema)] },
      "Control Version": { type: "rich_text", rich_text: [text(pins.control)] },
    },
  };
}

export interface World {
  specRoot?: Block[];
  locator?: Block[];
  manifest?: Page;
  root?: Page;
  runs?: Page[];
  extraPages?: Page[];
}

export function buildClient(w: World = {}): FixtureNotionReadClient {
  const m = new Map<string, unknown>();
  const list = (blocks: Block[]) => ({ results: blocks, has_more: false, next_cursor: null });
  m.set(`children:${ID.specRoot}`, list(w.specRoot ?? specRootChildren()));
  m.set(`children:${ID.locator}`, list(w.locator ?? locatorChildren()));
  const manifest = w.manifest ?? manifestPage();
  m.set(`page:${manifest.id}`, manifest);
  const root = w.root ?? rootPage(ID.rootA);
  m.set(`page:${root.id}`, root);
  for (const r of w.runs ?? [runPage(ID.runOld, { spec: V.specA, schema: V.schema, control: V.controlA })]) m.set(`page:${r.id}`, r);
  for (const p of w.extraPages ?? []) m.set(`page:${p.id}`, p);
  return new FixtureNotionReadClient(m);
}

export function registries(specVersions: string[] = [V.specA]): AdapterRegistries {
  const r = createAdapterRegistries();
  for (const v of specVersions) r.metaRuntime.register(v, metaSpecAdapter(v, [V.schema], GRAMMAR));
  return r;
}

export function resolver(w: World = {}, specVersions?: string[]): MetaRuntimeResolver {
  return new MetaRuntimeResolver(buildClient(w), `https://example.invalid/p/${ID.specRoot}`, "TESTPROJ", registries(specVersions).metaRuntime);
}
