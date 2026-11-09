/**
 * SALES runtime adapters, keyed by the Sales runtime CONTRACT version pinned by the runtime's own
 * canonical Manifest. Like the META adapters these are CAPABILITY declarations: an unmatched
 * contract/schema HOLDs with HOLD_UNSUPPORTED_GOVERNING_VERSION instead of guessing.
 */
import type { AdapterRegistry, SalesRuntimeAdapter } from "../registry.ts";
import { SALES_CONTROL_PLANE_05, SALES_CONTROL_PLANE_052, SALES_CONTROL_PLANE_053, SALES_CONTROL_PLANE_054, SALES_CONTROL_PLANE_055, SALES_CONTROL_PLANE_056, SALES_CONTROL_PLANE_06, SALES_CONTROL_PLANE_0513_CANDIDATE, SALES_CONTROL_PLANE_0514_CANDIDATE, type ControlPlaneGrammar } from "./controlPlane.ts";

export interface SalesAddressingGrammar {
  /** Exact title of the BOOT child page under the runtime root. */
  readonly bootTitle: string;
  /** Exact title of the canonical Manifest database under BOOT. */
  readonly manifestDatabaseTitle: string;
  /** Title of the canonical Manifest row. Resolved from the exact canonical parent, never by global search. */
  readonly currentRowTitle: string;
  readonly manifestProps: {
    readonly title: string;
    readonly rootUrl: string;
    readonly instanceId: string;
    readonly owner: string;
    readonly gmailIdentity: string;
    readonly installState: string;
    readonly instanceStatus: string;
    readonly contractVersion: string;
    readonly contractUrl: string;
    readonly schemaVersion: string;
    readonly strategyVersion: string;
    readonly toolkitVersion: string;
    readonly authorityVersion: string;
    readonly lastRunRef: string;
  };
  /** Deterministic template / non-instance markers. */
  readonly template: {
    readonly instanceIdPattern: RegExp;
    readonly rootTitlePattern: RegExp;
    readonly unboundInstallState: string;
  };
  readonly retiredInstanceStatus: string;
  readonly controlPlane: ControlPlaneGrammar;
}

/**
 * What a contract line is able to operate, beyond addressing. A capability is declared by the adapter of the
 * GOVERNING contract, so a capability can never be switched on by a caller, a hint or a package flag: a runtime
 * gets GTM semantics only once its own Manifest pins a contract line whose adapter declares them.
 */
export interface SalesCapabilities {
  /** First-source identity enrollment: contract descriptor, never inferred from an app name. */
  readonly sourceIdentityEnrollment?: readonly {
    readonly capability: string; readonly source: string; readonly label: string;
    readonly identityKind: "email" | "opaque";
    readonly observationKey: string;
    readonly expectedObservationKey?: string;
    readonly resourceKey: string; readonly property: string;
  }[];
  /** GTM measurement/learning semantics: campaigns, approach versions, participations, enrollments, exposures. */
  readonly gtm: boolean;
  /** Operating modes enabled by this governing contract line even when the cursor declares no additional mode. */
  readonly defaultOperatingModes?: readonly string[];
  /** Deterministic capability requirements by operating mode. */
  readonly operatingModeRequirements?: Readonly<Record<string, readonly SalesCapabilityRequirement[]>>;
  /** The only logical resource allowed to remediate an incomplete capability profile. */
  readonly capabilityProofResource?: string;
  /** Contract-owned business continuation used only to replace a connector-remediation message after completion. */
  readonly postCapabilityResume?: Readonly<Record<string, { readonly nextAction: string; readonly nextQuestion: string }>>;
}

export type CapabilityState = "UNKNOWN" | "HUMAN_AUTH_PENDING" | "READ_VERIFIED" | "WRITE_VERIFIED" | "PARTIAL" | "ERROR" | "NOT_APPLICABLE";
export interface SalesCapabilityRequirement {
  readonly capability: string;
  readonly requirement: "REQUIRED" | "OPTIONAL";
  readonly acceptedStates: readonly CapabilityState[];
  readonly competentSource: string;
  /** Exact, seller-facing action; never contains an id, connector handle or admin relay. */
  readonly nextHumanAction: string;
}

