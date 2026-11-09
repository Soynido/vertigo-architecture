/**
 * Control-plane addressing grammar shared by the META and SALES runtime adapters (PV0-007).
 * Names the databases and properties os_resume reads. Version-specific values live in the adapter
 * registrations; this file only defines the shape and the two current grammars used by them.
 */
export interface RunProps {
  readonly title: string;
  readonly runId: string;
  readonly status: string;
  readonly recoveryRequired: string;
  readonly nextAction: string;
  readonly holds: string;
  readonly lastRequiredWrittenAt: string;
  readonly mutationCount: string;
  readonly verifiedMutationCount: string;
  readonly attemptCount: string;
  readonly specVersion: string;
  readonly schemaVersion: string;
  readonly controlVersion?: string;
  readonly gateBefore: string;
  readonly gateAfterExpected: string;
  readonly gateAfterObserved: string;
  readonly origin: string;
}

export interface LedgerProps {
  readonly title: string;
  readonly mutationId: string;
  readonly status: string;
  readonly runRef: string;
}

export interface GateProps {
  readonly title: string;
  readonly gateKey: string;
  readonly status: string;
  readonly openBlocker: string;
  readonly nextAction: string;
  readonly nextQuestion: string;
  readonly lastRequiredWrittenAt: string;
  readonly controlConfirmationState: string;
  readonly passedByRunRef: string;
  readonly confirmedByControlCheckRef?: string;
}

/** Control Check mirror rows (00G): pointer/summary of a canonical verifier artifact. */
export interface ControlCheckProps {
  readonly title: string;
  readonly checkId: string;
  readonly controlVersion: string;
  readonly checkedAt: string;
  readonly result: string;
  readonly scope: string;
  readonly artifactHash?: string;
  readonly mirrorIntegrity?: string;
}

/** Durable cursor properties (META Manifest; SALES OS State). Missing names are read as UNKNOWN. */
export interface CursorProps {
  readonly runtimeState?: string;
  readonly health?: string;
  readonly persistenceHealth?: string;
  readonly recoveryRequired?: string;
  readonly currentGate?: string;
  readonly currentGateStatus?: string;
  readonly currentSetupGate?: string;
  readonly currentSetupGateStatus?: string;
  readonly openBlocker?: string;
  readonly nextAction?: string;
  readonly nextQuestion?: string;
  readonly lastRunRef?: string;
  readonly lastVerifiedMutation?: string;
  readonly lastRequiredWrittenAt?: string;
  readonly lastVerifiedAt?: string;
  /** Explicit operating mode(s) enabled for this runtime. Multiple values use a comma or pipe separator. */
  readonly operatingModes?: string;
}

/** Append-only competent-source evidence used to derive runtime capability completeness. */
export interface CapabilityProofProps {
  readonly title: string;
  readonly proofKey: string;
  readonly capabilityKey: string;
  readonly state: string;
  readonly runtimeId: string;
  readonly principalKey: string;
  readonly operatingMode: string;
  readonly competentSource: string;
  readonly evidenceRef: string;
  readonly verifiedAt: string;
  readonly scope: string;
}

export interface ExternalActionProps {
  readonly recordType: string;
  readonly effectStatus: string;
  readonly approvalState: string;
  readonly actionKey: string;
  /** Routing metadata of an intent (read-only exposure; absent properties read as UNKNOWN). */
  readonly actionType?: string;
  readonly recipient?: string;
  readonly subject?: string;
  readonly threadRef?: string;
  readonly effectRef?: string;
  readonly preparedAt?: string;
  /**
   * Explicit Sales references read for the EXTERNAL_ACTION context (W2.4, Sales 0.5.10 candidate): the account and
   * contact page UUIDs as text, and the singular relation to the linked Authority Matrix rule. Read names only: none
   * of them is writable through os_prepare/os_commit here.
   */
  readonly accountRef?: string;
  readonly contactRef?: string;
  readonly authorityRef?: string;
}

/** A logical resource the plugin may target through os_prepare. Physical objects are discovered by exact title inside the bound runtime. */
export interface ResourceSpec {
  /**
   * Where the physical database is discovered. `RUNTIME` (the default) means inside the bound runtime root.
   * `OBJECTIVE_PACKAGE` means inside the one authorized commercial objective package named by this runtime's
   * backend pointer. That pointer is backend-derived: no tool argument, no Notion property the seller can edit
   * and no chat phrase can set it, so a binding only ever reaches the package its own principal was assigned.
   */
  readonly scope?: "RUNTIME" | "OBJECTIVE_PACKAGE";
  /**
   * PV-FW-001: rows of this resource that the harness has proved are re-read at every resume and prepare, and a
   * change made outside any transaction holds the runtime (HOLD_FOREIGN_WRITE). Opt-in, never global: a
   * resource the seller edits natively by design, an externally effective one, or one living in the shared
   * objective package must not carry it.
   */
  readonly foreignWriteGuard?: boolean;
  /** Child page under the scope root that holds the database; undefined ⇒ the database sits directly under the root. */
  readonly parentTitle?: string;
  /** Exact database title. */
  readonly databaseTitle: string;
  /** Property used by record_selector.natural_key. */
  readonly naturalKeyProperty: string;
  /** Optional shape constraint for caller-supplied natural keys. Exact duplicate detection remains mandatory. */
  readonly naturalKeyKind?: "OPAQUE" | "EMAIL" | "HTTP_URL";
  /**
   * The natural key is the row's ONLY identity. Set it when the governing contract says a row that does not
   * carry the key is not addressable at all — a legacy row awaiting reconciliation — and that identity may
   * never be inferred from a title. A title is not unique and a row found by title may carry a different key or
   * none, which silently breaks idempotency: a later retry of the real key would then create a second row.
   */
  readonly naturalKeyIsIdentity?: boolean;
  readonly operations: readonly ("CREATE" | "UPDATE" | "UPSERT")[];
  /** Resource exists only to bootstrap a registry-assigned UNBOUND clone. Normal bindings can never address it. */
  readonly bootstrapOnly?: boolean;
  /**
   * Every value on this resource is derived by the backend from durable state and contract constants. A caller
   * intent naming it is refused before any plan, Run or lease exists — the same rule the capability proof
   * journal already relies on, so that a gate can never be declared by whoever is holding the conversation.
   */
  readonly backendDerivedOnly?: boolean;
  /** Optional positive field allowlist. When present, every desired field must be listed here. */
  readonly writableProperties?: readonly string[];
  /** Properties the plugin may never set through desired_changes (control-owned). */
  readonly protectedProperties?: readonly string[];
  /**
   * Writable properties the governing contract deliberately keeps OUT of the compared field-set: provenance a
   * row carries but that no transaction proves. They are still written verbatim. Use this only where the
   * contract fixes an exact compared set — never to shrink the proof of a business value — and note that a
   * Notion date can only be honestly excluded this way, since Notion stores dates to the minute and would
   * otherwise hold a correct write on its own rounding.
   */
  readonly uncomparedProperties?: readonly string[];
  /** Values the backend injects on CREATE (compared like any planned field); never caller-supplied. */
  readonly createDefaults?: Readonly<Record<string, unknown>>;
  /** The resource records an intent whose effect happens OUTSIDE Notion (e.g. an email). A verified record exposes routing metadata only; nothing in the harness executes it. */
  readonly externalEffect?: boolean;
  /** Rows carry business values (an offer, a price, a contact). Their values never reach an event, an evidence
   *  line (HOLD evidence included), a log or telemetry: comparisons are reported by redacted token. D7 is the one
   *  read exception: the bounded candidate `selected_context` may project them, only to the bound principal and
   *  only for a need the candidate catalogue selects. This flag is not a licence to widen that projection. */
  readonly redactValues?: boolean;
}

/** Contract-owned structure of an unbound Personal SALES clone. Copied Registry rows are never authority for it. */
export interface InstallPhysicalResource {
  readonly key: string;
  readonly objectType: "PAGE" | "DATABASE";
  /** Exact child titles from the assigned root. Empty means the root page itself. */
  readonly path: readonly string[];
  readonly required: boolean;
  /** Registry row to rebind. Omitted for physical resources that are validated but not registered. */
  readonly registryKey?: string;
  /** Minimum schema fixed by the governing contract. Every database must also have exactly one title property. */
  readonly requiredProperties?: Readonly<Record<string, string>>;
  /** Select/status options the runtime must already expose before it can be activated. */
  readonly requiredSelectOptions?: Readonly<Record<string, readonly string[]>>;
}

export interface InstallContract {
  readonly physicalResources: readonly InstallPhysicalResource[];
  readonly connectorCapabilities: readonly { readonly key: string; readonly requirement: "REQUIRED" | "OPTIONAL"; readonly competentSource: string }[];
}

/** Extra property names used when rendering control-plane writes. Absent live properties are omitted with a warning. */
export interface WriteProps {
  readonly runHarnessPlanId?: string;
  readonly runOriginValue: string;
  readonly ledgerTargetRef?: string;
  readonly ledgerHarnessPlanId?: string;
  readonly ledgerIdempotencyKey?: string;
  readonly ledgerTargetReceiptId?: string;
  readonly ledgerOperation?: string;
}

/** What the governing contract permits during recovery of an interrupted mutation. */
export interface RecoveryPolicy {
  /** A target still at its recorded BEFORE state may be re-written with the planned expected values (idempotent replay). */
  readonly replayFromBeforeState: boolean;
}

/**
 * A cursor movement the backend DERIVES: it fires only when a verified business row already satisfies the
 * contract's completion predicate, and every field it writes is either fixed by the contract or carried from
 * the durable cursor. It is applied as its own `os_prepare → TARGET → FINAL`, never as a side effect of another
 * transaction, so the move is proved by readback like any other durable change.
 */
export interface DerivedCursorTransition {
  readonly key: string;
  /** Fires only while the durable cursor sits exactly on this gate. */
  readonly fromGate: string;
  /** The verified row that completes the gate: exact values, plus properties that must simply be non-empty. */
  readonly evidence: {
    /** Absent is the historical single-row kind. Unknown kinds are never interpreted as single-row. */
    readonly kind?: "SINGLE_ROW" | "B7_GRAPH";
    readonly logicalResourceKey: string;
    readonly naturalKey: string;
    readonly equals: Readonly<Record<string, string>>;
    readonly nonEmpty: readonly string[];
  };
  /** Cursor resource to update, addressed by this natural key. */
  readonly targetResourceKey: string;
  readonly targetNaturalKey: string;
  /** Values the contract fixes literally. */
  readonly set: Readonly<Record<string, string | boolean>>;
  /** Target property → cursor property whose durable value is carried forward unchanged. */
  readonly carryForward: Readonly<Record<string, string>>;
  /**
   * Properties set to THIS transition's own Run, as the `$created:OPEN_RUN` reference the writer resolves. The
   * cursor's stable durable identity: unlike a conversation turn it exists, is durable and is provable.
   */
  readonly runReferenceProperties: readonly string[];
  /** Properties set to the writer's commit timestamp; excluded from the comparison by the resource spec. */
  readonly stampedProperties: readonly string[];
  /** Cleared only when durable state reports no other verified blocker. */
  readonly clearWhenUnblocked: readonly string[];
}

