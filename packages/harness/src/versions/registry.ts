/**
 * Version resolution (07 — VERSION RESOLUTION & CONTROL).
 * Every discovered version is classified; only GOVERNING controls new work. Adapters are keyed by the
 * governing version string discovered at call time — no version is hardcoded as "current".
 */
export type VersionClass = "GOVERNING" | "CHANGE_CANDIDATE" | "HISTORICAL_PIN";

export interface ClassifiedVersion {
  readonly value: string;
  readonly klass: VersionClass;
  readonly evidence_ref: string;
}

export interface VersionClassification {
  readonly governing_spec: ClassifiedVersion | "UNKNOWN";
  readonly governing_schema: ClassifiedVersion | "UNKNOWN";
  readonly governing_control: ClassifiedVersion | "UNKNOWN";
  readonly candidates: readonly ClassifiedVersion[];
  readonly historical_pins: readonly ClassifiedVersion[];
}

export interface AdapterRegistry<TAdapter> {
  register(version: string, adapter: TAdapter): void;
  /** Returns undefined when the governing version has no adapter ⇒ caller must HOLD_UNSUPPORTED_*. */
  resolve(version: string): TAdapter | undefined;
  supported(): readonly string[];
}

export class MapAdapterRegistry<TAdapter> implements AdapterRegistry<TAdapter> {
  readonly #adapters = new Map<string, TAdapter>();
  register(version: string, adapter: TAdapter): void {
    if (this.#adapters.has(version)) throw new Error(`adapter already registered for ${version}`);
    this.#adapters.set(version, adapter);
  }
  resolve(version: string): TAdapter | undefined {
    return this.#adapters.get(version);
  }
  supported(): readonly string[] {
    return [...this.#adapters.keys()];
  }
}

/** Adapter markers. META runtime adapters carry their addressing grammar (see adapters/meta.ts). */
export interface MetaRuntimeAdapter { readonly kind: "META_RUNTIME" }
export interface SalesRuntimeAdapter { readonly kind: "SALES_RUNTIME" }
export interface ControlAdapter { readonly kind: "CONTROL" }

export interface AdapterRegistries {
  readonly metaRuntime: AdapterRegistry<MetaRuntimeAdapter>;
  readonly salesRuntime: AdapterRegistry<SalesRuntimeAdapter>;
  readonly control: AdapterRegistry<ControlAdapter>;
}

export function createAdapterRegistries(): AdapterRegistries {
  return {
    metaRuntime: new MapAdapterRegistry<MetaRuntimeAdapter>(),
    salesRuntime: new MapAdapterRegistry<SalesRuntimeAdapter>(),
    control: new MapAdapterRegistry<ControlAdapter>(),
  };
}

/** A page/record marked with any of these markers is never governing. */
const NON_GOVERNING_MARKERS = ["NON-NORMATIVE", "CHANGE CANDIDATE", "DRAFT", "PROPOSED"] as const;

export function isNonGoverningMarker(text: string): boolean {
  const upper = text.toUpperCase();
  return NON_GOVERNING_MARKERS.some((m) => upper.includes(m));
}
