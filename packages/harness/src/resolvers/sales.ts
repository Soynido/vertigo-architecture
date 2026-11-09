/**
 * SALES resolver (PV0-004): authenticated principal → authorized SALES identity → backend registry
 * discovery → physical root → canonical Manifest (ROOT → exact canonical parent → CURRENT, never by
 * global search) → template/non-instance rejection → principal ↔ owner verification → version pins →
 * runtime generation. The caller never selects a rep, runtime or root; display names never authorize.
 */
import type { Principal } from "../auth/principal.ts";
import { runtimeGeneration } from "../binding/handle.ts";
import { listAllChildren, type NotionReadClient } from "../notion/readClient.ts";
import { childPageTitle, normalizeId, plainText, propMentions, propText, versionTokens, type Block, type Page, type RichText } from "../notion/shapes.ts";
import type { Epistemic } from "../tools/envelope.ts";
import type { SalesRuntimeRegistry } from "../registry/salesRuntimes.ts";
import type { SalesContractAdapter } from "../versions/adapters/sales.ts";
import type { AdapterRegistry, ClassifiedVersion, SalesRuntimeAdapter } from "../versions/registry.ts";
import type { ObservedPins, ResolutionHoldCode, ResolutionOutcome, ResolvedRuntime, RuntimeResolver } from "./types.ts";

const UNKNOWN: Epistemic = "UNKNOWN";
const NOT_APPLICABLE: Epistemic = "NOT_APPLICABLE";

interface DatabaseObject { readonly id: string; readonly title?: readonly RichText[]; readonly data_sources?: ReadonlyArray<{ readonly id: string; readonly name?: string }> }
interface QueryResult { readonly results: readonly Page[] }

function hold(code: ResolutionHoldCode, evidence: string[]): ResolutionOutcome {
  return { kind: "HOLD", code, evidence };
}

function childDatabaseTitle(block: Block): string | undefined {
  if (block.type !== "child_database") return undefined;
  return (block["child_database"] as { title?: string } | undefined)?.title;
}

export class SalesRuntimeResolver implements RuntimeResolver {
  readonly #notion: NotionReadClient;
  readonly #principal: Principal;
  readonly #project: string;
  readonly #registry: SalesRuntimeRegistry;
  readonly #adapters: AdapterRegistry<SalesRuntimeAdapter>;

  constructor(notion: NotionReadClient, principal: Principal, project: string, registry: SalesRuntimeRegistry, adapters: AdapterRegistry<SalesRuntimeAdapter>) {
    this.#notion = notion;
    this.#principal = principal;
    this.#project = project;
    this.#registry = registry;
    this.#adapters = adapters;
  }