/**
 * The ordered durable steps a contract line governs, ending at the step that ends the walk (PV-GATE-000).
 *
 * Declaring the walk is what lets the backend tell an UNFINISHED PRODUCT from a FINISHED SPACE. Without it, a
 * cursor sitting on a step the catalog does not address is indistinguishable from a space with nothing left to
 * do: the backend derives nothing and says nothing, and the conversation is free to read that silence as
 * permission to supply a decision of its own. With it, a governed step that publishes no completion predicate
 * and no cursor transition is `UNSPECIFIED_STOP_SHIP`, and asking to advance it holds truthfully.
 *
 * It is a declaration, never a source of movement: no gate is ever derived FROM this list. Adding a step here
 * can only make the backend refuse more, never write more.
 */
export interface GateSequence {
  /** Every non-terminal step of the walk, in published order. A cursor on a step absent from it is a divergence. */
  readonly gates: readonly string[];
  /** The step that ends the walk. Reaching it derives no move and holds nothing: there is simply nothing after it. */
  readonly terminal: string;
}

/**
 * Where a Sales runtime keeps its Production Guard sources (Sales 0.5.11 candidate, W3.1R/W3.1S — NOT ADOPTED).
 * A line that declares it has every new server write checked by the guard preflight; a Sales line without it
 * cannot prove its guard, so os_commit holds on it. Nothing here names a rule, threshold, prospect or Task Type:
 * those live in the runtime's own approved index.
 */
export interface ProductionGuardSpec {
  /** The index grammar this line reads (`schema_version` of the JSON block). */
  readonly schemaVersion: string;
  /** The page under the runtime root whose single child page holds the index. */
  readonly indexParentTitle: string;
  readonly decisionRules: { readonly parentTitle: string; readonly databaseTitle: string };
  readonly runtimeConfiguration: { readonly parentTitle: string; readonly databaseTitle: string };
  /** The only resource a typed Runtime Configuration pointer may name, its key property and its compared field (W2.3). */
  readonly pointer: { readonly resourceKey: string; readonly naturalKeyProperty: string; readonly valueField: string };
  /** Resources a predicate `ref` may read with CONTRACT_STATIC authority (read allowlist). */
  readonly staticSources: readonly string[];
}

export interface ControlPlaneGrammar {
  /** Passive META source mapping only; never a writable resource or adopted execution context. */
  readonly metaOperatingContext?: {
    readonly companyFrameTitle: string;
    readonly privatePackageTitlePattern: string;
  };
  /** Dedicated INSTALL_ONLY structure contract. Absent means this contract line cannot provision clones. */
  readonly installContract?: InstallContract;
  readonly recoveryPolicy?: RecoveryPolicy;
  /** Mutable logical resources addressable by os_prepare (lane-namespaced keys). Control-plane records are never listed here. */
  readonly resources?: Readonly<Record<string, ResourceSpec>>;
  /** Candidate opt-in: non-setup keys on this resource do not answer or consume a pending step. */
  readonly independentConfigurationResourceKey?: string;
  /** Candidate local-answer provenance only; never a publication or permission attestation. */
  readonly localAnswerSources?: readonly string[];
  /** Cursor movements this contract authorizes the backend to derive from verified durable evidence. */
  readonly cursorTransitions?: readonly DerivedCursorTransition[];
  /** The durable steps this contract governs (PV-GATE-000). Absent ⇒ the line governs no walk and fails closed on nothing. */
  readonly gateSequence?: GateSequence;
  readonly writeProps?: WriteProps;
  /** Child page under the runtime root that holds the control-plane databases; undefined ⇒ databases sit directly under the root. */
  readonly parentTitle?: string;
  readonly runsDatabaseTitle: string;
  readonly ledgerDatabaseTitle: string;
  readonly gatesDatabaseTitle?: string;
  /** META Resource Registry (read-only): where derived/cache resources such as META_SALES_RUNTIME_INPUTS are registered. */
  readonly resourceRegistryDatabaseTitle?: string;
  readonly resourceRegistryProps?: { readonly resourceKey: string; readonly resourceUrl: string; readonly status: string; readonly scope?: string; readonly schemaVersion?: string; readonly lastVerified?: string; readonly notes?: string };
  /** Resource Key of the Private META derived resource holding source-confirmed Sales inputs. */
  readonly derivedInputsResourceKey?: string;
  /**
   * Resource Key of the registered GTM measurement resource (candidate). Reading it is what makes a runtime
   * GTM-capable on the META side: no registered row ⇒ no GTM need is offered and the pack is unchanged.
   */
  readonly gtmMetricsResourceKey?: string;
  readonly controlChecksDatabaseTitle?: string;
  readonly controlCheckProps?: ControlCheckProps;
  readonly stateDatabaseTitle?: string;
  readonly stateRowTitle?: string;
  readonly externalActionsDatabaseTitle?: string;
  /** SALES capability proof journal. Rows are append-only and scoped to the bound runtime/principal. */
  readonly capabilityProofsDatabaseTitle?: string;
  readonly capabilityProofProps?: CapabilityProofProps;
  readonly runProps: RunProps;
  readonly ledgerProps: LedgerProps;
  readonly gateProps?: GateProps;
  readonly manifestCursor: CursorProps;
  readonly stateCursor?: CursorProps;
  readonly externalActionProps?: ExternalActionProps;
  readonly incompleteRunStatuses: readonly string[];
  readonly nonVerifiedLedgerStatuses: readonly string[];
  readonly unresolvedEffectStatuses: readonly string[];
  readonly intentRecordType: string;
  /** Sales Production Guard sources (0.5.11 candidate). Absent ⇒ this line declares no guard. */
  readonly productionGuard?: ProductionGuardSpec;
}

export const META_CONTROL_PLANE_06: ControlPlaneGrammar = {
  metaOperatingContext: { companyFrameTitle: "01 — COMPANY FRAME & GOVERNANCE",
    privatePackageTitlePattern: "^VERTIGO_GTM_[A-Z0-9_/.-]+ — BUSINESS PACKAGE — NOT PUBLISHED$" },
  recoveryPolicy: { replayFromBeforeState: true },
  resources: {
    "META:GATES": { databaseTitle: "META — GATES", naturalKeyProperty: "Gate Key", operations: ["UPDATE"], protectedProperties: ["Gate Key", "Status", "Passed By Run Ref", "Control Confirmation State"] },
    // Canonical durable representation of a submitted setup answer (PT-PRO-001 fixture contract v2, PV0-020D). Allowlisted
    // resource name inside the META lane (PDEC-011): it resolves only where the bound runtime physically registers a
    // "META — INPUTS" database; elsewhere the harness HOLDs (HOLD_REQUIRED_RESOURCE_MISSING) and never improvises a target.
    "META:INPUTS": { databaseTitle: "META — INPUTS", naturalKeyProperty: "Input Key", operations: ["CREATE", "UPDATE", "UPSERT"], protectedProperties: ["Input Key", "Source"], createDefaults: { State: "SUBMITTED", Source: "USER_CONFIRMED_FIXTURE" } },
  },
  writeProps: { runHarnessPlanId: "Harness Plan ID", runOriginValue: "PLUGIN", ledgerTargetRef: "Target Ref", ledgerHarnessPlanId: "Harness Plan ID", ledgerIdempotencyKey: "Idempotency Key", ledgerTargetReceiptId: "Target Receipt ID", ledgerOperation: "Operation" },
  runsDatabaseTitle: "META — RUNS",
  ledgerDatabaseTitle: "META — MUTATION LEDGER",
  gatesDatabaseTitle: "META — GATES",
  resourceRegistryDatabaseTitle: "META — RESOURCE REGISTRY",
  resourceRegistryProps: { resourceKey: "Resource Key", resourceUrl: "Resource URL", status: "Status", scope: "Scope", schemaVersion: "Schema Version", lastVerified: "Last Verified", notes: "Notes" },
  derivedInputsResourceKey: "META_SALES_RUNTIME_INPUTS",
  gtmMetricsResourceKey: "META_GTM_METRICS",
  controlChecksDatabaseTitle: "META — CONTROL CHECKS",
  controlCheckProps: { title: "Control Check", checkId: "Control Check ID", controlVersion: "Control Version", checkedAt: "Checked At", result: "Result", scope: "Scope", artifactHash: "Canonical Artifact Hash", mirrorIntegrity: "Mirror Integrity Status" },
  runProps: { title: "Run", runId: "Run ID", status: "Status", recoveryRequired: "Recovery Required", nextAction: "Next Action", holds: "Holds", lastRequiredWrittenAt: "Last Required Written At", mutationCount: "Mutation Count", verifiedMutationCount: "Verified Mutation Count", attemptCount: "Attempt Count", specVersion: "Spec Version", schemaVersion: "META Schema Version", controlVersion: "Control Version", gateBefore: "Gate Before", gateAfterExpected: "Gate After Expected", gateAfterObserved: "Gate After Observed", origin: "Origin" },
  ledgerProps: { title: "Mutation", mutationId: "Mutation ID", status: "Status", runRef: "Run Ref" },
  gateProps: { title: "Gate", gateKey: "Gate Key", status: "Status", openBlocker: "Open Blocker", nextAction: "Next Action", nextQuestion: "Next Question", lastRequiredWrittenAt: "Last Required Written At", controlConfirmationState: "Control Confirmation State", passedByRunRef: "Passed By Run Ref", confirmedByControlCheckRef: "Confirmed By Control Check Ref" },
  manifestCursor: { runtimeState: "Runtime State", health: "Health", persistenceHealth: "Persistence Health", recoveryRequired: "Recovery Required", currentGate: "Current Gate", currentSetupGate: "Current Setup Gate", currentSetupGateStatus: "Current Setup Gate Status", openBlocker: "Open Blocker", nextAction: "Next Action", lastRunRef: "Last Run Ref", lastVerifiedMutation: "Last Verified Mutation", lastRequiredWrittenAt: "Last Required Written At", lastVerifiedAt: "Last Verified At" },
  incompleteRunStatuses: ["RUNNING", "HOLD", "HOLD_PARTIAL_COMMIT", "FAILED"],
  nonVerifiedLedgerStatuses: ["PREPARED", "WRITTEN", "FAILED"],
  unresolvedEffectStatuses: [],
  intentRecordType: "INTENT",
};

/*
 * Physical SALES schema contracts. These are deliberately derived from the fields the BUSINESS engine actually
 * reads, filters and writes (resume/readers, plans/writes, verify/target+final and gtm/intents). Keeping the matrix
 * here makes INSTALL the last place a structurally incomplete clone can be promoted to KNOWN.
 */
