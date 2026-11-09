/**
 * META runtime adapters, keyed by the GOVERNING spec version discovered at call time.
 *
 * An adapter declares how a given spec/schema line addresses its runtime: the exact operational
 * locator page title, the locator's key names, and the Manifest/Run property names. The keys
 * registered here are CAPABILITY declarations ("this backend understands these versions"), not
 * assumptions about current state: if the discovered governing version has no adapter, resolution
 * HOLDs with HOLD_UNSUPPORTED_GOVERNING_VERSION instead of guessing.
 */
import type { AdapterRegistry, MetaRuntimeAdapter } from "../registry.ts";
import { META_CONTROL_PLANE_06, type ControlPlaneGrammar } from "./controlPlane.ts";

export interface MetaAddressingGrammar {
  /** Exact title of the operational locator child page under SPEC_ROOT. */
  readonly locatorTitle: string;
  readonly locatorKeys: {
    readonly currentRoot: string;
    readonly currentManifest: string;
    readonly runtimeId: string;
    readonly pointerGeneration: string;
    readonly locatorVersion: string;
  };
  readonly manifestProps: {
    readonly rootUrl: string;
    readonly runtimeId: string;
    readonly specRootUrl: string;
    readonly specVersion: string;
    readonly schemaVersion: string;
    readonly controlVersion: string;
    readonly runtimeState: string;
    readonly lastRunRef: string;
  };
  readonly runProps: {
    readonly runId: string;
    readonly status: string;
    readonly specVersion: string;
    readonly schemaVersion: string;
    readonly controlVersion: string;
  };
  readonly controlPlane: ControlPlaneGrammar;
}

export interface MetaSpecAdapter extends MetaRuntimeAdapter {
  readonly specVersion: string;
  readonly supportedSchemas: readonly string[];
  readonly grammar: MetaAddressingGrammar;
}

/** Addressing grammar shared by the META_SPEC 0.6 line (META_SCHEMA 0.2). */
const GRAMMAR_06: MetaAddressingGrammar = {
  locatorTitle: "00Z — META RUNTIME LOCATOR — OPERATIONAL",
  locatorKeys: {
    currentRoot: "Current META root",
    currentManifest: "Current Manifest / CURRENT",
    runtimeId: "Runtime ID",
    pointerGeneration: "Pointer generation",
    locatorVersion: "Locator version",
  },
  manifestProps: {
    rootUrl: "Meta Root URL",
    runtimeId: "Meta Runtime ID",
    specRootUrl: "Spec Root URL",
    specVersion: "Spec Version",
    schemaVersion: "META Schema Version",
    controlVersion: "Control Version",
    runtimeState: "Runtime State",
    lastRunRef: "Last Run Ref",
  },
  runProps: {
    runId: "Run ID",
    status: "Status",
    specVersion: "Spec Version",
    schemaVersion: "META Schema Version",
    controlVersion: "Control Version",
  },
  controlPlane: META_CONTROL_PLANE_06,
};

export function metaSpecAdapter(specVersion: string, supportedSchemas: readonly string[], grammar: MetaAddressingGrammar): MetaSpecAdapter {
  return { kind: "META_RUNTIME", specVersion, supportedSchemas, grammar };
}

/** Built-in capability declarations. Adding a line here is how a newly frozen spec becomes supported. */
export function registerBuiltinMetaAdapters(registry: AdapterRegistry<MetaRuntimeAdapter>): void {
  registry.register("META_SPEC/0.6.0", metaSpecAdapter("META_SPEC/0.6.0", ["META_SCHEMA/0.2.0"], GRAMMAR_06));
}