  async resolve(): Promise<ResolutionOutcome> {
    // 1. Authorized SALES identity comes from the backend principal, never from arguments.
    const repKey = this.#principal.rep_identity_key;
    if (!repKey) return hold("HOLD_RUNTIME_NOT_FOUND", ["existence=UNKNOWN", `principal ${this.#principal.principal_id} has no rep_identity_key; no SALES runtime can be discovered`]);

    // 2. Backend registry discovery: three explicit existence states.
    const entry = await this.#registry.lookup(repKey);
    if (!entry) return hold("HOLD_RUNTIME_NOT_FOUND", ["existence=UNKNOWN", `no registry entry for rep identity ${repKey}; discovery found nothing and nonexistence is not proven`]);
    if (entry.operation_policy !== undefined && entry.operation_policy !== "LEGACY_READ_ONLY")
      return hold("HOLD_UNKNOWN_REQUIRED_FACT", ["unsupported backend operation policy; no business fallback"]);
    if (entry.status === "NOT_YET_CREATED") return hold("HOLD_RUNTIME_NOT_YET_CREATED", ["existence=NOT_YET_CREATED", `registry declares the runtime for ${repKey} as not yet created${entry.note ? `: ${entry.note}` : ""}`]);
    const rootId = normalizeId(entry.root_ref);
    if (!rootId) return hold("HOLD_BOOTSTRAP_DISCOVERY", [`registry entry for ${repKey} is KNOWN but has no usable root_ref`]);

    // 3. Physical root.
    let root: Page;
    try {
      root = (await this.#notion.retrievePage(rootId)) as Page;
    } catch (err) {
      return hold("HOLD_RUNTIME_NOT_FOUND", ["existence=NOT_FOUND", `registry root ${rootId} is unreadable/missing: ${(err as Error).message}`]);
    }
    if (root.archived || root.in_trash) return hold("HOLD_RUNTIME_NOT_FOUND", ["existence=NOT_FOUND", `registry root ${rootId} is archived`]);
    const rootTitle = Object.values(root.properties).map((p) => (p.type === "title" ? plainText((p as { title: readonly RichText[] }).title) : "")).join("").trim();

    // 4. Canonical Manifest: ROOT → BOOT page → Manifest database → CURRENT row. Never by global search.
    //    The grammar comes from the adapter, but the adapter is keyed by the Manifest's own contract pin,
    //    so bootstrap addressing uses the titles every supported line shares; the pin is checked in step 6.
    const bootstrap = this.#adapters.supported().map((v) => this.#adapters.resolve(v) as SalesContractAdapter).filter(Boolean);
    if (bootstrap.length === 0) return hold("HOLD_UNSUPPORTED_GOVERNING_VERSION", ["no SALES adapters registered"]);
    const bootTitles = new Set(bootstrap.map((a) => a.grammar.bootTitle));
    const manifestDbTitles = new Set(bootstrap.map((a) => a.grammar.manifestDatabaseTitle));
    const currentTitles = new Set(bootstrap.map((a) => a.grammar.currentRowTitle));

    let rootChildren: readonly Block[];
    try {
      rootChildren = await listAllChildren(this.#notion, rootId);
    } catch (err) {
      return hold("HOLD_BOOTSTRAP_DISCOVERY", [`root children unreadable: ${(err as Error).message}`]);
    }
    const bootPages = rootChildren.filter((b) => bootTitles.has((childPageTitle(b) ?? "").trim()));
    if (bootPages.length !== 1) return hold("HOLD_BOOTSTRAP_DISCOVERY", [`expected exactly one BOOT page (${[...bootTitles].join(" | ")}) under root ${rootId}, found ${bootPages.length}`]);
    const bootId = normalizeId((bootPages[0] as Block).id) as string;

    let bootChildren: readonly Block[];
    try {
      bootChildren = await listAllChildren(this.#notion, bootId);
    } catch (err) {
      return hold("HOLD_BOOTSTRAP_DISCOVERY", [`BOOT children unreadable: ${(err as Error).message}`]);
    }
    const manifestDbs = bootChildren.filter((b) => manifestDbTitles.has((childDatabaseTitle(b) ?? "").trim()));
    if (manifestDbs.length !== 1) return hold("HOLD_BOOTSTRAP_DISCOVERY", [`expected exactly one Manifest database under BOOT, found ${manifestDbs.length}`]);
    const manifestDbId = normalizeId((manifestDbs[0] as Block).id) as string;

    let db: DatabaseObject;
    try {
      db = (await this.#notion.retrieveDatabase(manifestDbId)) as DatabaseObject;
    } catch (err) {
      return hold("HOLD_BOOTSTRAP_DISCOVERY", [`Manifest database unreadable: ${(err as Error).message}`]);
    }
    const dataSources = db.data_sources ?? [];
    if (dataSources.length !== 1) return hold("HOLD_RUNTIME_AMBIGUOUS", [`Manifest database has ${dataSources.length} data sources; expected exactly one`]);
    const dsId = normalizeId((dataSources[0] as { id: string }).id) as string;

    let rows: readonly Page[];
    try {
      const q = (await this.#notion.queryDataSource(dsId, { or: [...currentTitles].map((t) => ({ property: "title", title: { equals: t } })) })) as QueryResult;
      rows = q.results.filter((p) => !p.archived && !p.in_trash);
    } catch (err) {
      return hold("HOLD_BOOTSTRAP_DISCOVERY", [`Manifest query failed: ${(err as Error).message}`]);
    }
    // Defensive: filter by the canonical row title client-side too (fixtures may ignore filters).
    const currentRows = rows.filter((p) => currentTitles.has(titleOf(p).trim()));
    if (currentRows.length === 0) return hold("HOLD_BOOTSTRAP_DISCOVERY", ["existence=NOT_FOUND", `no ${[...currentTitles].join("/")} row in the canonical Manifest database ${manifestDbId}`]);
    if (currentRows.length > 1) return hold("HOLD_RUNTIME_AMBIGUOUS", [`${currentRows.length} canonical Manifest rows found; HOLD, never guess`]);
    const manifest = currentRows[0] as Page;
    const manifestId = normalizeId(manifest.id) as string;

    // 5. Adapter from the Manifest's own contract pin (governing for this runtime), schema must be supported.
    const contractPin = firstText(manifest, bootstrap.map((a) => a.grammar.manifestProps.contractVersion));
    const schemaPin = firstText(manifest, bootstrap.map((a) => a.grammar.manifestProps.schemaVersion));
    if (!contractPin) return hold("HOLD_VERSION_RESOLUTION", ["Manifest has no Sales contract version pin"]);
    const adapter = this.#adapters.resolve(contractPin) as SalesContractAdapter | undefined;
    if (!adapter) return hold("HOLD_UNSUPPORTED_GOVERNING_VERSION", [`Manifest contract ${contractPin} has no adapter; supported: ${this.#adapters.supported().join(", ")}`]);
    if (!schemaPin || !adapter.supportedSchemas.includes(schemaPin)) return hold("HOLD_UNSUPPORTED_GOVERNING_VERSION", [`Manifest schema ${schemaPin ?? "UNKNOWN"} is not supported by the ${adapter.contractVersion} adapter`]);
    if (entry.operation_policy === "LEGACY_READ_ONLY" && (entry.status !== "KNOWN"
      || !adapter.legacyReadBridgeSchema || schemaPin !== adapter.legacyReadBridgeSchema))
      return hold("HOLD_UNSUPPORTED_GOVERNING_VERSION", ["legacy read requires its actual 0.5.0 pins; it cannot force a version"]);
    const g = adapter.grammar;

    // 6. Template / non-instance / provisioning classification. A MASTER/template root is never installable. A
    // non-template clone enters INSTALL_ONLY only through an explicit backend INSTALL_PENDING assignment; KNOWN is
    // deliberately insufficient. No chat-supplied root, copied Registry row or display-name lookup participates.
    const instanceId = propText(manifest, g.manifestProps.instanceId)?.trim() ?? "";
    const owner = propText(manifest, g.manifestProps.owner)?.trim() ?? "";
    const installState = propText(manifest, g.manifestProps.installState)?.trim() ?? "";
    const instanceStatus = propText(manifest, g.manifestProps.instanceStatus)?.trim() ?? "";
    const templateEvidence: string[] = [];
    const instanceIsTemplate = g.template.instanceIdPattern.test(instanceId);
    const rootIsTemplate = g.template.rootTitlePattern.test(rootTitle);
    const unbound = installState.toUpperCase() === g.template.unboundInstallState;
    if (instanceIsTemplate) templateEvidence.push(`Instance ID "${instanceId}" is a template marker`);
    if (rootIsTemplate) templateEvidence.push(`root title "${rootTitle}" is the MASTER/template, not an assigned clone`);
    if (!owner && unbound) templateEvidence.push(`Manifest has no owner and Install State ${installState}`);
    if (instanceStatus.toUpperCase() === g.retiredInstanceStatus) return hold("HOLD_BOOTSTRAP_DISCOVERY", [`runtime ${instanceId} is ${instanceStatus}; a replacement must be registered`]);
    if (!instanceId) return hold("HOLD_UNKNOWN_REQUIRED_FACT", ["Manifest has no Instance ID"]);

    const assignedInstanceId = entry.expected_instance_id?.trim() ?? "";
    const provisioning = entry.status === "INSTALL_PENDING";
    if (rootIsTemplate) return hold("HOLD_RUNTIME_TEMPLATE_NOT_INSTANCE", [...templateEvidence, "a provisioning assignment can never target the MASTER/template root"]);
    if (provisioning && (!assignedInstanceId || g.template.instanceIdPattern.test(assignedInstanceId))) {
      return hold("HOLD_UNKNOWN_REQUIRED_FACT", ["INSTALL_PENDING requires a non-template expected_instance_id in the backend registry"]);
    }
    let installOnly = false;
    if (provisioning) {
      // Backend authority remains INSTALL_ONLY for the whole provisioning transaction, including an intermediate
      // Manifest already written to SETUP. Notion alone can never promote authority; FINAL proof performs the
      // registry CAS to KNOWN and bumps pointer_generation.
      if (instanceId !== assignedInstanceId && !instanceIsTemplate) return hold("HOLD_RUNTIME_MANIFEST_MISMATCH", [`INSTALL_PENDING clone carries instance id ${instanceId}; expected template marker or assigned id ${assignedInstanceId}`]);
      if (owner && owner !== (this.#principal.display_name ?? "")) return hold("HOLD_RUNTIME_MANIFEST_MISMATCH", ["INSTALL_PENDING clone carries an owner different from the assigned principal"]);
      if (!unbound && installState.toUpperCase() !== "SETUP") return hold("HOLD_RUNTIME_MANIFEST_MISMATCH", [`INSTALL_PENDING clone has unsupported Install State ${installState || "UNKNOWN"}`]);
      installOnly = true;
    } else if (unbound || instanceIsTemplate || !owner) {
      return hold("HOLD_RUNTIME_TEMPLATE_NOT_INSTANCE", [...templateEvidence, "only an UNBOUND, explicitly INSTALL_PENDING clone may enter the installer"]);
    }

    // 7. Self-consistency. A normal instance must already point back at the selected root. A registry-assigned
    // UNBOUND clone is allowed to carry the copied template URL because replacing it is precisely the INSTALL
    // transaction; the selected root still comes only from backend configuration.
    const manifestRootId = normalizeId(propText(manifest, g.manifestProps.rootUrl));
    if (manifestRootId !== rootId && !installOnly) return hold("HOLD_RUNTIME_MANIFEST_MISMATCH", [`registry root ${rootId} != Manifest ${g.manifestProps.rootUrl} ${manifestRootId ?? "UNKNOWN"}`]);

    // 8. Principal ↔ owner mapping: only registry-declared identity claims count. Names never authorize.
    const gmail = propText(manifest, g.manifestProps.gmailIdentity)?.trim().toLowerCase() ?? "";
    const claims: string[] = [];
    const failures: string[] = [];
    if (installOnly) {
      claims.push("registry_install_assignment");
    } else if (entry.expected_instance_id) {
      claims.push("instance_id");
      if (entry.expected_instance_id !== instanceId) failures.push(`instance id ${instanceId} != registry expectation for ${repKey}`);
    }
    if (!installOnly && entry.expected_gmail_identity) {
      claims.push("gmail_identity");
      if (entry.expected_gmail_identity.toLowerCase() !== gmail) failures.push(`Gmail identity ${gmail || "UNKNOWN"} != registry expectation for ${repKey}`);
    }
    if (claims.length === 0) return hold("HOLD_UNKNOWN_REQUIRED_FACT", [`owner mapping for ${repKey} cannot be verified: registry declares no identity claim (expected_instance_id / expected_gmail_identity)`]);
    if (failures.length > 0) return hold("HOLD_RUNTIME_MANIFEST_MISMATCH", ["owner_mapping_failed", ...failures]);

    // 9. Version pins (governing for this runtime = its pinned published contract; candidates live in META).
    const contractUrlId = normalizeId(propText(manifest, g.manifestProps.contractUrl));
    const warnings: string[] = [];
    let contractEvidence = `${manifestId}#${g.manifestProps.contractVersion}`;
    let governingContractRef: ResolvedRuntime["governing_contract_ref"];
    // Never dereference copied pointers while installing. The governing pin is read from the canonical Manifest,
    // but every copied URL and Last Run pointer remains quarantined until SETUP and a fresh business binding.
    if (!installOnly && contractUrlId) {
      try {
        const contract = (await this.#notion.retrievePage(contractUrlId)) as Page;
        if (typeof contract.id !== "string" || contract.id.replace(/-/g, "").toLowerCase() !== contractUrlId || contract.archived || contract.in_trash) throw new Error("contract metadata does not identify an active canonical page");
        const contractTitle = titleOf(contract);
        if (!versionTokens(contractTitle).includes(contractPin)) return hold("HOLD_VERSION_RESOLUTION", [`published contract page "${contractTitle}" does not carry the pinned version ${contractPin}`]);
        contractEvidence = `${contractUrlId}:${contractTitle}`;
        governingContractRef = { page_ref: contractUrlId, version: contractPin };
      } catch (err) {
        warnings.push(`contract_page_unreadable: ${contractUrlId} (${(err as Error).message})`);
      }
    } else if (!installOnly) {
      warnings.push("contract_url_missing_on_manifest");
    }
    const pin = (name: string): string | Epistemic => propText(manifest, name)?.trim() || UNKNOWN;
    const manifestPins: ObservedPins = { ref: manifestId, spec: contractPin, schema: schemaPin, control: NOT_APPLICABLE };
    const historical: ObservedPins[] = [];
    for (const runId of installOnly ? [] : propMentions(manifest, g.manifestProps.lastRunRef)) {
      try {
        const run = (await this.#notion.retrievePage(runId)) as Page;
        historical.push({ ref: runId, spec: propText(run, g.manifestProps.contractVersion)?.trim() || UNKNOWN, schema: propText(run, g.manifestProps.schemaVersion)?.trim() || UNKNOWN, control: NOT_APPLICABLE, status: propText(run, "Status")?.trim() || UNKNOWN });
      } catch (err) {
        warnings.push(`last_run_unreadable: ${runId} (${(err as Error).message})`);
        historical.push({ ref: runId, spec: UNKNOWN, schema: UNKNOWN, control: NOT_APPLICABLE, status: UNKNOWN });
      }
    }
    const historicalPins: ClassifiedVersion[] = historical.flatMap((h) => [h.spec, h.schema].filter((v): v is string => v !== UNKNOWN && v !== NOT_APPLICABLE).map((v) => ({ value: v, klass: "HISTORICAL_PIN" as const, evidence_ref: h.ref })));

    // 10. Runtime generation.
    const resolvedInstanceId = installOnly ? assignedInstanceId : instanceId;
    const logicalKey = `${this.#project}/SALES/${repKey}`;
    const generation = runtimeGeneration({ logicalKey, rootId, manifestId,
      pointerGeneration: entry.operation_policy ? `${entry.pointer_generation ?? "NOT_APPLICABLE"}|${entry.operation_policy}` : entry.pointer_generation });

    return {
      kind: "RESOLVED",
      runtime: {
        ...(entry.operation_policy ? { operation_policy: entry.operation_policy } : {}),
        access_mode: installOnly ? "INSTALL_ONLY" : "BUSINESS",
        lane: "SALES",
        logical_key: logicalKey,
        runtime_id: resolvedInstanceId,
        root_ref: rootId,
        manifest_ref: manifestId,
        locator_ref: `registry:${repKey}`,
        pointer_generation: entry.pointer_generation ?? NOT_APPLICABLE,
        runtime_generation: generation,
        lifecycle_state: installOnly ? "UNBOUND" : installState || UNKNOWN,
        owner_display: installOnly ? this.#principal.display_name ?? UNKNOWN : owner || UNKNOWN,
        versions: {
          governing_spec: { value: contractPin, klass: "GOVERNING", evidence_ref: contractEvidence },
          governing_schema: { value: schemaPin, klass: "GOVERNING", evidence_ref: `${manifestId}#${g.manifestProps.schemaVersion}` },
          governing_control: "UNKNOWN" as const,
          candidates: [],
          historical_pins: historicalPins,
        },
        manifest_pins: manifestPins,
        historical_pins: historical,
        adopted_records: [],
        observations: {
          registry_status: entry.status,
          ...(entry.operation_policy ? { operation_policy: entry.operation_policy } : {}),
          rep_identity_key: repKey,
          ownership_claims_verified: claims,
          // Backend-derived only (SALES_RUNTIME_REGISTRY_FILE). There is no tool argument, no Notion property and
          // no chat phrase that can set or override it; it is reported as a read-only observation or NOT_APPLICABLE.
          objective_package_ref: entry.objective_package_ref ?? NOT_APPLICABLE,
          ...(installOnly ? {
            binding_mode: "INSTALL_ONLY",
            manifest_instance_id: instanceId,
            copied_manifest_root: manifestRootId ?? UNKNOWN,
            registry_expected_instance_id: assignedInstanceId,
          } : {}),
          mailbox_identity: gmail || UNKNOWN,
          registry_expected_gmail_identity: entry.expected_gmail_identity ?? UNKNOWN,
          source_identity_enrollment: entry.source_identity_enrollment ?? [],
          instance_status: instanceStatus || UNKNOWN,
          strategy_version: pin(g.manifestProps.strategyVersion),
          toolkit_version: pin(g.manifestProps.toolkitVersion),
          authority_version: pin(g.manifestProps.authorityVersion),
          manifest_last_edited_time: manifest.last_edited_time ?? UNKNOWN,
          adapter: adapter.contractVersion,
        },
        warnings,
        ...(governingContractRef ? { governing_contract_ref: governingContractRef } : {}),
        adapter: { version: adapter.contractVersion, controlPlane: adapter.grammar.controlPlane, capabilities: adapter.capabilities,
          ...(entry.operation_policy && adapter.legacyReadBridgeSchema ? { legacy_read_bridge_schema: adapter.legacyReadBridgeSchema } : {}) },
        ...(entry.snapshot ? { registry_snapshot: { ...entry.snapshot } } : {}),
      },
    };
  }
}

function titleOf(page: Page): string {
  for (const p of Object.values(page.properties)) if (p.type === "title") return plainText((p as { title: readonly RichText[] }).title);
  return "";
}

function firstText(page: Page, names: readonly string[]): string | undefined {
  for (const n of names) {
    const v = propText(page, n)?.trim();
    if (v) return v;
  }
  return undefined;
}