const INSTANCE_MANIFEST_PROPERTIES = {
  Name: "title", "Root URL": "url", "Instance ID": "rich_text", Owner: "rich_text", "Gmail Identity": "email",
  "Install State": "select", "Instance Status": "select", "Sales Contract Version": "rich_text", "Sales Contract URL": "url",
  "Schema Version": "rich_text", "Strategy Version": "rich_text", "Toolkit Version": "rich_text", "Authority Version": "rich_text",
  "Health Status": "select", "Persistence Health": "select", "Current Gate": "select", "Current Gate Status": "select",
  "Last Run Ref": "rich_text", "Last Verified Mutation": "rich_text", "Last Required Written At": "date", "Last Verified At": "date",
  "Read Scope": "rich_text", "Write Scope": "rich_text", "Gmail Verified": "checkbox", "Tracker Access": "select",
  "Capability Status": "select", "Recovery Required": "checkbox",
} as const;
const INSTANCE_MANIFEST_OPTIONS = {
  "Install State": ["UNBOUND", "SETUP", "READY", "HOLD"],
  "Instance Status": ["ACTIVE", "PAUSED", "RETIRED"],
  "Health Status": ["UNKNOWN", "HEALTHY", "DEGRADED", "HOLD"],
  // The 0.5 Notion source uses an outcome vocabulary here (PASS or an explicit HOLD reason), not the
  // generic health vocabulary used by Health Status. Keep the install contract aligned with that source so
  // bootstrap validates the real schema instead of requiring invented select options.
  "Persistence Health": ["UNKNOWN", "PASS", "HOLD_NOTION_WRITE", "HOLD_PARTIAL_COMMIT", "HOLD_REBIND_REQUIRED", "HOLD_CONTROL_CONFIRMATION"],
  "Tracker Access": ["NONE", "UNKNOWN", "ACCESSIBLE", "PARTIAL", "INACCESSIBLE"],
  "Capability Status": ["UNKNOWN", "PARTIAL", "PASS", "FAIL"],
} as const;
const REGISTRY_PROPERTIES = { Key: "title", Required: "checkbox", "Resource URL": "url", "Resource Type": "select", Status: "select", Scope: "select", Notes: "rich_text" } as const;
const REGISTRY_OPTIONS = {
  "Resource Type": ["PAGE", "DATABASE"],
  Status: ["MISSING", "EXPECTED", "RESOLVED", "HOLD"],
  Scope: ["READ_ONLY", "READ_WRITE", "WRITE_ONLY", "EXTERNAL"],
} as const;
const OS_STATE_PROPERTIES = {
  Name: "title", "Build State": "select", "Current Gate": "select", "Current Gate Status": "select", "Persistence Health": "select",
  "Recovery Required": "checkbox", "Open Blocker": "rich_text", "Next Action": "rich_text", "Next Question": "rich_text",
  "Last Run Ref": "rich_text", "Last Verified Mutation": "rich_text", "Last Required Written At": "date", "Last Verified At": "date",
} as const;
const OS_STATE_OPTIONS = {
  "Build State": ["B0_DISCOVERY", "B1_OFFER", "B2_ICP", "B3_DATA", "B4_QUALIFICATION", "B5_OUTREACH", "B6_AUTHORITY", "B7_DRY_RUN", "READY", "HOLD"],
  "Current Gate": ["B0_DISCOVERY", "B1_OFFER", "B2_ICP", "B3_DATA", "B4_QUALIFICATION", "B5_OUTREACH", "B6_AUTHORITY", "B7_DRY_RUN", "READY", "HOLD"],
  "Current Gate Status": ["OPEN", "PASS", "HOLD", "FAIL"],
  "Persistence Health": ["UNKNOWN", "PASS", "HOLD_NOTION_WRITE", "HOLD_PARTIAL_COMMIT", "HOLD_REBIND_REQUIRED", "HOLD_CONTROL_CONFIRMATION"],
} as const;
const RUNS_PROPERTIES = {
  Run: "title", "Run ID": "unique_id", Status: "select", "Run Type": "select", Origin: "select", "Recovery Required": "checkbox",
  "Next Action": "rich_text", Holds: "rich_text", "Last Required Written At": "date", "Mutation Count": "number",
  "Verified Mutation Count": "number", "Attempt Count": "number", "Sales Contract Version": "rich_text", "Schema Version": "rich_text",
  "Gate Before": "rich_text", "Gate After Expected": "rich_text", "Gate After Observed": "rich_text", "Harness Plan ID": "rich_text",
} as const;
const RUNS_OPTIONS = {
  Status: ["RUNNING", "HOLD", "HOLD_PARTIAL_COMMIT", "FAILED", "COMPLETED"],
  Origin: ["PLUGIN"],
} as const;
const LEDGER_PROPERTIES = {
  Mutation: "title", "Mutation ID": "unique_id", Status: "select", "Idempotency Key": "rich_text", "Natural Key": "rich_text",
  Operation: "select", "Run Ref": "rich_text", "Target Ref": "rich_text", "Harness Plan ID": "rich_text", "Target Receipt ID": "rich_text",
  "Before Hash": "rich_text", "After Expected Hash": "rich_text", "Compared Fields": "rich_text", "Written At": "date", "Verified At": "date",
} as const;
const LEDGER_OPTIONS = { Status: ["PREPARED", "WRITTEN", "VERIFIED", "FAILED"], Operation: ["CREATE", "UPDATE", "UPSERT"] } as const;
const EXTERNAL_ACTION_PROPERTIES = {
  Action: "title", "Action Key": "rich_text", "Action Type": "select", "Record Type": "select", "Effect Status": "select",
  "Approval State": "select", "Idempotency Key": "rich_text", Recipient: "email", "Subject / Content Hash": "rich_text",
  "Thread ID / Context": "rich_text", "Competent Source ID": "rich_text", Verified: "checkbox", "Observed At": "date",
  "Execution Attempt ID": "rich_text", "Prepared At": "date",
} as const;
const EXTERNAL_ACTION_OPTIONS = {
  "Record Type": ["INTENT"],
  "Effect Status": ["PREPARED", "APPROVED", "NOT_OBSERVED", "AMBIGUOUS", "OBSERVED"],
} as const;
const CAPABILITY_PROFILE_PROPERTIES = {
  "Capability Proof": "title", "Capability Proof Key": "rich_text", "Capability Key": "rich_text", State: "select",
  "Runtime ID": "rich_text", "Principal Key": "rich_text", "Operating Mode": "rich_text", "Competent Source": "select",
  "Evidence Ref": "rich_text", "Verified At": "date", Scope: "rich_text",
} as const;
const CAPABILITY_PROFILE_OPTIONS = {
  State: ["UNKNOWN", "HUMAN_AUTH_PENDING", "READ_VERIFIED", "WRITE_VERIFIED", "PARTIAL", "ERROR", "NOT_APPLICABLE"],
  "Competent Source": ["NOTION", "GMAIL", "GOOGLE_CALENDAR", "MAIL_TRACKER"],
} as const;

const GTM_PHYSICAL_RESOURCES: readonly InstallPhysicalResource[] = [
  { key: "CAMPAIGNS", objectType: "DATABASE", path: ["04 — GTM", "Campaigns"], required: true, registryKey: "CAMPAIGNS", requiredProperties: { Campaign: "title", "Campaign Key": "rich_text", "Owner Rep": "rich_text", "Runtime ID": "rich_text", "Configured Offer": "rich_text", "Configured Price": "rich_text", Status: "select", "Started At": "date", "Ended At": "date", "List Ref": "rich_text", "Dedup Ref": "rich_text" }, requiredSelectOptions: { Status: ["ACTIVE"] } },
  { key: "APPROACH_VERSIONS", objectType: "DATABASE", path: ["04 — GTM", "Approach Versions"], required: true, registryKey: "APPROACH_VERSIONS", requiredProperties: { "Approach Version": "title", "Approach Version Key": "rich_text", "Approach Key": "rich_text", "Version Label": "rich_text", "Authority Scope": "rich_text", "Variant Of": "rich_text", "Provenance Note": "rich_text" } },
  { key: "PARTICIPATIONS", objectType: "DATABASE", path: ["04 — GTM", "Participations"], required: true, registryKey: "PARTICIPATIONS", requiredProperties: { Participation: "title", "Participation Key": "rich_text", "Approach Version": "rich_text", Campaign: "rich_text", "Owner Rep": "rich_text", "Runtime ID": "rich_text", "Task Ref": "rich_text" } },
  { key: "ENROLLMENTS", objectType: "DATABASE", path: ["04 — GTM", "Enrollments"], required: true, registryKey: "ENROLLMENTS", requiredProperties: { Enrollment: "title", "Enrollment Key": "rich_text", Campaign: "rich_text", Contact: "rich_text", Account: "rich_text", State: "select", "Started At": "date", "Ended At": "date", "Qualification Ref": "rich_text", "Evidence Ref": "rich_text" }, requiredSelectOptions: { State: ["ACTIVE", "ENDED"] } },
  { key: "EXPOSURES", objectType: "DATABASE", path: ["04 — GTM", "Exposures"], required: true, registryKey: "EXPOSURES", requiredProperties: { Exposure: "title", "Exposure Key": "rich_text", Contact: "rich_text", "Message Ref": "rich_text", Campaign: "rich_text", "Approach Version": "rich_text", Participation: "rich_text", "Communicated Offer": "rich_text", "Communicated Price": "rich_text", "Price Communicated": "rich_text", Currency: "rich_text", "Price Unit": "rich_text", "Price Scope": "rich_text", "Price Cause Claimed": "rich_text", "Override Evidence": "rich_text", "Message Variant": "select", "Template Ref": "rich_text", "Link Sent": "rich_text", "Link Read": "rich_text", "Link Read Evidence": "rich_text", "Send Evidence": "select", "Provider Receipt": "rich_text", "Pinned At": "date" }, requiredSelectOptions: { "Message Variant": ["PERSONALIZED", "TEMPLATE"], "Send Evidence": ["NOTION_INTENT"] } },
  { key: "MEETING_EPISODES", objectType: "DATABASE", path: ["04 — GTM", "Meeting Episodes"], required: true, registryKey: "MEETING_EPISODES", requiredProperties: { Episode: "title", "Meeting Episode ID": "rich_text", "Episode Kind": "select", Contact: "rich_text", Contacts: "rich_text", Company: "rich_text", "Meeting Status": "select", "Agreement Evidence Ref": "rich_text", "Held Evidence Ref": "rich_text", "Proposed At": "date", "Accepted At": "date", "Booked At": "date", "Held At": "date", "Qualified At": "date", "Canceled At": "date", "Provider Event Refs": "rich_text" }, requiredSelectOptions: { "Episode Kind": ["INTERNAL", "PROSPECT"], "Meeting Status": ["PROPOSED", "ACCEPTED", "BOOKED", "HELD", "QUALIFIED_DISCOVERY"] } },
  { key: "REPLY_ATTRIBUTIONS", objectType: "DATABASE", path: ["04 — GTM", "Reply Attributions"], required: true, registryKey: "REPLY_ATTRIBUTIONS", requiredProperties: { Attribution: "title", "Reply Attribution Key": "rich_text", "Reply Ref": "rich_text", Contact: "rich_text", "Identity Resolution": "select", "Reply At": "date", "In Reply To": "rich_text", "Prior Touches": "rich_text", "Attribution Status": "select", "Attributed To": "rich_text", "Attributed Group": "rich_text", Candidates: "rich_text", Disposition: "select", "Counts As Reply": "rich_text", "Follow Up": "select", "Reply Kind": "select", "Reply Intent": "select", Party: "select", "Duplicate Delivery": "rich_text", "Objection Context": "rich_text", "Provider Message Ref": "rich_text", "Source Instruction": "rich_text", "Provenance Note": "rich_text", Counterfactual: "rich_text", "Outbound Sent": "rich_text", "Takeover Owner": "rich_text" }, requiredSelectOptions: { "Identity Resolution": ["CANONICAL", "UNRESOLVED"], "Attribution Status": ["ATTRIBUTED", "UNATTRIBUTED", "UNKNOWN"], Disposition: ["ELIGIBLE_HUMAN_REPLY", "DUPLICATE_DELIVERY", "INTERNAL_COUNTERPART", "TECHNICAL_AUTOREPLY", "PERMANENT_BOUNCE", "OPT_OUT", "UNKNOWN_KIND_TAKEOVER", "NOT_ATTRIBUTED"], "Follow Up": ["NONE", "HUMAN_TAKEOVER", "STOP_ADDRESS", "SUPPRESS_CONTACT"], "Reply Kind": ["HUMAN", "TECHNICAL", "UNKNOWN"], "Reply Intent": ["POSITIVE", "QUESTION", "OBJECTION", "NEGATIVE", "OPT_OUT", "OUT_OF_OFFICE", "BOUNCE_PERMANENT", "UNDETERMINED"], Party: ["EXTERNAL_PROSPECT", "INTERNAL"] } },
  { key: "GTM_COVERAGE", objectType: "DATABASE", path: ["04 — GTM", "Coverage Declarations"], required: true, registryKey: "GTM_COVERAGE", requiredProperties: { Coverage: "title", "Coverage Key": "rich_text", Source: "select", Since: "date", Until: "date", State: "select", Note: "rich_text" }, requiredSelectOptions: { Source: ["MAILBOX", "MEETING_EVENTS", "TRACKER"], State: ["COMPLETE", "PARTIAL", "REVOKED", "NOT_CONNECTED", "UNKNOWN"] } },
  { key: "GTM_INPUT_REVISIONS", objectType: "DATABASE", path: ["04 — GTM", "Input Revisions"], required: true, registryKey: "GTM_INPUT_REVISIONS", requiredProperties: { "Input Revision": "title", "Input Revision ID": "rich_text", Reason: "select", "Basis Refs": "rich_text", "Basis Digest": "rich_text", Supersedes: "rich_text", "Runtime ID": "rich_text", "Created At": "date" }, requiredSelectOptions: { Reason: ["INITIAL", "BACKFILL", "RECLASSIFICATION"] } },
  { key: "GTM_SNAPSHOTS", objectType: "DATABASE", path: ["04 — GTM", "Metric Snapshots"], required: true, registryKey: "GTM_SNAPSHOTS", requiredProperties: { Snapshot: "title", "Snapshot Key": "rich_text", "Metric Key": "rich_text", Layer: "select", "Period Key": "rich_text", "Period Start": "date", "Period End": "date", "Observation Cutoff": "date", Scope: "select", Value: "rich_text", Computability: "select", "Input Revision": "rich_text", "Metric Definitions Version": "rich_text", "Metric Definitions Digest": "rich_text", "Coverage Refs": "rich_text", "Coverage Digest": "rich_text", "Coverage State Reported": "select", "Evidence Refs": "rich_text", "Target Comparison": "rich_text", "Numerator Unit": "rich_text", "Denominator Unit": "rich_text", "Compared With Snapshot": "rich_text", "Comparison Maturity Note": "rich_text" }, requiredSelectOptions: { Layer: ["CONFIGURATION", "EXECUTION", "EFFECTIVENESS"], Scope: ["RUNTIME", "COMPANY_GLOBAL"], Computability: ["COMPUTED", "INCONCLUSIVE", "NOT_COMPUTABLE"], "Coverage State Reported": ["COMPLETE", "PARTIAL", "REVOKED", "NOT_CONNECTED", "UNKNOWN"] } },
];

