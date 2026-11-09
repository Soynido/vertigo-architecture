/**
 * META resolver (PV0-003): SPEC_ROOT → governing spec → exact operational locator → current META
 * root + Manifest → locator/Manifest identity check → version classification → runtime generation.
 *
 * The only input is the configured SPEC_ROOT. Nothing about the current runtime is hardcoded and
 * no caller-supplied root, runtime id or gate is ever accepted. Every contradiction HOLDs with
 * evidence; the resolver never picks a runtime by narration.
 */
import { runtimeGeneration } from "../binding/handle.ts";
import { listAllChildren, type NotionReadClient } from "../notion/readClient.ts";
import { keyValueItems, normalizeId, propMentions, propText, sectionItems, type Block, type Page } from "../notion/shapes.ts";
import type { Epistemic } from "../tools/envelope.ts";
import type { MetaSpecAdapter } from "../versions/adapters/meta.ts";
import type { AdapterRegistry, ClassifiedVersion, MetaRuntimeAdapter } from "../versions/registry.ts";
import { classifyVersions, parseSpecRoot } from "../versions/specRoot.ts";
import type { ObservedPins, ResolutionOutcome, RuntimeResolver } from "./types.ts";

const UNKNOWN: Epistemic = "UNKNOWN";
const NOT_APPLICABLE: Epistemic = "NOT_APPLICABLE";

function hold(code: ResolutionOutcome extends infer T ? (T extends { kind: "HOLD"; code: infer C } ? C : never) : never, evidence: string[]): ResolutionOutcome {
  return { kind: "HOLD", code, evidence };
}

export class MetaRuntimeResolver implements RuntimeResolver {
  readonly #notion: NotionReadClient;
  readonly #specRoot: string;
  readonly #project: string;
  readonly #adapters: AdapterRegistry<MetaRuntimeAdapter>;

  constructor(notion: NotionReadClient, specRoot: string, project: string, adapters: AdapterRegistry<MetaRuntimeAdapter>) {
    this.#notion = notion;
    this.#specRoot = specRoot;
    this.#project = project;
    this.#adapters = adapters;
  }