export interface SalesContractAdapter extends SalesRuntimeAdapter {
  /** Read compatibility only; separate from native capabilities and never a write grant. */
  readonly legacyReadBridgeSchema?: string;
  readonly contractVersion: string;
  readonly supportedSchemas: readonly string[];
  readonly grammar: SalesAddressingGrammar;
  readonly capabilities: SalesCapabilities;
}

export const NO_CAPABILITIES: SalesCapabilities = { gtm: false };

/** Every ordinary 0.5 BUSINESS runtime needs a fresh, competent-source Gmail read proof before it can progress. */
export const SALES_OPERATIONS_REQUIREMENTS: readonly SalesCapabilityRequirement[] = [
  { capability: "GMAIL_READ", requirement: "REQUIRED", acceptedStates: ["READ_VERIFIED"], competentSource: "GMAIL", nextHumanAction: "Connectez la boîte Gmail qui appartient à votre espace Sales et autorisez la lecture, puis dites simplement « on continue »." },
] as const;

/** Calendar bridge: same 0.5.1 runtime, with Calendar read required immediately after Gmail read. */
export const SALES_OPERATIONS_052_REQUIREMENTS: readonly SalesCapabilityRequirement[] = [
  ...SALES_OPERATIONS_REQUIREMENTS,
  { capability: "CALENDAR_READ", requirement: "REQUIRED", acceptedStates: ["READ_VERIFIED"], competentSource: "GOOGLE_CALENDAR", nextHumanAction: "Connectez votre Google Calendar et autorisez uniquement la lecture des agendas utiles, puis dites simplement « on continue »." },
] as const;

export const GTM_OBSERVABILITY_REQUIREMENTS: readonly SalesCapabilityRequirement[] = [
  { capability: "NOTION_RUNTIME_READ", requirement: "REQUIRED", acceptedStates: ["READ_VERIFIED"], competentSource: "NOTION", nextHumanAction: "Ouvrez Notion pour ce workspace et autorisez la lecture de votre espace Sales, puis dites simplement « on continue »." },
  { capability: "GMAIL_READ", requirement: "REQUIRED", acceptedStates: ["READ_VERIFIED"], competentSource: "GMAIL", nextHumanAction: "Connectez la boîte Gmail qui appartient à votre espace Sales et autorisez la lecture, puis dites simplement « on continue »." },
  { capability: "CALENDAR_READ", requirement: "REQUIRED", acceptedStates: ["READ_VERIFIED"], competentSource: "GOOGLE_CALENDAR", nextHumanAction: "Connectez votre Google Calendar, autorisez la lecture des agendas utiles et confirmez votre fuseau horaire, puis dites simplement « on continue »." },
  { capability: "MAIL_TRACKER_READ", requirement: "OPTIONAL", acceptedStates: ["READ_VERIFIED"], competentSource: "MAIL_TRACKER", nextHumanAction: "Connectez votre outil de suivi d'e-mails si vous souhaitez inclure ses signaux ; cela ne bloque pas la reprise." },
] as const;

/** Addressing grammar of the 0.5 Sales runtime contract line. */
const GRAMMAR_05: SalesAddressingGrammar = {
  bootTitle: "00 — BOOT & INSTANCE",
  manifestDatabaseTitle: "Instance Manifest",
  currentRowTitle: "CURRENT",
  manifestProps: {
    title: "Name",
    rootUrl: "Root URL",
    instanceId: "Instance ID",
    owner: "Owner",
    gmailIdentity: "Gmail Identity",
    installState: "Install State",
    instanceStatus: "Instance Status",
    contractVersion: "Sales Contract Version",
    contractUrl: "Sales Contract URL",
    schemaVersion: "Schema Version",
    strategyVersion: "Strategy Version",
    toolkitVersion: "Toolkit Version",
    authorityVersion: "Authority Version",
    lastRunRef: "Last Run Ref",
  },
  template: { instanceIdPattern: /^TEMPLATE\b/i, rootTitlePattern: /\bTEMPLATE\b/i, unboundInstallState: "UNBOUND" },
  retiredInstanceStatus: "RETIRED",
  controlPlane: SALES_CONTROL_PLANE_05,
};