export const SALES_CONTROL_PLANE_05: ControlPlaneGrammar = {
  recoveryPolicy: { replayFromBeforeState: true },
  installContract: {
    physicalResources: [
      { key: "ROOT", objectType: "PAGE", path: [], required: true, registryKey: "ROOT" },
      { key: "BOOT_CARD", objectType: "PAGE", path: ["00 — BOOT & INSTANCE", "00A — BOOT CARD"], required: true, registryKey: "BOOT_CARD" },
      { key: "INSTALL_RESUME", objectType: "PAGE", path: ["00 — BOOT & INSTANCE", "00B — INSTALL & RESUME PROTOCOL"], required: true, registryKey: "INSTALL_RESUME" },
      { key: "START_HERE", objectType: "PAGE", path: ["00 — BOOT & INSTANCE", "00 — START HERE"], required: true, registryKey: "START_HERE" },
      { key: "AGENT_BOOTSTRAP", objectType: "PAGE", path: ["00 — BOOT & INSTANCE", "01 — AGENT BOOTSTRAP — Same-lane contract"], required: true, registryKey: "AGENT_BOOTSTRAP" },
      { key: "INSTANCE_MANIFEST", objectType: "DATABASE", path: ["00 — BOOT & INSTANCE", "Instance Manifest"], required: true, registryKey: "INSTANCE_MANIFEST", requiredProperties: INSTANCE_MANIFEST_PROPERTIES, requiredSelectOptions: INSTANCE_MANIFEST_OPTIONS },
      { key: "REGISTRY", objectType: "DATABASE", path: ["00 — BOOT & INSTANCE", "Registry"], required: true, registryKey: "REGISTRY", requiredProperties: REGISTRY_PROPERTIES, requiredSelectOptions: REGISTRY_OPTIONS },
      { key: "CONSTITUTION", objectType: "PAGE", path: ["01 — CONSTITUTION & POLICIES", "03 — OPERATING CONSTITUTION & GATES"], required: true, registryKey: "CONSTITUTION" },
      { key: "TRUTH_EVIDENCE_POLICY", objectType: "PAGE", path: ["01 — CONSTITUTION & POLICIES", "03A — TRUTH & EVIDENCE POLICY"], required: true, registryKey: "TRUTH_EVIDENCE_POLICY" },
      { key: "AUTHORITY_POLICY", objectType: "PAGE", path: ["01 — CONSTITUTION & POLICIES", "03B — AUTHORITY & EXTERNAL ACTION POLICY"], required: true, registryKey: "AUTHORITY_POLICY" },
      { key: "GMAIL_TRACKING_POLICY", objectType: "PAGE", path: ["01 — CONSTITUTION & POLICIES", "03C — GMAIL & EMAIL TRACKING POLICY"], required: true, registryKey: "GMAIL_TRACKING_POLICY" },
      { key: "SCOPE_INTAKE_POLICY", objectType: "PAGE", path: ["01 — CONSTITUTION & POLICIES", "03D — SCOPE & INTAKE POLICY"], required: true, registryKey: "SCOPE_INTAKE_POLICY" },
      { key: "POLICY_CHANGES", objectType: "DATABASE", path: ["01 — CONSTITUTION & POLICIES", "Policy Changes"], required: true, registryKey: "POLICY_CHANGES", requiredProperties: { Change: "title", "Policy Area": "select", Status: "select", "Human Approved": "checkbox", "Requested By": "rich_text" } },
      { key: "ONBOARDING", objectType: "PAGE", path: ["02 — SETUP & BUSINESS CONFIG", "02 — ONBOARDING & DATA INTAKE"], required: true, registryKey: "ONBOARDING" },
      { key: "BUSINESS_CONFIG", objectType: "DATABASE", path: ["02 — SETUP & BUSINESS CONFIG", "Business Configuration"], required: true, registryKey: "BUSINESS_CONFIG", requiredProperties: { "Config Item": "title", Category: "select", State: "select", Value: "rich_text", Version: "rich_text" } },
      { key: "QUALIFICATION_GATES", objectType: "DATABASE", path: ["02 — SETUP & BUSINESS CONFIG", "Qualification Gates"], required: true, registryKey: "QUALIFICATION_GATES", requiredProperties: { Gate: "title", "Gate Key": "rich_text", Active: "checkbox", "Hard Gate": "checkbox", "Pass Condition": "rich_text", Version: "rich_text" } },
      { key: "AUTHORITY_MATRIX", objectType: "DATABASE", path: ["02 — SETUP & BUSINESS CONFIG", "Authority Matrix"], required: true, registryKey: "AUTHORITY_MATRIX", requiredProperties: { Action: "title", "Action Type": "select", "Allowed In Mode": "multi_select", Authority: "select", Active: "checkbox", Preconditions: "rich_text", "Stop Conditions": "rich_text" } },
      { key: "RUNTIME_CONFIG", objectType: "DATABASE", path: ["02 — SETUP & BUSINESS CONFIG", "Runtime Configuration"], required: true, registryKey: "RUNTIME_CONFIG", requiredProperties: { Config: "title", Type: "select", State: "select", Value: "rich_text", Source: "rich_text" } },
      { key: "OS_STATE", objectType: "DATABASE", path: ["03 — CONTROL PLANE", "OS State"], required: true, registryKey: "OS_STATE", requiredProperties: OS_STATE_PROPERTIES, requiredSelectOptions: OS_STATE_OPTIONS },
      { key: "TASKS", objectType: "DATABASE", path: ["03 — CONTROL PLANE", "Tasks"], required: true, registryKey: "TASKS", requiredProperties: { Task: "title", Status: "select", Type: "select", Authority: "select", "Idempotency Key": "rich_text", "Runtime ID": "rich_text" } },
      { key: "DECISION_RULES", objectType: "DATABASE", path: ["03 — CONTROL PLANE", "Decision Rules"], required: true, registryKey: "DECISION_RULES", requiredProperties: { Rule: "title", Trigger: "select", "Default Disposition": "select", "Required Authority": "select", Active: "checkbox" } },
      { key: "RUNS", objectType: "DATABASE", path: ["03 — CONTROL PLANE", "Runs"], required: true, registryKey: "RUNS", requiredProperties: RUNS_PROPERTIES, requiredSelectOptions: RUNS_OPTIONS },
      { key: "RECEIPTS", objectType: "DATABASE", path: ["03 — CONTROL PLANE", "Receipts"], required: true, registryKey: "RECEIPTS", requiredProperties: { Receipt: "title", Verified: "checkbox", "Idempotency Key": "rich_text", "Event Type": "select" } },
      { key: "DAILY_GO", objectType: "PAGE", path: ["03 — CONTROL PLANE", "04 — DAILY GO PROTOCOL"], required: true, registryKey: "DAILY_GO" },
      { key: "DECISION_ENGINE", objectType: "PAGE", path: ["03 — CONTROL PLANE", "04A — DAILY DECISION ENGINE"], required: true, registryKey: "DECISION_ENGINE" },
      { key: "MUTATION_LEDGER", objectType: "DATABASE", path: ["03 — CONTROL PLANE", "Mutation Ledger"], required: true, requiredProperties: LEDGER_PROPERTIES, requiredSelectOptions: LEDGER_OPTIONS },
      { key: "EXTERNAL_ACTIONS", objectType: "DATABASE", path: ["03 — CONTROL PLANE", "External Actions"], required: true, registryKey: "EXTERNAL_ACTIONS", requiredProperties: EXTERNAL_ACTION_PROPERTIES, requiredSelectOptions: EXTERNAL_ACTION_OPTIONS },
      { key: "CAPABILITY_PROFILE", objectType: "DATABASE", path: ["03 — CONTROL PLANE", "Capability Profile"], required: true, registryKey: "CAPABILITY_PROFILE", requiredProperties: CAPABILITY_PROFILE_PROPERTIES, requiredSelectOptions: CAPABILITY_PROFILE_OPTIONS },
      { key: "INTAKE", objectType: "DATABASE", path: ["04 — DATA & EVIDENCE", "Intake"], required: true, registryKey: "INTAKE", requiredProperties: { Intake: "title", Status: "select", "Source Type": "select", Target: "rich_text", "Human Required": "checkbox" } },
      { key: "ACCOUNTS", objectType: "DATABASE", path: ["04 — DATA & EVIDENCE", "Accounts"], required: true, registryKey: "ACCOUNTS", requiredProperties: { Company: "title", Qualification: "select", Lifecycle: "select", Tier: "select", Website: "url", "Do Not Contact": "checkbox" } },
      { key: "CONTACTS", objectType: "DATABASE", path: ["04 — DATA & EVIDENCE", "Contacts"], required: true, registryKey: "CONTACTS", requiredProperties: { Contact: "title", Account: "relation", Email: "email", "Email Status": "select", Lifecycle: "select", "Do Not Contact": "checkbox" } },
      { key: "EVIDENCE", objectType: "DATABASE", path: ["04 — DATA & EVIDENCE", "Evidence"], required: true, registryKey: "EVIDENCE", requiredProperties: { Claim: "title", Type: "select", Confidence: "select", "Source URL": "url", Account: "relation", Contact: "relation" } },
      { key: "ENGAGEMENT_SIGNALS", objectType: "DATABASE", path: ["04 — DATA & EVIDENCE", "Engagement Signals"], required: true, registryKey: "ENGAGEMENT_SIGNALS", requiredProperties: { Signal: "title", "Signal Type": "select", Reliability: "select", Account: "relation", Contact: "relation", Evidence: "relation", "Verified Source": "checkbox" } },
      { key: "OPS_CONTRACTS", objectType: "PAGE", path: ["05 — OPERATIONS & PLAYBOOKS", "05 — OPS CONTRACTS"], required: true, registryKey: "OPS_CONTRACTS" },
      { key: "SEQUENCES", objectType: "DATABASE", path: ["05 — OPERATIONS & PLAYBOOKS", "Sequences"], required: true, registryKey: "SEQUENCES", requiredProperties: { Sequence: "title", Status: "select", "Default Authority": "select", "Max Steps": "number", "Stop Conditions": "rich_text" } },
      { key: "TEST_PROTOCOL", objectType: "PAGE", path: ["99 — TESTS & CHANGELOG", "06 — TEST PROTOCOL"], required: false, registryKey: "TEST_PROTOCOL" },
    ],
    connectorCapabilities: [
      { key: "GMAIL", requirement: "REQUIRED", competentSource: "GMAIL" },
      { key: "EMAIL_TRACKER", requirement: "OPTIONAL", competentSource: "MAIL_TRACKER" },
    ],
  },
  // SALES resource catalog (PV0-017). The External Actions intent record is the only externally-effective resource:
  // the plugin may CREATE an INTENT (Effect Status PREPARED) or UPDATE its routing fields; Effect Status, Approval
  // State and Record Type are owned by the executor / human and can never be set through os_prepare.
  resources: {
    "SALES:EXTERNAL_ACTIONS": { parentTitle: "03 — CONTROL PLANE", databaseTitle: "External Actions", naturalKeyProperty: "Action Key", operations: ["CREATE", "UPDATE"], protectedProperties: ["Effect Status", "Approval State", "Record Type", "Competent Source ID", "Verified", "Observed At", "Execution Attempt ID"], createDefaults: { "Record Type": "INTENT", "Effect Status": "PREPARED" }, externalEffect: true },
    // A registry-assigned clone is intentionally addressable before it becomes an instance, but only through the
    // INSTALL validator. These resources never grant business access and disappear from the permitted surface as
    // soon as the Manifest reaches SETUP.
    "SALES:INSTALL_MANIFEST": {
      parentTitle: "00 — BOOT & INSTANCE", databaseTitle: "Instance Manifest", naturalKeyProperty: "Name",
      operations: ["UPDATE"], bootstrapOnly: true, protectedProperties: ["Name"],
      writableProperties: ["Root URL", "Instance ID", "Owner", "Gmail Identity", "Install State", "Instance Status", "Sales Contract URL", "Last Run Ref", "Read Scope", "Write Scope", "Gmail Verified", "Tracker Access", "Capability Status", "Recovery Required"],
      redactValues: true,
    },
    "SALES:INSTALL_REGISTRY": {
      parentTitle: "00 — BOOT & INSTANCE", databaseTitle: "Registry", naturalKeyProperty: "Key",
      operations: ["UPDATE"], bootstrapOnly: true, protectedProperties: ["Key"],
      writableProperties: ["Required", "Resource URL", "Resource Type", "Status", "Scope", "Notes"],
      redactValues: true,
    },
    "SALES:CAPABILITY_PROOFS": {
      parentTitle: "03 — CONTROL PLANE", databaseTitle: "Capability Profile", naturalKeyProperty: "Capability Proof Key",
      operations: ["CREATE"], protectedProperties: ["Capability Proof Key"],
    },
  },
  writeProps: { runHarnessPlanId: "Harness Plan ID", runOriginValue: "PLUGIN", ledgerTargetRef: "Target Ref", ledgerHarnessPlanId: "Harness Plan ID", ledgerIdempotencyKey: "Idempotency Key", ledgerTargetReceiptId: "Target Receipt ID", ledgerOperation: "Operation" },
  parentTitle: "03 — CONTROL PLANE",
  runsDatabaseTitle: "Runs",
  ledgerDatabaseTitle: "Mutation Ledger",
  stateDatabaseTitle: "OS State",
  stateRowTitle: "CURRENT",
  externalActionsDatabaseTitle: "External Actions",
  capabilityProofsDatabaseTitle: "Capability Profile",
  capabilityProofProps: {
    title: "Capability Proof", proofKey: "Capability Proof Key", capabilityKey: "Capability Key", state: "State",
    runtimeId: "Runtime ID", principalKey: "Principal Key", operatingMode: "Operating Mode",
    competentSource: "Competent Source", evidenceRef: "Evidence Ref", verifiedAt: "Verified At", scope: "Scope",
  },
  runProps: { title: "Run", runId: "Run ID", status: "Status", recoveryRequired: "Recovery Required", nextAction: "Next Action", holds: "Holds", lastRequiredWrittenAt: "Last Required Written At", mutationCount: "Mutation Count", verifiedMutationCount: "Verified Mutation Count", attemptCount: "Attempt Count", specVersion: "Sales Contract Version", schemaVersion: "Schema Version", gateBefore: "Gate Before", gateAfterExpected: "Gate After Expected", gateAfterObserved: "Gate After Observed", origin: "Origin" },
  ledgerProps: { title: "Mutation", mutationId: "Mutation ID", status: "Status", runRef: "Run Ref" },
  manifestCursor: { runtimeState: "Install State", health: "Health Status", persistenceHealth: "Persistence Health", recoveryRequired: "Recovery Required", currentGate: "Current Gate", currentGateStatus: "Current Gate Status", lastRunRef: "Last Run Ref", lastVerifiedMutation: "Last Verified Mutation", lastRequiredWrittenAt: "Last Required Written At", lastVerifiedAt: "Last Verified At" },
  stateCursor: { runtimeState: "Build State", persistenceHealth: "Persistence Health", recoveryRequired: "Recovery Required", currentGate: "Current Gate", currentGateStatus: "Current Gate Status", openBlocker: "Open Blocker", nextAction: "Next Action", nextQuestion: "Next Question", lastRunRef: "Last Run Ref", lastVerifiedMutation: "Last Verified Mutation", lastRequiredWrittenAt: "Last Required Written At", lastVerifiedAt: "Last Verified At" },
  externalActionProps: { recordType: "Record Type", effectStatus: "Effect Status", approvalState: "Approval State", actionKey: "Action Key", actionType: "Action Type", recipient: "Recipient", subject: "Subject / Content Hash", threadRef: "Thread ID / Context", effectRef: "Competent Source ID", preparedAt: "Prepared At", accountRef: "Account Ref", contactRef: "Contact Ref", authorityRef: "Authority Ref" },
  incompleteRunStatuses: ["RUNNING", "HOLD", "HOLD_PARTIAL_COMMIT", "FAILED"],
  nonVerifiedLedgerStatuses: ["PREPARED", "WRITTEN", "FAILED"],
  unresolvedEffectStatuses: ["PREPARED", "APPROVED", "NOT_OBSERVED", "AMBIGUOUS"],
  intentRecordType: "INTENT",
};