  async resolve(): Promise<ResolutionOutcome> {
    const specRootId = normalizeId(this.#specRoot);
    if (!specRootId) return hold("HOLD_BOOTSTRAP_DISCOVERY", ["configured SPEC_ROOT is not a Notion page id/url"]);

    // 1. SPEC_ROOT → governing spec state.
    let specChildren: readonly Block[];
    try {
      specChildren = await listAllChildren(this.#notion, specRootId);
    } catch (err) {
      return hold("HOLD_BOOTSTRAP_DISCOVERY", [`SPEC_ROOT unreadable: ${(err as Error).message}`]);
    }
    const specState = parseSpecRoot(specChildren);
    const versions = classifyVersions(specState, specRootId);
    if (!versions.ok) return hold("HOLD_VERSION_RESOLUTION", [...versions.evidence]);

    // 2. Adapter for the GOVERNING spec only. Candidates never select an adapter.
    const adapter = this.#adapters.resolve(versions.governing.spec.value) as MetaSpecAdapter | undefined;
    if (!adapter) {
      return hold("HOLD_UNSUPPORTED_GOVERNING_VERSION", [`governing ${versions.governing.spec.value} has no adapter; supported: ${this.#adapters.supported().join(", ") || "none"}`]);
    }
    if (!adapter.supportedSchemas.includes(versions.governing.schema.value)) {
      return hold("HOLD_UNSUPPORTED_GOVERNING_VERSION", [`governing schema ${versions.governing.schema.value} is not supported by the ${adapter.specVersion} adapter (${adapter.supportedSchemas.join(", ")})`]);
    }
    const g = adapter.grammar;

    // 3. Exact operational locator: exactly one child page with the adapter's locator title.
    const locators = specState.children.filter((c) => c.title.trim() === g.locatorTitle);
    if (locators.length !== 1) {
      return hold("HOLD_BOOTSTRAP_DISCOVERY", [`expected exactly one locator page titled "${g.locatorTitle}" under SPEC_ROOT, found ${locators.length}`]);
    }
    const locator = locators[0] as { id: string; title: string };

    // 4. Locator pointers.
    let locatorItems;
    try {
      locatorItems = keyValueItems(sectionItems(await listAllChildren(this.#notion, locator.id), "Current runtime pointer"));
    } catch (err) {
      return hold("HOLD_BOOTSTRAP_DISCOVERY", [`locator unreadable: ${(err as Error).message}`]);
    }
    const item = (key: string) => locatorItems.find((i) => i.key === key);
    const rootItem = item(g.locatorKeys.currentRoot);
    const manifestItem = item(g.locatorKeys.currentManifest);
    const runtimeIdItem = item(g.locatorKeys.runtimeId);
    const pointerGenItem = item(g.locatorKeys.pointerGeneration);
    const missing = [
      [g.locatorKeys.currentRoot, rootItem?.mentions[0]],
      [g.locatorKeys.currentManifest, manifestItem?.mentions[0]],
      [g.locatorKeys.runtimeId, runtimeIdItem?.value],
    ].filter(([, v]) => !v).map(([k]) => k as string);
    if (missing.length > 0) return hold("HOLD_BOOTSTRAP_DISCOVERY", missing.map((k) => `locator is missing a usable "${k}" pointer`));
    const locatorRootId = rootItem?.mentions[0] as string;
    const locatorManifestId = manifestItem?.mentions[0] as string;
    const locatorRuntimeId = runtimeIdItem?.value as string;
    const pointerGeneration = pointerGenItem?.value || UNKNOWN;
    if ((rootItem?.mentions.length ?? 0) > 1 || (manifestItem?.mentions.length ?? 0) > 1) {
      return hold("HOLD_RUNTIME_AMBIGUOUS", ["locator points to more than one root or Manifest"]);
    }

    // 5. Fetch root and Manifest.
    let root: Page;
    let manifest: Page;
    try {
      [root, manifest] = (await Promise.all([this.#notion.retrievePage(locatorRootId), this.#notion.retrievePage(locatorManifestId)])) as [Page, Page];
    } catch (err) {
      return hold("HOLD_RUNTIME_NOT_FOUND", [`root/Manifest unreadable: ${(err as Error).message}`]);
    }
    if (root.archived || root.in_trash) return hold("HOLD_RUNTIME_NOT_FOUND", [`META root ${locatorRootId} is archived`]);
    if (manifest.archived || manifest.in_trash) return hold("HOLD_RUNTIME_NOT_FOUND", [`Manifest ${locatorManifestId} is archived`]);

    // 6. Locator ↔ Manifest identity. Any disagreement HOLDs; nothing is chosen by narration.
    const manifestRootId = normalizeId(propText(manifest, g.manifestProps.rootUrl));
    const manifestRuntimeId = propText(manifest, g.manifestProps.runtimeId)?.trim();
    const manifestSpecRootId = normalizeId(propText(manifest, g.manifestProps.specRootUrl));
    const mismatches: string[] = [];
    if (manifestRootId !== locatorRootId) mismatches.push(`locator root ${locatorRootId} != Manifest ${g.manifestProps.rootUrl} ${manifestRootId ?? "UNKNOWN"}`);
    if (manifestRuntimeId !== locatorRuntimeId) mismatches.push(`locator runtime id ${locatorRuntimeId} != Manifest ${g.manifestProps.runtimeId} ${manifestRuntimeId ?? "UNKNOWN"}`);
    if (manifestSpecRootId !== undefined && manifestSpecRootId !== specRootId) mismatches.push(`Manifest ${g.manifestProps.specRootUrl} ${manifestSpecRootId} != configured SPEC_ROOT ${specRootId}`);
    if (mismatches.length > 0) return hold("HOLD_RUNTIME_MANIFEST_MISMATCH", mismatches);

    // 7. Version pins observed on the Manifest (reported, compared, never rewritten).
    const manifestPins: ObservedPins = {
      ref: locatorManifestId,
      spec: propText(manifest, g.manifestProps.specVersion)?.trim() || UNKNOWN,
      schema: propText(manifest, g.manifestProps.schemaVersion)?.trim() || UNKNOWN,
      control: propText(manifest, g.manifestProps.controlVersion)?.trim() || UNKNOWN,
    };
    const warnings: string[] = [];
    for (const [k, observed, governing] of [
      ["spec", manifestPins.spec, versions.governing.spec.value],
      ["schema", manifestPins.schema, versions.governing.schema.value],
      ["control", manifestPins.control, versions.governing.control.value],
    ] as const) {
      if (observed !== governing) warnings.push(`manifest_${k}_pin_differs_from_governing: manifest=${observed} governing=${governing}`);
    }

    // 8. Historical Run pins: the Run the Manifest points at keeps the versions it started with.
    const historical: ObservedPins[] = [];
    const lastRunIds = propMentions(manifest, g.manifestProps.lastRunRef);
    for (const runId of lastRunIds) {
      try {
        const run = (await this.#notion.retrievePage(runId)) as Page;
        historical.push({
          ref: runId,
          spec: propText(run, g.runProps.specVersion)?.trim() || UNKNOWN,
          schema: propText(run, g.runProps.schemaVersion)?.trim() || UNKNOWN,
          control: propText(run, g.runProps.controlVersion)?.trim() || UNKNOWN,
          status: propText(run, g.runProps.status)?.trim() || UNKNOWN,
        });
      } catch (err) {
        warnings.push(`last_run_unreadable: ${runId} (${(err as Error).message})`);
        historical.push({ ref: runId, spec: UNKNOWN, schema: UNKNOWN, control: UNKNOWN, status: UNKNOWN });
      }
    }
    const historicalPins: ClassifiedVersion[] = historical.flatMap((h) =>
      [h.spec, h.schema, h.control].filter((v): v is string => v !== UNKNOWN && v !== NOT_APPLICABLE).map((v) => ({ value: v, klass: "HISTORICAL_PIN" as const, evidence_ref: h.ref })),
    );

    // 9. Descriptive locator fields (state/control) are informational; if they lag the Manifest, warn only.
    const locatorState = item("Runtime state")?.value;
    const manifestState = propText(manifest, g.manifestProps.runtimeState)?.trim();
    if (locatorState && manifestState && locatorState !== manifestState) warnings.push(`locator_descriptive_state_stale: locator=${locatorState} manifest=${manifestState}`);
    const locatorControl = item("Control contract")?.value;
    if (locatorControl && manifestPins.control !== UNKNOWN && locatorControl !== manifestPins.control) warnings.push(`locator_descriptive_control_stale: locator=${locatorControl} manifest=${manifestPins.control}`);

    // 10. Runtime generation.
    const logicalKey = `${this.#project}/META`;
    const generation = runtimeGeneration({ logicalKey, rootId: locatorRootId, manifestId: locatorManifestId, pointerGeneration: pointerGeneration === UNKNOWN ? undefined : pointerGeneration });

    return {
      kind: "RESOLVED",
      runtime: {
        access_mode: "BUSINESS",
        lane: "META",
        logical_key: logicalKey,
        runtime_id: locatorRuntimeId,
        root_ref: locatorRootId,
        manifest_ref: locatorManifestId,
        locator_ref: locator.id,
        pointer_generation: pointerGeneration,
        runtime_generation: generation,
        lifecycle_state: manifestState || UNKNOWN,
        owner_display: NOT_APPLICABLE,
        versions: {
          governing_spec: versions.governing.spec,
          governing_schema: versions.governing.schema,
          governing_control: versions.governing.control,
          candidates: versions.candidates,
          historical_pins: historicalPins,
        },
        manifest_pins: manifestPins,
        historical_pins: historical,
        adopted_records: versions.adopted,
        observations: {
          spec_root: specRootId,
          spec_readiness: versions.readiness,
          adapter: adapter.specVersion,
          locator_version: item(g.locatorKeys.locatorVersion)?.value ?? UNKNOWN,
          manifest_last_edited_time: manifest.last_edited_time ?? UNKNOWN,
        },
        warnings,
        adapter: { version: adapter.specVersion, controlPlane: adapter.grammar.controlPlane },
      },
    };
  }
}