export function salesContractAdapter(contractVersion: string, supportedSchemas: readonly string[], grammar: SalesAddressingGrammar, capabilities: SalesCapabilities = NO_CAPABILITIES): SalesContractAdapter {
  return { kind: "SALES_RUNTIME", contractVersion, supportedSchemas, grammar, capabilities };
}

/** Addressing grammar of the CANDIDATE 0.6 Sales runtime contract line: 0.5 plus the GTM resource catalog. */
const GRAMMAR_06: SalesAddressingGrammar = { ...GRAMMAR_05, controlPlane: SALES_CONTROL_PLANE_06 };

/** Addressing grammar of the Calendar bridge: only connector requirements differ from 0.5.1. */
const GRAMMAR_052: SalesAddressingGrammar = { ...GRAMMAR_05, controlPlane: SALES_CONTROL_PLANE_052 };

const SALES_05_CAPABILITIES: SalesCapabilities = {
  gtm: false,
  defaultOperatingModes: ["SALES_OPERATIONS"],
  operatingModeRequirements: { SALES_OPERATIONS: SALES_OPERATIONS_REQUIREMENTS },
  capabilityProofResource: "SALES:CAPABILITY_PROOFS",
};

const SALES_052_CAPABILITIES: SalesCapabilities = {
  gtm: false,
  sourceIdentityEnrollment: [{ capability: "GMAIL_READ", source: "GMAIL", label: "Gmail",
    identityKind: "email", observationKey: "mailbox_identity", expectedObservationKey: "registry_expected_gmail_identity", resourceKey: "SALES:SOURCE_IDENTITY", property: "Gmail Identity" }],
  defaultOperatingModes: ["SALES_OPERATIONS"],
  operatingModeRequirements: { SALES_OPERATIONS: SALES_OPERATIONS_052_REQUIREMENTS },
  capabilityProofResource: "SALES:CAPABILITY_PROOFS",
  postCapabilityResume: {
    B0_DISCOVERY: {
      nextAction: "Cadrer le résultat commercial prioritaire avant de définir l'offre et l'ICP.",
      nextQuestion: "Quel résultat commercial concret veux-tu obtenir en priorité avec ton Sales OS ?",
    },
  },
};