/**
 * Calendar bridge for the existing 0.5.1 physical Sales runtime. This deliberately changes only connector
 * requirements: the Notion structure, mutable resource catalog and control-plane grammar remain byte-for-byte
 * equivalent to 0.5.1. In particular, it does not opt the runtime into the 0.6 GTM resource catalog.
 */
export const SALES_CONTROL_PLANE_052: ControlPlaneGrammar = {
  ...SALES_CONTROL_PLANE_05,
  installContract: {
    physicalResources: SALES_CONTROL_PLANE_05.installContract?.physicalResources ?? [],
    connectorCapabilities: [
      { key: "GMAIL", requirement: "REQUIRED", competentSource: "GMAIL" },
      { key: "GOOGLE_CALENDAR", requirement: "REQUIRED", competentSource: "GOOGLE_CALENDAR" },
      { key: "EMAIL_TRACKER", requirement: "OPTIONAL", competentSource: "MAIL_TRACKER" },
    ],
  },
};

/**
 * PV-GATE-000: the published B0 → READY walk of a Personal SALES space, transcribed from the governing gate
 * contract. Only `B0_DISCOVERY` is specified deterministically today; naming the other seven here is precisely
 * what makes their absence observable instead of silent.
 */
const SALES_GATE_SEQUENCE: GateSequence = {
  gates: ["B0_DISCOVERY", "B1_OFFER", "B2_ICP", "B3_DATA", "B4_QUALIFICATION", "B5_OUTREACH", "B6_AUTHORITY", "B7_DRY_RUN"],
  terminal: "READY",
};

