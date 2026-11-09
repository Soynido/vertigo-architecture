import type { Epistemic, Lane } from "../tools/envelope.ts";
import type { ClassifiedVersion, VersionClassification } from "../versions/registry.ts";

/** Version pins observed on a durable record (Manifest or Run). Reported as-is, never rewritten. */
export interface ObservedPins {
  readonly ref: string;
  readonly spec: string | Epistemic;
  readonly schema: string | Epistemic;
  readonly control: string | Epistemic;
  readonly status?: string | Epistemic;
}

/** A resolved physical runtime. Every field is discovered at call time; none is configured. */
export interface ResolvedRuntime {
  /** Backend-selected migration restriction, independent of addressing. */
  readonly operation_policy?: "LEGACY_READ_ONLY";
  /** Explicit authority surface selected by the resolver. Never inferred later from free-form observations. */
  readonly access_mode: "BUSINESS" | "INSTALL_ONLY";
  readonly lane: Lane;
  readonly logical_key: string;
  readonly runtime_id: string;
  readonly root_ref: string;
  readonly manifest_ref: string;
  readonly locator_ref: string;
  readonly pointer_generation: string | Epistemic;
  readonly runtime_generation: string;
  readonly lifecycle_state: string | Epistemic;
  readonly owner_display: string | Epistemic;
  readonly versions: VersionClassification;
  readonly manifest_pins: ObservedPins;
  readonly historical_pins: readonly ObservedPins[];
  readonly adopted_records: readonly ClassifiedVersion[];
  readonly observations: Readonly<Record<string, unknown>>;
  readonly warnings: readonly string[];
  /** Canonical Manifest pointer whose page metadata and governing pin were freshly validated; never a tool input. */
  readonly governing_contract_ref?: { readonly page_ref: string; readonly version: string };
  /** Version-specific addressing used to resolve this runtime; the resume engine reuses it for the control plane. */
  readonly adapter: {
    /** Available only for the explicitly restricted legacy read bridge. */
    readonly legacy_read_bridge_schema?: string;
    readonly version: string;
    readonly controlPlane: import("../versions/adapters/controlPlane.ts").ControlPlaneGrammar;
    /** Capabilities DECLARED BY THE GOVERNING adapter. Absent ⇒ none; a caller can never add one. */
    readonly capabilities?: import("../versions/adapters/sales.ts").SalesCapabilities;
  };
  /** Registry snapshot (SALES discovery cache), if any. Never authority. */
  readonly registry_snapshot?: Readonly<Record<string, string | undefined>>;
}

export type ResolutionHoldCode =
  | "HOLD_RUNTIME_NOT_FOUND"
  | "HOLD_RUNTIME_NOT_YET_CREATED"
  | "HOLD_RUNTIME_AMBIGUOUS"
  | "HOLD_BOOTSTRAP_DISCOVERY"
  | "HOLD_RUNTIME_MANIFEST_MISMATCH"
  | "HOLD_RUNTIME_TEMPLATE_NOT_INSTANCE"
  | "HOLD_VERSION_RESOLUTION"
  | "HOLD_UNSUPPORTED_GOVERNING_VERSION"
  | "HOLD_UNKNOWN_REQUIRED_FACT";

export type ResolutionOutcome =
  | { readonly kind: "RESOLVED"; readonly runtime: ResolvedRuntime }
  | { readonly kind: "HOLD"; readonly code: ResolutionHoldCode; readonly evidence: readonly string[] };

export interface RuntimeResolver {
  /** Re-resolves enough identity on every stateful call to detect rotation. */
  resolve(): Promise<ResolutionOutcome>;
}