/** Built-in capability declarations for the Sales runtime contract lines this backend understands. */
export function registerBuiltinSalesAdapters(registry: AdapterRegistry<SalesRuntimeAdapter>): void {
  registry.register("SALES_RUNTIME_CONTRACT/0.5.0", Object.assign(salesContractAdapter("SALES_RUNTIME_CONTRACT/0.5.0", ["SALES_SCHEMA/0.5.0"], GRAMMAR_05, SALES_05_CAPABILITIES), { legacyReadBridgeSchema: "SALES_SCHEMA/0.5.0" }));
  // Explicit installation candidate. Registration only declares how to operate a runtime whose own canonical
  // Manifest already pins this candidate; it does not adopt or promote the line for any 0.5.0 runtime.
  registry.register("SALES_RUNTIME_CONTRACT/0.5.1-candidate", salesContractAdapter("SALES_RUNTIME_CONTRACT/0.5.1-candidate", ["SALES_SCHEMA/0.5.1-candidate"], GRAMMAR_05, SALES_05_CAPABILITIES));
  // Calendar bridge candidate: the same 0.5.1 schema/physical grammar, with read-only Calendar completeness.
  registry.register("SALES_RUNTIME_CONTRACT/0.5.2-candidate", salesContractAdapter("SALES_RUNTIME_CONTRACT/0.5.2-candidate", ["SALES_SCHEMA/0.5.1-candidate"], GRAMMAR_052, SALES_052_CAPABILITIES));
  // SALES V1 candidate: the 0.5.1 runtime structure plus MIG-SALES-052-001, which adds the `Action Key`
  // idempotency property to the authorized objective package's Outreach Pipeline. That migration IS the
  // difference between the two schema lines, so this adapter accepts only the schema that carries it: a runtime
  // pinning this contract over the older schema HOLDs instead of transacting against an unkeyed pipeline.
  registry.register("SALES_RUNTIME_CONTRACT/0.5.3-candidate", salesContractAdapter("SALES_RUNTIME_CONTRACT/0.5.3-candidate", ["SALES_SCHEMA/0.5.2-candidate"], { ...GRAMMAR_052, controlPlane: SALES_CONTROL_PLANE_053 }, SALES_052_CAPABILITIES));
  // Same-turn input capture: a behavioural amendment to the V1 line. Same schema, same connector requirements;
  // what it adds over 0.5.3 is the durable cursor as a backend-derived resource and the one transition the
  // contract authorizes. Those live on this line alone, so re-pinning 0.5.3 is a real rollback and not a rename.
  // Registering the line only makes a runtime whose own Manifest pins it operable; it adopts nothing.
  registry.register("SALES_RUNTIME_CONTRACT/0.5.4-candidate", salesContractAdapter("SALES_RUNTIME_CONTRACT/0.5.4-candidate", ["SALES_SCHEMA/0.5.2-candidate"], { ...GRAMMAR_052, controlPlane: SALES_CONTROL_PLANE_054 }, SALES_052_CAPABILITIES));
  // The OFFER step (PV-B1-001/PV-B1-002): the capture line plus the one transition that leaves B1_OFFER. Same
  // schema, same resources, same connector requirements — specifying a step costs a catalog entry, not a
  // migration. Registering it makes a runtime that pins it operable and adopts it for no one else; re-pinning
  // 0.5.4 removes the step and returns that runtime to holding at B1_OFFER.
  registry.register("SALES_RUNTIME_CONTRACT/0.5.5-candidate", salesContractAdapter("SALES_RUNTIME_CONTRACT/0.5.5-candidate", ["SALES_SCHEMA/0.5.2-candidate"], { ...GRAMMAR_052, controlPlane: SALES_CONTROL_PLANE_055 }, SALES_052_CAPABILITIES));
  registry.register("SALES_RUNTIME_CONTRACT/0.5.6-candidate", salesContractAdapter("SALES_RUNTIME_CONTRACT/0.5.6-candidate", ["SALES_SCHEMA/0.5.2-candidate"], { ...GRAMMAR_052, controlPlane: SALES_CONTROL_PLANE_056 }, SALES_052_CAPABILITIES));
  // CANDIDATE capability declaration (PV-GTM-002). Registering a line does not adopt it: it dispatches only for a
  // runtime whose own canonical Manifest pins it as GOVERNING. Until Notion adopts it, no runtime reaches it.
  registry.register("SALES_RUNTIME_CONTRACT/0.6.0", salesContractAdapter("SALES_RUNTIME_CONTRACT/0.6.0", ["SALES_SCHEMA/0.6.0"], GRAMMAR_06, {
    gtm: true,
    defaultOperatingModes: ["GTM_OBSERVABILITY"],
    operatingModeRequirements: { GTM_OBSERVABILITY: GTM_OBSERVABILITY_REQUIREMENTS },
    capabilityProofResource: "SALES:CAPABILITY_PROOFS",
  }));
  // Append the new line: existing discovery order and rollback targets remain unchanged.
  registry.register("SALES_RUNTIME_CONTRACT/0.5.13-candidate", salesContractAdapter("SALES_RUNTIME_CONTRACT/0.5.13-candidate", ["SALES_SCHEMA/0.5.8-candidate"], { ...GRAMMAR_052, controlPlane: SALES_CONTROL_PLANE_0513_CANDIDATE }, SALES_052_CAPABILITIES));
  registry.register("SALES_RUNTIME_CONTRACT/0.5.14-candidate", salesContractAdapter("SALES_RUNTIME_CONTRACT/0.5.14-candidate", ["SALES_SCHEMA/0.5.8-candidate"], { ...GRAMMAR_052, controlPlane: SALES_CONTROL_PLANE_0514_CANDIDATE }, SALES_052_CAPABILITIES));
}

/** The registered contract lines that declare GTM capability. Callers discover them; they never spell a version. */
export const gtmCapableVersions = (registry: AdapterRegistry<SalesRuntimeAdapter>): readonly string[] =>
  registry.supported().filter((v) => (registry.resolve(v) as SalesContractAdapter | undefined)?.capabilities?.gtm === true);