/** PV-B0-002: the only cursor movement this contract line authorizes the backend to derive. */
const SALES_B0_TO_B1: DerivedCursorTransition = {
  key: "B0_DISCOVERY->B1_OFFER",
  fromGate: "B0_DISCOVERY",
  evidence: {
    logicalResourceKey: "SALES:BUSINESS_CONFIG",
    naturalKey: "B0_DISCOVERY:PRIMARY_OUTCOME",
    equals: { Category: "GOAL", State: "CONFIRMED", Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" },
    nonEmpty: ["Value"],
  },
  targetResourceKey: "SALES:OS_STATE",
  targetNaturalKey: "CURRENT",
  set: {
    Name: "CURRENT",
    "Current Gate": "B1_OFFER",
    "Build State": "B1_OFFER",
    "Current Gate Status": "OPEN",
    "Last Durable Mode": "INTAKE",
    "Next Authorized Topic": "B1_OFFER",
    // The canonical OFFER question published by the governing contract page of this line (PV-B1-001). The
    // catalog had drifted to a different question in English; the published page is the authority.
    "Next Action": "Énoncer l'offre précise à vendre et le signe que le client voit quand elle a marché",
    "Next Question": "Quelle offre précise veux-tu vendre, et à quoi le client voit qu'elle a marché ?",
    "Persistence Health": "PASS",
    "Recovery Required": false,
  },
  // The run and mutation that made B0 durable are already on the cursor: the B0 transaction's own state-last
  // write put it there, so the transition points at it instead of minting a new reference. `Last Verified
  // Mutation` stays finalizer-stamped, and `Last Durable Turn ID` is not written at all: it needs a stable
  // external turn identifier, and this architecture assumes none exists.
  carryForward: { "Gate Passed By Run Ref": "lastRunRef" },
  runReferenceProperties: ["Last Run Ref"],
  stampedProperties: ["Last Verified At", "Last Required Written At"],
  clearWhenUnblocked: ["Open Blocker"],
};

/**
 * Personal SALES V1 candidate. This is a contract-dispatched catalog: older 0.5 runtimes retain their narrow
 * External Actions surface, while a runtime that explicitly pins 0.5.3 can transact over the complete bounded
 * research -> qualification -> activation data path. Natural keys are existing live properties observed on the
 * 0.5.1 physical schema; exact duplicate rows fail closed in the generic resolver.
 */
export const SALES_CONTROL_PLANE_053: ControlPlaneGrammar = {
  ...SALES_CONTROL_PLANE_052,
  installContract: {
    physicalResources: (SALES_CONTROL_PLANE_052.installContract?.physicalResources ?? []).map((resource) => {
      const keyProperty = {
        BUSINESS_CONFIG: { "Config Item": "title" }, QUALIFICATION_GATES: { "Gate Key": "rich_text" },
        INTAKE: { "Source Reference": "rich_text" }, ACCOUNTS: { Website: "url" }, CONTACTS: { Email: "email" },
        EVIDENCE: { "Source URL": "url" }, SEQUENCES: { Sequence: "title" }, TASKS: { "Idempotency Key": "rich_text" },
        EXTERNAL_ACTIONS: { "Action Key": "rich_text" },
      }[resource.key] as Readonly<Record<string, string>> | undefined;
      return keyProperty ? { ...resource, requiredProperties: { ...(resource.requiredProperties ?? {}), ...keyProperty } } : resource;
    }),
    connectorCapabilities: SALES_CONTROL_PLANE_052.installContract?.connectorCapabilities ?? [],
  },
  resources: {
    ...(SALES_CONTROL_PLANE_052.resources ?? {}),
    "SALES:BUSINESS_CONFIG": {
      foreignWriteGuard: true,
      parentTitle: "02 — SETUP & BUSINESS CONFIG", databaseTitle: "Business Configuration",
      naturalKeyProperty: "Config Item", naturalKeyKind: "OPAQUE", operations: ["CREATE", "UPDATE", "UPSERT"],
      protectedProperties: ["Config Item"],
      writableProperties: ["Category", "State", "Value", "Version", "Effective At", "Source", "Notes"],
      uncomparedProperties: ["Effective At", "Notes"],
      redactValues: true,
    },
    "SALES:QUALIFICATION_GATES": {
      foreignWriteGuard: true,
      parentTitle: "02 — SETUP & BUSINESS CONFIG", databaseTitle: "Qualification Gates",
      naturalKeyProperty: "Gate Key", naturalKeyKind: "OPAQUE", operations: ["CREATE", "UPDATE", "UPSERT"],
      protectedProperties: ["Gate Key"],
      writableProperties: ["Gate", "Active", "Hard Gate", "Criterion", "Pass Condition", "Required Evidence", "Fail Disposition", "Version", "Notes"],
      redactValues: true,
    },
    "SALES:INTAKE": {
      parentTitle: "04 — DATA & EVIDENCE", databaseTitle: "Intake",
      naturalKeyProperty: "Source Reference", naturalKeyKind: "OPAQUE", operations: ["CREATE", "UPDATE", "UPSERT"],
      protectedProperties: ["Source Reference"],
      writableProperties: ["Intake", "Status", "Source Type", "Target", "Filename", "Detected Content", "Record Count", "Duplicate Strategy", "Mutation Plan", "Human Required", "Outcome", "Run"],
      redactValues: true,
    },
    "SALES:ACCOUNTS": {
      parentTitle: "04 — DATA & EVIDENCE", databaseTitle: "Accounts",
      naturalKeyProperty: "Website", naturalKeyKind: "HTTP_URL", operations: ["CREATE", "UPDATE", "UPSERT"],
      protectedProperties: ["Website"],
      writableProperties: ["Company", "Qualification", "Lifecycle", "Tier", "Do Not Contact", "Score", "Source", "Primary Hypothesis", "Open Gaps", "Next Action", "Next Action Date", "Last Reconciled", "Notes"],
      redactValues: true,
    },
    "SALES:CONTACTS": {
      parentTitle: "04 — DATA & EVIDENCE", databaseTitle: "Contacts",
      naturalKeyProperty: "Email", naturalKeyKind: "EMAIL", operations: ["CREATE", "UPDATE", "UPSERT"],
      protectedProperties: ["Email"],
      writableProperties: ["Contact", "Account", "Email Status", "Email Source", "Lifecycle", "Buyer Role", "Role", "Do Not Contact", "Last Contact", "Next Action Date", "Notes"],
      redactValues: true,
    },
    "SALES:EVIDENCE": {
      parentTitle: "04 — DATA & EVIDENCE", databaseTitle: "Evidence",
      // V1 consolidates one evidence row per exact source URL. A second claim from the same source updates that
      // consolidated row; multiple rows for the same URL are an ambiguity HOLD, never guessed apart by title.
      naturalKeyProperty: "Source URL", naturalKeyKind: "HTTP_URL", operations: ["CREATE", "UPDATE", "UPSERT"],
      protectedProperties: ["Source URL"],
      writableProperties: ["Claim", "Type", "Confidence", "Source Date", "Source Provider", "Gate", "Account", "Contact", "Engagement Signal", "Notes"],
      redactValues: true,
    },
    "SALES:SEQUENCES": {
      parentTitle: "05 — OPERATIONS & PLAYBOOKS", databaseTitle: "Sequences",
      naturalKeyProperty: "Sequence", naturalKeyKind: "OPAQUE", operations: ["CREATE", "UPDATE", "UPSERT"],
      protectedProperties: ["Sequence"],
      writableProperties: ["Status", "Default Authority", "Max Steps", "Stop Conditions", "Trigger", "Audience", "Notes"],
      redactValues: true,
    },
    "SALES:TASKS": {
      parentTitle: "03 — CONTROL PLANE", databaseTitle: "Tasks",
      naturalKeyProperty: "Idempotency Key", naturalKeyKind: "OPAQUE", operations: ["CREATE", "UPDATE", "UPSERT"],
      protectedProperties: ["Idempotency Key", "Runtime ID"],
      writableProperties: ["Task", "Status", "Type", "Authority", "Account", "Contact", "Sequence", "Due Date", "Gate", "Expected Outcome", "Blocker", "Enrollment Ref", "Published Sequence Version", "Shared Account Ref", "Shared Contact Ref"],
      redactValues: true,
    },
    // MIG-SALES-052-001. The canonical outreach pipeline of a seller lives in the
    // AUTHORIZED COMMERCIAL OBJECTIVE PACKAGE, not in the Personal Sales runtime: V1 links and reconciles the
    // existing company truth instead of copying it into a second one. Addressing therefore resolves through the
    // runtime's backend objective pointer, and `Action Key` (added by MIG-SALES-052-001) is the stable idempotency
    // key: the backend writes record_selector.natural_key into it verbatim and compares it, so a retry or a fresh
    // chat reusing the same key can never produce a second row. Creating a row here has no external effect and
    // grants no send authority; every effect-bearing field is caller-supplied or absent, never fabricated.
    "SALES:OUTREACH_PIPELINE": {
      scope: "OBJECTIVE_PACKAGE", databaseTitle: "Outreach Pipeline",
      naturalKeyProperty: "Action Key", naturalKeyKind: "OPAQUE", naturalKeyIsIdentity: true, operations: ["CREATE", "UPDATE"],
      protectedProperties: ["Action Key"],
      writableProperties: ["Outreach", "Account", "Contact", "Tier", "Channel", "Angle", "Evidence-led opener", "Message version", "Notes", "Stage", "Sent date", "Last touch", "Next touch", "Outcome", "Objection", "Reply summary"],
      redactValues: true,
    },
    "SALES:EXTERNAL_ACTIONS": {
      parentTitle: "03 — CONTROL PLANE", databaseTitle: "External Actions",
      naturalKeyProperty: "Action Key", naturalKeyKind: "OPAQUE", operations: ["CREATE", "UPDATE"],
      protectedProperties: ["Action Key", "Effect Status", "Approval State", "Record Type", "Competent Source ID", "Verified", "Observed At", "Execution Attempt ID"],
      writableProperties: ["Action", "Action Type", "Idempotency Key", "Recipient", "Subject / Content Hash", "Thread ID / Context", "Account Ref", "Contact Ref", "Run Ref", "Prepared At", "Approval Expires At", "Error"],
      createDefaults: { "Record Type": "INTENT", "Effect Status": "PREPARED" }, externalEffect: true,
      redactValues: true,
    },
  },
};

/**
 * PV-B1-002: the OFFER step's move, published on the line that specifies it (see `SALES_CONTROL_PLANE_055`).
 *
 * It is the B0 entry with nothing borrowed from it: its own gate, its own canonical record, its own required
 * values and its own destination. That is the point — the mechanism carries no knowledge of either step, so a
 * later gate is a catalog entry, never a branch.
 *
 * The record is `B1_OFFER:SELLABLE_OFFER` in the seller's Business Configuration, under the `OFFER` category the
 * live schema already publishes: specifying the step needs no migration, only a declaration. What completes the
 * step is one confirmed offer the seller stated themselves — the single business decision PV-GATE-000 allows a
 * gate to ask for. The value, proof and constraint categories the same database offers are deliberately NOT
 * part of the predicate: they enrich an offer that is already decided, and a gate that waited on four answers
 * would be four gates wearing one name.
 */
const SALES_B1_TO_B2: DerivedCursorTransition = {
  key: "B1_OFFER->B2_ICP",
  fromGate: "B1_OFFER",
  evidence: {
    logicalResourceKey: "SALES:BUSINESS_CONFIG",
    naturalKey: "B1_OFFER:SELLABLE_OFFER",
    equals: { Category: "OFFER", State: "CONFIRMED", Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" },
    nonEmpty: ["Value"],
  },
  targetResourceKey: "SALES:OS_STATE",
  targetNaturalKey: "CURRENT",
  set: {
    Name: "CURRENT",
    "Current Gate": "B2_ICP",
    "Build State": "B2_ICP",
    "Current Gate Status": "OPEN",
    "Last Durable Mode": "INTAKE",
    "Next Authorized Topic": "B2_ICP",
    "Next Action": "Définir les comptes à viser et ceux à écarter d'office",
    "Next Question": "Quels comptes veux-tu viser en priorité, et lesquels exclure d'office ?",
    "Persistence Health": "PASS",
    "Recovery Required": false,
  },
  carryForward: { "Gate Passed By Run Ref": "lastRunRef" },
  runReferenceProperties: ["Last Run Ref"],
  stampedProperties: ["Last Verified At", "Last Required Written At"],
  clearWhenUnblocked: ["Open Blocker"],
};

/**
 * Same-turn B0 capture line. It is the V1 line plus exactly the two things
 * the 0.5.4 page adds and 0.5.3 never mentions: the durable cursor as a backend-derived transactional resource
 * (PV-B0-002) and the one cursor movement the contract authorizes the backend to derive from verified evidence.
 *
 * Keeping them here rather than on 0.5.3 is what makes the published rollback real: re-pinning
 * the prior V1 line in the Manifest removes the amendment's behaviour outright, instead of
 * renaming a version while the cursor stays writable. Each line therefore matches its own governing page.
 */
export const SALES_CONTROL_PLANE_054: ControlPlaneGrammar = {
  ...SALES_CONTROL_PLANE_053,
  cursorTransitions: [SALES_B0_TO_B1],
  gateSequence: SALES_GATE_SEQUENCE,
  resources: {
    ...(SALES_CONTROL_PLANE_053.resources ?? {}),
    // PV-B0-002. The durable cursor becomes an authorized transactional resource, but only for the backend:
    // every value comes from the contract or from the cursor's own durable row, so a conversation can never
    // declare a gate. Timestamps and the blocker are written and deliberately left outside the proof.
    "SALES:OS_STATE": {
      parentTitle: "03 — CONTROL PLANE", databaseTitle: "OS State",
      naturalKeyProperty: "Name", naturalKeyKind: "OPAQUE", operations: ["UPDATE"],
      backendDerivedOnly: true,
      writableProperties: [
        "Name", "Current Gate", "Build State", "Current Gate Status", "Gate Passed By Run Ref",
        "Last Run Ref", "Last Verified Mutation", "Last Durable Mode", "Last Durable Turn ID", "Next Authorized Topic",
        "Next Action", "Next Question", "Persistence Health", "Recovery Required",
        "Last Verified At", "Last Required Written At", "Open Blocker",
      ],
      // Finalizer-stamped provenance and the optional external turn pointer are written when available but are
      // never part of the caller-visible proof, alongside the commit timestamps and the blocker.
      uncomparedProperties: ["Last Verified At", "Last Required Written At", "Open Blocker", "Last Verified Mutation", "Last Durable Turn ID"],
      redactValues: true,
    },
  },
};

/**
 * OFFER step line. It is the capture line plus exactly one catalog entry: the transition that leaves
 * `B1_OFFER`. No resource, no property and no other transition changes, because specifying a step that writes
 * into a database the contract already addresses requires nothing else.
 *
 * It is its own line for the same reason the capture line was: re-pinning 0.5.4 removes the OFFER step outright
 * and returns the runtime to holding at `B1_OFFER`, instead of leaving a step half-specified under a version
 * that no longer describes it. Each line matches its own governing page.
 */
export const SALES_CONTROL_PLANE_055: ControlPlaneGrammar = {
  ...SALES_CONTROL_PLANE_054,
  cursorTransitions: [SALES_B0_TO_B1, SALES_B1_TO_B2],
};

/**
 * The remaining specified setup steps, B2 through B6 (PV-B2..PV-B6).
 *
 * B1 proved the entry; these five prove it is a catalog. Every one of them records ONE confirmed answer in the
 * seller's own Business Configuration, under a category the live schema already publishes, and moves the cursor
 * to the step whose question it writes. Nothing else varies — which is exactly the claim: a step costs a
 * declaration, never a branch, and the engine that carried B0 and B1 carries these unchanged.
 *
 * `B7_DRY_RUN` deliberately gets no entry. It does not assert a DECISION the seller makes, it asserts that work
 * was DONE — research, evidence, deduplication, qualification, a cohort, drafts. A configuration row claiming
 * that would be self-attestation, which this contract refuses everywhere else. It is the human boundary, and
 * asking to advance it holds on `HOLD_GATE_UNSPECIFIED` until a predicate that reads the real rows is published.
 */
function setupStep(from: string, to: string, answerKey: string, category: string, nextAction: string, nextQuestion: string): DerivedCursorTransition {
  return {
    key: `${from}->${to}`,
    fromGate: from,
    evidence: {
      logicalResourceKey: "SALES:BUSINESS_CONFIG",
      naturalKey: answerKey,
      equals: { Category: category, State: "CONFIRMED", Version: "SALES_INPUT/1", Source: "CHAT_USER_EXPLICIT" },
      nonEmpty: ["Value"],
    },
    targetResourceKey: "SALES:OS_STATE",
    targetNaturalKey: "CURRENT",
    set: {
      Name: "CURRENT",
      "Current Gate": to,
      "Build State": to,
      "Current Gate Status": "OPEN",
      "Last Durable Mode": "INTAKE",
      "Next Authorized Topic": to,
      "Next Action": nextAction,
      "Next Question": nextQuestion,
      "Persistence Health": "PASS",
      "Recovery Required": false,
    },
    carryForward: { "Gate Passed By Run Ref": "lastRunRef" },
    runReferenceProperties: ["Last Run Ref"],
    stampedProperties: ["Last Verified At", "Last Required Written At"],
    clearWhenUnblocked: ["Open Blocker"],
  };
}

const SALES_SETUP_STEPS: readonly DerivedCursorTransition[] = [
  setupStep("B2_ICP", "B3_DATA", "B2_ICP:TARGET_ACCOUNTS", "ICP_INCLUDE",
    "Nommer la source d'où viennent les comptes et les contacts",
    "D'où viennent tes comptes et contacts, et que fait-on d'une nouvelle entrée ?"),
  setupStep("B3_DATA", "B4_QUALIFICATION", "B3_DATA:CANONICAL_SOURCE", "OTHER",
    "Fixer ce qui disqualifie un compte sans discussion",
    "Qu'est-ce qui disqualifie un compte immédiatement, sans discussion ?"),
  setupStep("B4_QUALIFICATION", "B5_OUTREACH", "B4_QUALIFICATION:HARD_GATE", "CONSTRAINT",
    "Définir la séquence de prise de contact et ses conditions d'arrêt",
    "Combien de touches, sur quel canal, et qu'est-ce qui arrête la séquence ?"),
  setupStep("B5_OUTREACH", "B6_AUTHORITY", "B5_OUTREACH:SEQUENCE", "MESSAGING",
    "Délimiter ce que l'agent peut envoyer seul",
    "Qu'est-ce que l'agent peut envoyer seul, et qu'est-ce qui exige ton accord ?"),
  setupStep("B6_AUTHORITY", "B7_DRY_RUN", "B6_AUTHORITY:SEND_AUTHORITY", "CONSTRAINT",
    "Relire un cycle complet en essai, sans aucun envoi — cette étape se franchit avec toi",
    "Veux-tu qu'on prépare un essai complet sans envoi, à relire ensemble avant toute autorisation ?"),
];

/**
 * Full setup line: every specified step from `B0_DISCOVERY` to `B7_DRY_RUN`, and nothing else new. No resource,
 * no property, no connector requirement changes — five catalog entries do.
 *
 * Re-pinning 0.5.5 removes the five and returns a runtime to holding at whichever of them it had reached, which
 * is the same rollback discipline every line before it follows.
 */
export const SALES_CONTROL_PLANE_056: ControlPlaneGrammar = {
  ...SALES_CONTROL_PLANE_055,
  cursorTransitions: [...(SALES_CONTROL_PLANE_055.cursorTransitions ?? []), ...SALES_SETUP_STEPS],
};

/**
 * Production Guard of the Sales 0.5.11 CANDIDATE line (W3.1R): the full setup line plus the guard sources. It is
 * not registered as a built-in adapter — registration and adoption belong to a later activation gate; a fixture
 * adapter may inject it to exercise os_commit. The template ships the index empty, which grants no production.
 */
export const SALES_PRODUCTION_GUARD_0511: ProductionGuardSpec = {
  schemaVersion: "SALES_GUARD_INDEX/1",
  indexParentTitle: "01 — CONSTITUTION & POLICIES",
  decisionRules: { parentTitle: "03 — CONTROL PLANE", databaseTitle: "Decision Rules" },
  runtimeConfiguration: { parentTitle: "02 — SETUP & BUSINESS CONFIG", databaseTitle: "Runtime Configuration" },
  pointer: { resourceKey: "SALES:BUSINESS_CONFIG", naturalKeyProperty: "Config Item", valueField: "Value" },
  staticSources: ["SALES:BUSINESS_CONFIG"],
};

export const SALES_CONTROL_PLANE_0511_CANDIDATE: ControlPlaneGrammar = {
  ...SALES_CONTROL_PLANE_056,
  independentConfigurationResourceKey: "SALES:BUSINESS_CONFIG",
  productionGuard: SALES_PRODUCTION_GUARD_0511,
};

/** W4.3 / W4.3R: distinct, server-derived event records; historical grammars stay untouched. */
export const EXTERNAL_INTERACTION_PROPERTIES = {
  Interaction: "title", "Event Key": "rich_text", Provider: "select", "Source Identity": "rich_text",
  "Event ID": "rich_text", "Thread ID": "rich_text", "Occurred At": "rich_text", "Receipt Key": "rich_text",
  Accounts: "relation", Contacts: "relation",
} as const;
export const EXTERNAL_RECEIPT_PROPERTIES = {
  Receipt: "title", "Idempotency Key": "rich_text", "Event Type": "select", Provider: "select",
  "Source Identity": "rich_text", "Event ID": "rich_text", "Thread ID": "rich_text", "Occurred At": "rich_text",
  "Observed At": "rich_text", "Evidence Ref": "rich_text", "Interaction Key": "rich_text", "Intent Ref": "rich_text",
  Provenance: "select", "Effect Status": "select", Verified: "checkbox",
} as const;
export const EXTERNAL_RECEIPT_OPTIONS = { Provider: ["GMAIL"], "Event Type": ["GMAIL_SEND"],
  Provenance: ["SOURCE_ATTESTED_BY_NATIVE_READ"], "Effect Status": ["ATTESTED_SENT"] } as const;
export const SALES_CONTROL_PLANE_0513_CANDIDATE: ControlPlaneGrammar = {
  ...SALES_CONTROL_PLANE_0511_CANDIDATE,
  localAnswerSources: ["CHAT_USER_EXPLICIT", "AGENT_PROPOSED_USER_VALIDATED"],
  installContract: {
    connectorCapabilities: SALES_CONTROL_PLANE_0511_CANDIDATE.installContract?.connectorCapabilities ?? [],
    physicalResources: [
      ...(SALES_CONTROL_PLANE_0511_CANDIDATE.installContract?.physicalResources ?? []).map((r) => r.key === "RECEIPTS"
        ? { ...r, requiredProperties: EXTERNAL_RECEIPT_PROPERTIES, requiredSelectOptions: EXTERNAL_RECEIPT_OPTIONS } : r),
      { key: "INTERACTIONS", objectType: "DATABASE", path: ["04 — DATA & EVIDENCE", "Interactions"], required: true,
        registryKey: "INTERACTIONS", requiredProperties: EXTERNAL_INTERACTION_PROPERTIES, requiredSelectOptions: { Provider: ["GMAIL"] } },
    ],
  },
  resources: {
    ...SALES_CONTROL_PLANE_0511_CANDIDATE.resources,
    // Same physical Manifest; no schema migration and no caller-selected identity writer.
    "SALES:SOURCE_IDENTITY": { parentTitle: "00 — BOOT & INSTANCE", databaseTitle: "Instance Manifest",
      naturalKeyProperty: "Name", operations: ["UPDATE"], backendDerivedOnly: true,
      writableProperties: ["Gmail Identity"], protectedProperties: ["Name"], redactValues: true },
    "SALES:INTERACTIONS": { parentTitle: "04 — DATA & EVIDENCE", databaseTitle: "Interactions", naturalKeyProperty: "Event Key",
      naturalKeyIsIdentity: true, operations: ["CREATE"], backendDerivedOnly: true, writableProperties: Object.keys(EXTERNAL_INTERACTION_PROPERTIES), redactValues: true },
    "SALES:RECEIPTS": { parentTitle: "03 — CONTROL PLANE", databaseTitle: "Receipts", naturalKeyProperty: "Idempotency Key",
      naturalKeyIsIdentity: true, operations: ["CREATE"], backendDerivedOnly: true, writableProperties: Object.keys(EXTERNAL_RECEIPT_PROPERTIES), redactValues: true },
  },
};

/** W6.5b: candidate only, exact graph contract; no adopted runtime or physical schema change. */
export const SALES_CONTROL_PLANE_0514_CANDIDATE: ControlPlaneGrammar = {
  ...SALES_CONTROL_PLANE_0513_CANDIDATE,
  cursorTransitions: [...(SALES_CONTROL_PLANE_0513_CANDIDATE.cursorTransitions ?? []), {
    key: "B7_DRY_RUN_TO_READY", fromGate: "B7_DRY_RUN",
    evidence: { kind: "B7_GRAPH", logicalResourceKey: "SALES:BUSINESS_CONFIG", naturalKey: "B7_DRY_RUN:WORKSET",
      equals: { Category: "OTHER", State: "CONFIRMED", Version: "SALES_DRY_RUN_WORKSET/1", Source: "CHAT_USER_EXPLICIT" }, nonEmpty: ["Value"] },
    targetResourceKey: "SALES:OS_STATE", targetNaturalKey: "CURRENT",
    set: { "Current Gate": "READY", "Build State": "READY", "Current Gate Status": "PASS", "Last Durable Mode": "COMMIT",
      "Next Authorized Topic": "GO", "Next Action": "Reprendre les réponses humaines et les engagements dus ; préparer les prochaines actions dans l'autorité actuelle",
      "Next Question": "Qu'est-ce qui attend ton intervention aujourd'hui ?", "Persistence Health": "PASS", "Recovery Required": false },
    carryForward: { "Gate Passed By Run Ref": "lastRunRef" }, runReferenceProperties: ["Last Run Ref"],
    stampedProperties: ["Last Required Written At", "Last Verified At"], clearWhenUnblocked: ["Open Blocker"],
  }],
};

/**
 * SALES control plane of the CANDIDATE 0.6 line (PV-GTM-002 / W04). It is the 0.5 grammar plus the GTM resource
 * catalog. It is reached only by a runtime whose own Manifest pins the candidate contract, so a 0.5 runtime
 * addresses none of these resources and behaves exactly as before.
 *
 * Guarantees encoded in the catalog itself, before any validator runs:
 *  - an exposure, an attribution, a coverage declaration, an input revision and a metric snapshot are CREATE-only:
 *    history is append-only and a stated fact is never overwritten;
 *  - every natural key and every control-owned field is protected from `desired_changes`;
 *  - every GTM resource is value-redacted: no offer, price or contact value reaches an envelope or a log;
 *  - no GTM resource is externally effective: nothing here can send anything.
 */
export const SALES_CONTROL_PLANE_06: ControlPlaneGrammar = {
  ...SALES_CONTROL_PLANE_05,
  installContract: {
    physicalResources: [
      ...(SALES_CONTROL_PLANE_05.installContract?.physicalResources ?? []).map((resource) => resource.key === "OS_STATE"
        ? { ...resource, requiredProperties: { ...(resource.requiredProperties ?? {}), "Operating Mode": "rich_text" } }
        : resource),
      ...GTM_PHYSICAL_RESOURCES,
    ],
    connectorCapabilities: [
      ...(SALES_CONTROL_PLANE_05.installContract?.connectorCapabilities ?? []),
      { key: "GOOGLE_CALENDAR", requirement: "REQUIRED", competentSource: "GOOGLE_CALENDAR" },
    ],
  },
  stateCursor: { ...(SALES_CONTROL_PLANE_05.stateCursor ?? {}), operatingModes: "Operating Mode" },
  capabilityProofsDatabaseTitle: "Capability Profile",
  capabilityProofProps: {
    title: "Capability Proof", proofKey: "Capability Proof Key", capabilityKey: "Capability Key", state: "State",
    runtimeId: "Runtime ID", principalKey: "Principal Key", operatingMode: "Operating Mode",
    competentSource: "Competent Source", evidenceRef: "Evidence Ref", verifiedAt: "Verified At", scope: "Scope",
  },
  resources: {
    ...(SALES_CONTROL_PLANE_05.resources ?? {}),
    "SALES:CAPABILITY_PROOFS": {
      parentTitle: "03 — CONTROL PLANE", databaseTitle: "Capability Profile", naturalKeyProperty: "Capability Proof Key",
      operations: ["CREATE"], protectedProperties: ["Capability Proof Key"],
    },
    "SALES:CAMPAIGNS": { parentTitle: "04 — GTM", databaseTitle: "Campaigns", naturalKeyProperty: "Campaign Key", operations: ["CREATE", "UPDATE", "UPSERT"], protectedProperties: ["Campaign Key"], createDefaults: { Status: "ACTIVE" }, redactValues: true },
    "SALES:APPROACH_VERSIONS": { parentTitle: "04 — GTM", databaseTitle: "Approach Versions", naturalKeyProperty: "Approach Version Key", operations: ["CREATE", "UPDATE"], protectedProperties: ["Approach Version Key"], redactValues: true },
    "SALES:PARTICIPATIONS": { parentTitle: "04 — GTM", databaseTitle: "Participations", naturalKeyProperty: "Participation Key", operations: ["CREATE", "UPDATE"], protectedProperties: ["Participation Key"], redactValues: true },
    "SALES:ENROLLMENTS": { parentTitle: "04 — GTM", databaseTitle: "Enrollments", naturalKeyProperty: "Enrollment Key", operations: ["CREATE", "UPDATE"], protectedProperties: ["Enrollment Key"], createDefaults: { State: "ACTIVE" }, redactValues: true },
    "SALES:EXPOSURES": { parentTitle: "04 — GTM", databaseTitle: "Exposures", naturalKeyProperty: "Exposure Key", operations: ["CREATE"], protectedProperties: ["Exposure Key"], redactValues: true },
    "SALES:MEETING_EPISODES": { parentTitle: "04 — GTM", databaseTitle: "Meeting Episodes", naturalKeyProperty: "Meeting Episode ID", operations: ["CREATE", "UPDATE"], protectedProperties: ["Meeting Episode ID"], redactValues: true },
    "SALES:REPLY_ATTRIBUTIONS": { parentTitle: "04 — GTM", databaseTitle: "Reply Attributions", naturalKeyProperty: "Reply Attribution Key", operations: ["CREATE"], protectedProperties: ["Reply Attribution Key"], redactValues: true },
    "SALES:GTM_COVERAGE": { parentTitle: "04 — GTM", databaseTitle: "Coverage Declarations", naturalKeyProperty: "Coverage Key", operations: ["CREATE"], protectedProperties: ["Coverage Key"], redactValues: true },
    "SALES:GTM_INPUT_REVISIONS": { parentTitle: "04 — GTM", databaseTitle: "Input Revisions", naturalKeyProperty: "Input Revision ID", operations: ["CREATE"], protectedProperties: ["Input Revision ID"], redactValues: true },
    "SALES:GTM_SNAPSHOTS": { parentTitle: "04 — GTM", databaseTitle: "Metric Snapshots", naturalKeyProperty: "Snapshot Key", operations: ["CREATE"], protectedProperties: ["Snapshot Key"], redactValues: true },
  },
};

/** The GTM resources of the candidate catalog, in canonical order. Read selection and validation use this list. */
export const GTM_RESOURCE_KEYS: readonly string[] = [
  "SALES:CAPABILITY_PROOFS",
  "SALES:CAMPAIGNS", "SALES:APPROACH_VERSIONS", "SALES:PARTICIPATIONS", "SALES:ENROLLMENTS",
  "SALES:EXPOSURES", "SALES:MEETING_EPISODES", "SALES:REPLY_ATTRIBUTIONS", "SALES:GTM_COVERAGE",
  "SALES:GTM_INPUT_REVISIONS", "SALES:GTM_SNAPSHOTS",
];

/** Append-only GTM resources: a row of these is never updated, so a historical fact cannot be rewritten. */
export const GTM_APPEND_ONLY_KEYS: readonly string[] = [
  "SALES:CAPABILITY_PROOFS",
  "SALES:EXPOSURES", "SALES:REPLY_ATTRIBUTIONS", "SALES:GTM_COVERAGE", "SALES:GTM_INPUT_REVISIONS", "SALES:GTM_SNAPSHOTS",
];
