import type { z } from "zod";
import { authorize, type PrincipalRegistry } from "../auth/principal.ts";
import { lookupBinding, lookupPlan, type OwnershipFailure } from "../auth/ownership.ts";
import { finalPreconditionHold } from "../verify/engine.ts";
import { error, hold, type BindingSummary, type Envelope } from "./envelope.ts";
import { checkLaneScope } from "./lane.ts";
import type { Lane } from "./envelope.ts";
import { toolInputSchemas, type ToolName } from "./surface.ts";
import type { BackendStore } from "../store/memory.ts";
import type { HarnessConfig } from "../config/index.ts";
import type { NotionReadClient } from "../notion/readClient.ts";
import { StructureCache } from "../notion/structureCache.ts";
import type { AdapterRegistries } from "../versions/registry.ts";
import type { BindingRecord } from "../binding/store.ts";
import type { SalesRuntimeRegistry } from "../registry/salesRuntimes.ts";
import { MetaRuntimeResolver } from "../resolvers/meta.ts";
import { SalesRuntimeResolver } from "../resolvers/sales.ts";
import type { ResolutionOutcome, ResolvedRuntime } from "../resolvers/types.ts";
import type { HoldCode } from "../errors/codes.ts";
import { checkLiveness, createBinding } from "../binding/service.ts";
import { OS_BIND_CODES } from "./bindContract.ts";
import { withUserSentence } from "./messages.fr.ts";
import { withConduct } from "./conduct.ts";
import { runtimeScope } from "./scope.ts";
import { rehydrate } from "../resume/engine.ts";
import { buildContractPack, normalizeTopicHint } from "../contractPack/pack.ts";
import { readSetupSources } from "../contractPack/setupSources.ts";
import { readDailySources } from "../contractPack/dailySources.ts";
import { readMetaOperatingContext } from "../contractPack/metaOperatingContext.ts";
import { readExternalActionSources } from "../contractPack/externalActionSources.ts";
import { readGoverningContract } from "../contractPack/governingContract.ts";
import { readLocalOperatingDocuments } from "../contractPack/localOperatingDocuments.ts";
import { readLocalBusinessConfiguration } from "../contractPack/localBusinessConfiguration.ts";
import { ok } from "./envelope.ts";
import { inspectInstallBootstrap, installManifestTemplate, isInstallOnlyBinding, mappingIntentTemplate } from "../install/bootstrap.ts";
import { finalizePromotionAfterRebind, hasFinalizedInstallMapping, isInstallMappingPlan, isInstallPromotionPlan, prepareInstall, resumeInstallContinuation, verifyInstallMappingFinal, verifyInstallPromotionFinal, verifyInstallTarget } from "../install/plan.ts";
import type { Intent } from "../plans/prepare.ts";
import { deriveCapabilityRemediation, issueCapabilityChallenge } from "../resume/capabilityRemediation.ts";

export interface CallContext {
  /** Authenticated principal id resolved by the transport layer, never from tool arguments. */
  readonly principal_id: string | undefined;
  readonly now?: Date;
  /** Five-tool server route only; not a tool argument. Historical dispatch stays read-only. */
  readonly candidate_resume?: true;
  /** Internal first-bind owner snapshot only; cannot be requested through tool arguments. */
  readonly readonly_initial_read?: true;
}

export interface HarnessDeps {
  readonly nativeNotePilot?: import("../verify/nativeNoteControl.ts").NativeNoteControl;
  readonly nativeDirectionPilot?: import("../verify/nativeDirectionControl.ts").NativeDirectionControl;
  readonly nativeMetaControl?: import("../verify/nativeMetaControl.ts").NativeMetaControl;
  readonly nativeSalesControl?: import("../verify/nativeSalesControl.ts").NativeSalesControl;
  readonly nativeSalesControls?: readonly import("../verify/nativeSalesControl.ts").NativeSalesControl[];
  readonly realDirectionControl?: import("../verify/realDirectionControl.ts").RealDirectionControl;
  readonly config: HarnessConfig;
  /** Read-only competent source for the Gmail effect plane (a live adapter or a captured snapshot); absent ⇒ Gmail-dependent decisions HOLD. */
  readonly competentSource?: import("../effects/gmail.ts").CompetentSource;
  readonly principals: PrincipalRegistry;
  readonly store: BackendStore;
  readonly notion: NotionReadClient;
  readonly adapters: AdapterRegistries;
  readonly salesRegistry: SalesRuntimeRegistry;
}

type Input<T extends ToolName> = z.infer<(typeof toolInputSchemas)[T]>;
export type Handler<T extends ToolName> = (input: Input<T>, ctx: CallContext, deps: HarnessDeps) => Promise<Envelope>;

const NOT_YET = (ticket: string) => error("ERROR_NOT_IMPLEMENTED", `delivered by ${ticket}`, "wait for the implementing ticket; do not claim any durable effect");

/** Not-yet-implemented tail that still discloses the (owned, live) binding and freshly resolved runtime identity. */
function notYet(ticket: string, binding: BindingRecord, runtime: ResolvedRuntime) {
  return error("ERROR_NOT_IMPLEMENTED", `delivered by ${ticket}`, "wait for the implementing ticket; do not claim any durable effect", {
    binding: bindingSummary(binding),
    observations: { runtime_id: runtime.runtime_id, root_ref: runtime.root_ref, manifest_ref: runtime.manifest_ref, lifecycle_state: runtime.lifecycle_state, runtime_generation: runtime.runtime_generation },
  });
}

export function bindingSummary(b: BindingRecord): BindingSummary {
  return { project: b.project, lane: b.lane, binding_state: b.status, runtime_logical_key: b.runtime_logical_key, runtime_id: b.runtime_id, runtime_generation: b.runtime_generation, runtime_scope: runtimeScope(b.runtime_id) };
}

/** Summary of a freshly resolved runtime before any binding exists (binding_state UNKNOWN). */
export function resolvedSummary(project: string, r: ResolvedRuntime): BindingSummary {
  return { project, lane: r.lane, binding_state: "UNKNOWN", runtime_logical_key: r.logical_key, runtime_id: r.runtime_id, runtime_generation: r.runtime_generation, runtime_scope: runtimeScope(r.runtime_id) };
}

/** Resolve the real runtime for an authorized principal + lane. The caller never supplies a rep, runtime or root. */
export async function resolveRuntimeFor(deps: HarnessDeps, principal: import("../auth/principal.ts").Principal, project: string, lane: "META" | "SALES"): Promise<ResolutionOutcome> {
  if (lane === "META") return new MetaRuntimeResolver(deps.notion, deps.config.metaSpecRoot, project, deps.adapters.metaRuntime).resolve();
  return new SalesRuntimeResolver(deps.notion, principal, project, deps.salesRegistry, deps.adapters.salesRuntime).resolve();
}

/** Maps an ownership failure to the envelope the caller receives. Foreign handles never leak state. */
export function ownershipEnvelope(f: OwnershipFailure): Envelope {
  switch (f.reason) {
    case "AUTH_REQUIRED":
      return error("ERROR_AUTH_REQUIRED", "authenticated principal required", "authenticate, then call os_bind");
    case "UNKNOWN_HANDLE":
      return error("ERROR_INVALID_ARGUMENT", "unknown binding_handle", "call os_bind to obtain a handle for this principal");
    case "PRINCIPAL_MISMATCH":
      return error("ERROR_PRINCIPAL_MISMATCH", "binding does not belong to the authenticated principal", "call os_bind with your own principal; never reuse another user's handle");
    case "BINDING_NOT_BOUND":
      return hold("HOLD_BINDING_STALE", "call os_bind again to obtain a fresh binding", [`binding_state=${f.state}`]);
    case "PLAN_NOT_FOUND":
      return error("ERROR_PLAN_NOT_FOUND", "unknown plan_id", "call os_prepare to create a plan");
    case "PLAN_BINDING_MISMATCH":
      return hold("HOLD_PLAN_BINDING_MISMATCH", "use the binding that created the plan, or re-prepare", []);
    case "RECEIPT_NOT_FOUND":
    case "RECEIPT_PLAN_MISMATCH":
      return hold("HOLD_TARGET_RECEIPT_INVALID", "re-run os_verify(TARGET) for this plan", [f.reason]);
  }
}

/**
 * Common preflight for every handle-taking tool, in this order:
 *  1. ownership — the handle must belong to THIS principal (foreign handles learn nothing);
 *  2. liveness  — TTL, principal status, and a fresh runtime resolution whose generation must match.
 * Only then does the tool body run, with the freshly resolved runtime.
 */
async function withBinding(handle: string, ctx: CallContext, deps: HarnessDeps, body: (binding: BindingRecord, runtime: ResolvedRuntime) => Promise<Envelope>): Promise<Envelope> {
  const live = await bindLive(handle, ctx, deps);
  return live.ok ? body(live.binding, live.runtime) : live.envelope;
}

/** The preflight of `withBinding`, as a value: the live binding and its fresh runtime, or the envelope that refuses. */
export async function bindLive(handle: string, ctx: CallContext, deps: HarnessDeps): Promise<{ readonly ok: true; readonly binding: BindingRecord; readonly runtime: ResolvedRuntime } | { readonly ok: false; readonly envelope: Envelope }> {
  const refuse = (envelope: Envelope) => ({ ok: false as const, envelope });
  const now = ctx.now ?? new Date();
  const found = await lookupBinding(deps.store.bindings, handle, ctx.principal_id, now);
  if (!found.ok) {
    if (found.reason === "BINDING_NOT_BOUND" && found.state === "EXPIRED") {
      // Persist the terminal state the lookup observed.
      const b = await deps.store.bindings.findByHandleHash((await import("../binding/handle.ts")).hashHandle(handle));
      if (b && b.status === "BOUND") await deps.store.bindings.setStatus(b.binding_id, "EXPIRED");
    }
    return refuse(ownershipEnvelope(found));
  }
  const binding = found.binding;
  const live = await checkLiveness(deps.store, deps.principals, binding, now, (p, project, lane) => resolveRuntimeFor(deps, p, project, lane));
  if (!live.ok) {
    const summary = bindingSummary(binding);
    switch (live.kind) {
      case "EXPIRED":
        return refuse(hold("HOLD_BINDING_STALE", "call os_bind again to obtain a fresh binding", ["binding_state=EXPIRED"], { binding: { ...summary, binding_state: "EXPIRED" } }));
      case "REVOKED":
        return refuse(error("ERROR_AUTH_REQUIRED", "principal is no longer active; binding revoked", "re-authenticate, then call os_bind", { binding: { ...summary, binding_state: "REVOKED" } }));
      case "ROTATED":
        return refuse(hold("HOLD_BINDING_STALE_RUNTIME_ROTATED", "the runtime was rotated; call os_bind again to bind the replacement runtime", [`previous_generation=${live.previous_generation}`, `current_generation=${live.current_generation}`], { binding: { ...summary, binding_state: "STALE" } }));
      case "RUNTIME_CHANGED":
        return refuse(hold("HOLD_BINDING_STALE_RUNTIME_ROTATED", "the assigned runtime changed; call os_bind again to bind the current assignment", [`previous_runtime_id=${live.previous_runtime_id}`, `current_runtime_id=${live.current_runtime_id}`], { binding: { ...summary, binding_state: "STALE" } }));
      case "VERSION_CHANGED":
        return refuse(hold("HOLD_VERSION_CHANGED", "the governing version changed; call os_bind again, then resume from durable state", live.changes, { binding: { ...summary, binding_state: "STALE" } }));
      case "MODE_CHANGED":
        return refuse(hold("HOLD_BINDING_STALE", "the runtime changed authorization mode; call os_bind again before any further action", [`previous_mode=${live.previous_mode}`, `current_mode=${live.current_mode}`, "the old handle cannot execute a tool body"], { binding: { ...summary, binding_state: "STALE" } }));
      case "RESOLUTION_HOLD":
        return refuse(hold(live.outcome.code as HoldCode, "resolve the runtime discovery issue, then retry", live.outcome.evidence, { binding: summary }));
    }
  }
  await deps.store.bindings.touch(binding.binding_id, now);
  return { ok: true, binding, runtime: live.runtime };
}

export const handlers: { readonly [T in ToolName]: Handler<T> } = {
  async os_bind(input, ctx, deps) {
    // PV0-020B: project and lane are inferred from the authenticated principal when unambiguous; a rep is never asked.
    const who = ctx.principal_id ? await deps.principals.get(ctx.principal_id) : undefined;
    const project = input.project ?? (who && who.allowed_projects.length === 1 ? who.allowed_projects[0] : undefined);
    const lane = input.lane ?? (who && who.allowed_lanes.length === 1 ? who.allowed_lanes[0] : undefined);
    if (who && who.status === "ACTIVE" && (!project || !lane)) {
      const choices = !lane ? who.allowed_lanes : who.allowed_projects;
      return hold("HOLD_LANE_REQUIRED", `ask the user the single question in ask, then call os_bind again with their answer as ${!lane ? "lane" : "project"}`, [`${!lane ? "lane" : "project"} not given and ${choices.length} allowed: ${choices.join(", ")}`], { observations: { choices } });
    }
    const auth = await authorize(deps.principals, ctx.principal_id, project ?? "", (lane ?? "META") as Lane);
    if (!auth.ok) {
      switch (auth.reason) {
        case "AUTH_REQUIRED":
        case "PRINCIPAL_INACTIVE":
          return error("ERROR_AUTH_REQUIRED", "authenticated principal required", "authenticate, then call os_bind again");
        case "PROJECT_UNKNOWN":
          return error("ERROR_PROJECT_UNKNOWN", `project ${project} is not allowed for this principal`, "use an allowed project");
        case "UNAUTHORIZED_LANE":
          return hold("HOLD_UNAUTHORIZED_LANE", "request only a lane this principal is authorized for", [`lane=${lane}`]);
      }
    }
    const resolved = await resolveRuntimeFor(deps, auth.principal, project as string, lane as Lane);
    if (resolved.kind === "HOLD") return hold(resolved.code as HoldCode, "resolve the runtime discovery issue, then call os_bind again", resolved.evidence);
    const r = resolved.runtime;
    const now = ctx.now ?? new Date();
    const created = await createBinding(deps.store, deps.config, auth.principal, project as string, lane as Lane, r, now);
    const legacyRead = r.operation_policy === "LEGACY_READ_ONLY";
    const initialRead = legacyRead || (ctx.readonly_initial_read && lane === "META" && r.access_mode === "BUSINESS"
      && !isInstallOnlyBinding(created.record) && auth.principal.meta_authority === "COMPANY_OWNER"
      && deps.config.metaRecoveryStatusPrincipalIds?.includes(auth.principal.principal_id))
      ? await dispatch("os_resume", { binding_handle: created.handle, topic_hint: "CURRENT_WORK" },
        { principal_id: ctx.principal_id, now, readonly_initial_read: true }, deps) : undefined;
    if (initialRead) {
      const after = await authorize(deps.principals, ctx.principal_id, project as string, lane as Lane);
      if (!after.ok || (!legacyRead && after.principal.meta_authority !== "COMPANY_OWNER"))
        return error("ERROR_AUTH_REQUIRED", "owner authority changed during the initial read", "restore current owner authorization before retrying; no initial state is returned");
    }
    return ok("BOUND", { binding_handle: created.handle, binding_expires_at: created.record.expires_at.toISOString(), owner_display: r.owner_display, lifecycle_state: r.lifecycle_state, ...(initialRead ? { initial_read: initialRead } : {}) }, {
      binding: bindingSummary(created.record),
      versions: { governing_spec: pick(r.versions.governing_spec), governing_schema: pick(r.versions.governing_schema), governing_control: pick(r.versions.governing_control), candidate_versions: r.versions.candidates.map((c) => c.value) },
      observations: { runtime_id: r.runtime_id, root_ref: r.root_ref, manifest_ref: r.manifest_ref, lifecycle_state: r.lifecycle_state, ...r.observations },
      warnings: r.warnings,
      next: { safe_action: "call os_resume with the binding_handle to reconstruct current durable state", permitted_tool_call: "os_resume" },
    });
  },
  async os_resume(input, ctx, deps) {
    return withBinding(input.binding_handle, ctx, deps, async (binding, runtime) => {
      const versions = { governing_spec: pick(runtime.versions.governing_spec), governing_schema: pick(runtime.versions.governing_schema), governing_control: pick(runtime.versions.governing_control), candidate_versions: runtime.versions.candidates.map((c) => c.value), historical_run_pins: Object.fromEntries(runtime.historical_pins.map((h) => [h.ref, `${h.spec} / ${h.schema} / ${h.control}`])) };
      if (runtime.operation_policy === "LEGACY_READ_ONLY") {
        const { readLegacyOperatingState } = await import("../migration/legacyRead.ts");
        const snapshot = await readLegacyOperatingState(deps.notion, runtime);
        const after = await authorize(deps.principals, ctx.principal_id, binding.project, binding.lane);
        if (!after.ok) return error("ERROR_AUTH_REQUIRED", "authorization changed during legacy inspection", "restore current authorization; no source data is returned");
        const current = await resolveRuntimeFor(deps, after.principal, binding.project, binding.lane);
        if (current.kind !== "RESOLVED" || current.runtime.runtime_generation !== runtime.runtime_generation
          || current.runtime.operation_policy !== "LEGACY_READ_ONLY" || current.runtime.manifest_pins.spec !== runtime.manifest_pins.spec
          || current.runtime.manifest_pins.schema !== runtime.manifest_pins.schema)
          return hold("HOLD_BINDING_STALE", "call os_bind again after the assignment is stable; no former source snapshot is returned", ["legacy assignment or pins changed during inspection"]);
        return ok("RESUMED", { legacy_read_only: snapshot }, { binding: bindingSummary(binding), versions, warnings: runtime.warnings,
          observations: { operation_policy: "LEGACY_READ_ONLY", migration_pending: true }, next: { safe_action: "The administrator must finish the verified migration before recording or production; meanwhile inspect only dated recorded sources." } });
      }
      const now = ctx.now ?? new Date();
      if (isInstallOnlyBinding(binding)) return resumeInstallation(binding, runtime, versions, ctx, deps);
      const adoptedPromotion = ctx.readonly_initial_read ? undefined : await finalizePromotionAfterRebind(deps, binding, runtime, now);
      const automatic = ctx.candidate_resume && !ctx.readonly_initial_read ? await (await import("../resume/adopt.ts")).resumeAndAdopt(deps, binding, runtime, now) : undefined;
      const outcome = automatic?.resume ?? await rehydrate(deps.notion, binding, runtime, deps.store, now);
      // Context-only, after all finalization/adoption and fresh safety hydration. Never share this snapshot
      // with binding, guards, writes or another exchange; pages and query facts remain uncached.
      const contextReads = new StructureCache(deps.notion);
      const governing_contract_content = await readGoverningContract(contextReads, runtime);
      const base = { binding: bindingSummary(binding), versions, warnings: [...outcome.warnings, ...(adoptedPromotion ? [`La finalisation ${adoptedPromotion} a été confirmée après reconnexion et nouvelle lecture.`] : [])] };
      // Read-only truth about the backend plan in flight; os_resume never sweeps or transitions it (PV0-020E).
      const durableRecoveryPlanId = outcome.kind === "HOLD"
        && outcome.code === "HOLD_RECOVERY_REQUIRED"
        && outcome.partial.current_run !== undefined
        && outcome.partial.current_run !== "NOT_FOUND"
        && outcome.partial.current_run !== "NOT_YET_CREATED"
        && outcome.partial.current_run.harness_plan_id !== "UNKNOWN"
          ? outcome.partial.current_run.harness_plan_id
          : undefined;
      // settle may have opened a fresh recovery of the Run's expired original. Report that active
      // journal, not the expired ancestor; the marker and candidate still check exact ownership/scope.
      const continuation = outcome.kind === "OK" ? outcome.state.ledger_continuation : outcome.partial.ledger_continuation;
      const open_backend_plan = await activePlanReport(deps, binding, now, continuation ? undefined : durableRecoveryPlanId);
      if (outcome.kind === "HOLD") {
        const nextAction = outcome.partial.next_safe_action ?? (outcome.code === "HOLD_RUN_AMBIGUOUS" ? "reconcile the incomplete Runs by hand; no new work" : outcome.code === "HOLD_STATE_DIVERGENCE" ? "inspect Manifest and Run evidence; no new work until reconciled" : "resolve the control-plane discovery issue");
        const { reconcileUnresolvedIntents } = await import("../effects/adapter.ts");
        const ea = outcome.partial.external_actions ? await reconcileUnresolvedIntents(deps, runtime, outcome.partial.external_actions) : undefined;
        // The pack is DIAGNOSTIC here: it never hides or replaces the HOLD evidence, and the raw hint is not
        // echoed — only its symbolic normalization reaches the caller (11 — CONTRACT PACK candidate v4). SETUP
        // stays ABSENT on HOLD. W5.1R allows only Notion DAILY reads under a reliable Gmail-only capability HOLD;
        // it never completes that capability, clears the HOLD or grants permission to produce or send.
        // EXTERNAL_ACTION (W2.4) is read on a HOLD only from a reliable snapshot of the bound runtime, i.e. when the
        // partial state carries its unresolved intents; a failed resolution never opens a read path.
        const heldGtm = await gtmInputs(deps, binding, runtime, outcome.partial);
        const heldNeeds = normalizeTopicHint(binding.lane, input.topic_hint, heldGtm.gtm_capability === true).needs;
        const incomplete = outcome.partial.capability_completeness?.incomplete_required;
        const reliableHold = outcome.partial.effective_hold;
        const heldDailySelected = binding.lane === "SALES" && heldNeeds.includes("CURRENT_WORK")
          && outcome.code === "HOLD_REQUIRED_CAPABILITY_INCOMPLETE"
          && incomplete !== undefined && incomplete.length > 0 && incomplete.every((c) => c === "GMAIL_READ")
          && reliableHold !== undefined && reliableHold !== "NONE" && reliableHold.code === outcome.code
          && typeof outcome.partial.next_safe_action === "string" && outcome.partial.next_safe_action.length > 0;
        const heldDailySources = heldDailySelected ? await readDailySources(contextReads, runtime, binding.lane, heldNeeds,
                { effective_hold: reliableHold, next_safe_action: outcome.partial.next_safe_action }, now)
            : [];
        const local_operating_documents = await readLocalOperatingDocuments(contextReads, runtime, heldDailySelected);
        const local_business_configuration = await readLocalBusinessConfiguration(contextReads, runtime, heldDailySelected);
        const heldSources = [...heldDailySources, ...await readExternalActionSources(contextReads, runtime, binding.lane, heldNeeds, outcome.partial.external_actions && ea ? { unresolved_count: outcome.partial.external_intents_unresolved, intents: ea.unresolved } : undefined)];
        const heldPack = buildContractPack({ lane: binding.lane, topic_hint: input.topic_hint, runtime_generation: binding.runtime_generation, versions, safety: outcome.partial, external_actions: ea, open_backend_plan, ...heldGtm, context_sources: heldSources });
        const capabilityChallenge = outcome.code === "HOLD_REQUIRED_CAPABILITY_INCOMPLETE"
          ? issueCapabilityChallenge(binding, runtime, outcome.partial, now)
          : undefined;
        const sourceEnrollment = outcome.code === "HOLD_REQUIRED_CAPABILITY_INCOMPLETE" && !capabilityChallenge
          ? await (await import("../resume/sourceEnrollment.ts")).resumeSourceEnrollmentChallenge(deps.store, binding, runtime, outcome.partial, now) : undefined;
        // The os_verify continuation is for recovering an actual incomplete Run, never a generic escape from a HOLD:
        // on any other reason it could only answer HOLD_PLAN_EXPIRED and send the chat round in a loop (PV-FW-001).
        const cr = outcome.partial.current_run;
        const incompleteRunInView = cr !== undefined && cr !== "NOT_FOUND" && cr !== "NOT_YET_CREATED" && cr.status !== "COMPLETED";
        const recoverByOldPlan = outcome.code === "HOLD_RECOVERY_REQUIRED" && incompleteRunInView && open_backend_plan !== "NONE" && open_backend_plan.owned_by_caller && open_backend_plan.expired;
        const recoveryAction = recoverByOldPlan
          ? `call os_verify with plan_id=${open_backend_plan.plan_id} and phase=TARGET; the backend will observe durable state and, if safe, return a new binding-scoped recovery plan`
          : nextAction;
        const heldSafeAction = ea?.gmail_hold ? `${ea.gmail_hold}; then: ${recoveryAction}` : recoveryAction;
        return hold(outcome.code, heldSafeAction, outcome.evidence, {
          ...base,
          warnings: [...base.warnings, ...heldPack.warnings],
          observations: {
            ...outcome.partial,
            governing_contract_content,
            local_operating_documents,
            local_business_configuration,
            ...(Array.isArray(runtime.observations.source_identity_enrollment) && runtime.observations.source_identity_enrollment.length > 0
              ? { source_remediation_enabled: true } : {}),
            ...(capabilityChallenge ? { capability_remediation: capabilityChallenge } : {}),
            ...(sourceEnrollment ? { source_identity_enrollment: sourceEnrollment } : {}),
            ...(ea ? { external_actions: ea } : {}),
            open_backend_plan,
            contract_pack: heldPack.pack,
            ...(heldGtm.gtm_capability ? { gtm: { capability: heldGtm.gtm_capability_source, ...(heldGtm.gtm_analysis ? { analysis: heldGtm.gtm_analysis } : {}) } } : {}),
          },
          ...(capabilityChallenge ? { next: { safe_action: heldSafeAction, permitted_tool_call: "os_prepare" } } : recoverByOldPlan ? { next: { safe_action: heldSafeAction, permitted_tool_call: "os_verify" } } : {}),
        });
      }
      const { reconcileUnresolvedIntents } = await import("../effects/adapter.ts");
      const externalActions = await reconcileUnresolvedIntents(deps, runtime, outcome.state.external_actions);
      if (externalActions.native_conflict) return hold(externalActions.native_conflict.code,
        "reconcile the conflicting source evidence with the space owner; never send or resend", externalActions.native_conflict.evidence,
        { ...base, observations: { ...outcome.state, external_actions: externalActions, open_backend_plan, governing_contract_content } });
      // Contract Pack (11 — CONTRACT PACK candidate v4): an ADDITIVE read plan over the already-derived state.
      // It selects business-asset pointers for the native fanout and changes no safety field above.
      const gtm = await gtmInputs(deps, binding, runtime, outcome.state);
      // W2.2 / W2.3 / W2.4: the SETUP, DAILY and EXTERNAL_ACTION sources are read only when the normalized needs select
      // them, inside the bound runtime. DAILY evaluates every date against `now`, the one instant captured at the start
      // of this attempt. EXTERNAL_ACTION is anchored on the unresolved intents the safety rehydration already read.
      const metaNeed = normalizeTopicHint(binding.lane, input.topic_hint, gtm.gtm_capability === true);
      const contextNeeds = metaNeed.needs;
      const metaSelected = binding.lane === "META" && runtime.access_mode === "BUSINESS"
        && deps.config.metaRecoveryStatusPrincipalIds?.includes(binding.principal_id)
        && metaNeed.crossLane.length === 0 && metaNeed.unknown.length === 0 && metaNeed.uncapable.length === 0
        && metaNeed.needs.some(n => n === "CURRENT_WORK" || n === "META_SETUP_INPUTS");
      const metaActor = metaSelected ? await authorize(deps.principals, binding.principal_id, binding.project, "META") : undefined;
      const metaData = metaActor?.ok && metaActor.principal.meta_authority === "COMPANY_OWNER"
        ? await readMetaOperatingContext(contextReads, runtime, true) : undefined;
      const metaAfter = metaData ? await authorize(deps.principals, binding.principal_id, binding.project, "META") : undefined;
      const metaContext = metaAfter?.ok && metaAfter.principal.meta_authority === "COMPANY_OWNER"
        ? { local_meta_operating_context: metaData } : {};
      const local_operating_documents = await readLocalOperatingDocuments(contextReads, runtime, contextNeeds.includes("CURRENT_WORK"));
      const local_business_configuration = await readLocalBusinessConfiguration(contextReads, runtime, contextNeeds.includes("CURRENT_WORK"));
      const context_sources = [
        ...await readSetupSources(contextReads, runtime, binding.lane, contextNeeds, outcome.state),
        ...await readDailySources(contextReads, runtime, binding.lane, contextNeeds, outcome.state, now),
        ...await readExternalActionSources(contextReads, runtime, binding.lane, contextNeeds, { unresolved_count: outcome.state.external_intents_unresolved, intents: externalActions.unresolved }),
      ];
      const { pack: contract_pack, warnings: packWarnings } = buildContractPack({ lane: binding.lane, topic_hint: input.topic_hint, runtime_generation: binding.runtime_generation, versions, safety: outcome.state, external_actions: externalActions, open_backend_plan, ...gtm, context_sources });
      // Normally no permitted_tool_call: a healthy resume carries an `ask`, so the next event is the seller's
      // answer, not a tool call, and naming a tool would push a caller to invent a mutation to comply.
      //
      // When the step has a pending answer, one thing is still certain: whatever the caller does next, reading
      // this same state again is not it. Three fresh conversations resumed two, three, four times over an
      // answer the seller had already given, then reported a backend refusal that never happened — the tool
      // they never called cannot refuse anything. So the envelope names the only call that can follow, and
      // carries it ready to send, with the seller's own words the single thing left to supply.
      const pendingAnswer = outcome.state.pending_step_input;
      const pendingConfirm = outcome.state.pending_confirmation;
      const { prepareIntentFor, prepareNoteFor } = await import("../resume/pendingInput.ts");
      return ok("RESUMED", { ...outcome.state, external_actions: externalActions, open_backend_plan, contract_pack, governing_contract_content, local_operating_documents, local_business_configuration, ...metaContext, ...(gtm.gtm_capability ? { gtm_capability: gtm.gtm_capability_source, ...(gtm.gtm_analysis ? { gtm_analysis: gtm.gtm_analysis } : {}) } : {}) }, { ...base, warnings: [...base.warnings, ...packWarnings], observations: { runtime_id: runtime.runtime_id, root_ref: runtime.root_ref, manifest_ref: runtime.manifest_ref, lifecycle_state: runtime.lifecycle_state }, next: {
        safe_action: externalActions.gmail_hold ? `${externalActions.gmail_hold}; then: ${outcome.state.next_safe_action}` : outcome.state.next_safe_action,
        // A changed row is confirmed before the step's own answer: its call is complete, the seller's "oui" is all
        // that is missing, and sending it without that answer would re-adopt a change they never approved.
        ...(pendingConfirm ? { permitted_tool_call: "os_prepare", prepare_intent: pendingConfirm.intent, send_only_after: "the seller confirms, in their current message, that this change is their decision" }
          : pendingAnswer ? { permitted_tool_call: "os_prepare", prepare_intent: prepareIntentFor(pendingAnswer), prepare_note: prepareNoteFor(pendingAnswer) } : {}),
      } });
    });
  },
  async os_prepare(input, ctx, deps) {
    return withBinding(input.binding_handle, ctx, deps, async (binding, runtime) => {
      if (runtime.operation_policy === "LEGACY_READ_ONLY") return hold("HOLD_ACTION_NOT_AUTHORIZED", "finish the verified migration before recording", ["LEGACY_READ_ONLY forbids plans, recovery and writes"], { binding: bindingSummary(binding), versions: versionsOf(runtime) });
      let intent: Intent | undefined = input.intent;
      const now = ctx.now ?? new Date();

      // A re-adoption that asks for no change (PV-ORPHAN-001) asserts the cursor exactly as it stands; it declares
      // nothing, so it is not the forgery this refusal exists for. os_prepare then checks it against what
      // os_resume actually reported, row by row.
      const asIs = (m: { readonly desired_changes: Readonly<Record<string, unknown>> }) => input.intent?.action_class === "RECONCILE" && Object.keys(m.desired_changes).length === 0;
      const forged = (input.intent?.mutations ?? []).filter((m) => runtime.adapter.controlPlane.resources?.[m.logical_resource_key]?.backendDerivedOnly === true && !asIs(m));
      if (forged.length > 0) {
        // Refused on the caller's own input, before any derivation, plan, Run or lease: a gate is moved by the
        // evidence the contract names, never by whoever is holding the conversation.
        return hold("HOLD_ACTION_NOT_AUTHORIZED", "let the durable step advance from the evidence it requires; submit no intent for it", [
          `${[...new Set(forged.map((m) => m.logical_resource_key))].join(", ")} is derived by the backend from verified durable evidence`,
          "a submitted intent for it is refused before plan, Run or lease creation",
        ], { binding: bindingSummary(binding), versions: versionsOf(runtime) });
      }
      if (input.intent && input.capability_evidence) {
        return error("ERROR_INVALID_ARGUMENT", "intent and capability_evidence are mutually exclusive", "submit ordinary intent or the fresh capability evidence, never both", { binding: bindingSummary(binding), versions: versionsOf(runtime) });
      }
      if (input.capability_evidence) {
        if (isInstallOnlyBinding(binding)) return hold("HOLD_INSTALL_REQUIRED", "finish the verified installation before capability onboarding", ["INSTALL_ONLY cannot consume capability evidence"], { binding: bindingSummary(binding), versions: versionsOf(runtime) });
        const derived = await deriveCapabilityRemediation(deps.notion, binding, runtime, input.capability_evidence, now, deps.competentSource);
        if (derived.kind === "HOLD") return hold(derived.code, derived.safe_action, derived.evidence, { binding: bindingSummary(binding), versions: versionsOf(runtime) });
        intent = derived.intent;
      }
      if (isInstallOnlyBinding(binding) && !intent) {
        const principal = await deps.principals.get(binding.principal_id);
        if (!principal) return hold("HOLD_PERMISSION_UNKNOWN", "re-authenticate, then call os_bind", ["authenticated principal is no longer resolvable"], { binding: bindingSummary(binding), versions: versionsOf(runtime) });
        let inspection;
        try { inspection = await inspectInstallBootstrap(deps.notion, runtime); }
        catch (err) { return hold("HOLD_REQUIRED_RESOURCE_MISSING", "restore/share the clone Registry, then resume installation", [`INSTALL inspection failed: ${(err as Error).message}`], { binding: bindingSummary(binding), versions: versionsOf(runtime) }); }
        if (inspection.violations.length > 0) return hold("HOLD_INSTALL_REQUIRED", "corriger la structure du clone indiquée, puis dites simplement « on continue »", inspection.violations, { binding: bindingSummary(binding), versions: versionsOf(runtime), observations: { install_phase: "INSTALL_PENDING", connector_capabilities: inspection.connector_capabilities } });
        const mappingVerified = await hasFinalizedInstallMapping(deps, binding, runtime);
        intent = mappingVerified
          ? { action_class: "INSTALL_PROMOTE", summary: "promote the structurally verified assigned clone", mutations: [{ logical_resource_key: "SALES:INSTALL_MANIFEST", operation: "UPDATE", record_selector: { natural_key: "CURRENT" }, desired_changes: installManifestTemplate(principal, runtime) }] }
          : mappingIntentTemplate(inspection);
      }
      if (!intent && !isInstallOnlyBinding(binding)) {
        // No caller intent on a business binding asks the backend for the cursor movement the governing contract
        // already authorizes from verified durable evidence (PV-B0-002). It derives or it declines; it never
        // invents a gate, and the move is planned, written and proved like any other transaction.
        const { deriveCursorTransition } = await import("../plans/cursorTransition.ts");
        const rehydrated = await rehydrate(deps.notion, binding, runtime, deps.store, ctx.now ?? new Date());
        // An interrupted transition must derive the SAME intent so prepare recognises and continues it rather
        // than opening a second Run, so the partial state of a recovery HOLD is used exactly like a clean one.
        const durable = (rehydrated.kind === "OK" ? rehydrated.state : rehydrated.partial) as import("../resume/derive.ts").ResumeState;
        const derived = await deriveCursorTransition(deps, binding, runtime, durable);
        if (derived.kind === "HOLD") return hold(derived.code, derived.safe_action, [...derived.evidence], { binding: bindingSummary(binding), versions: versionsOf(runtime) });
        if (derived.kind === "INTENT") intent = derived.intent;
      }
      if (!intent) return error("ERROR_INVALID_ARGUMENT", "intent is required for a business binding unless fresh capability_evidence was returned by os_resume", "provide the business intent, or the fresh bounded capability evidence returned by os_resume");
      const scope = checkLaneScope(binding.lane, intent.mutations.map((m) => m.logical_resource_key));
      if (scope.kind === "CROSS_LANE") {
        return hold("HOLD_CROSS_LANE", `this binding is fixed to lane ${binding.lane}; bind the other lane in its own binding`, scope.keys.map((k) => `resource ${k} is outside lane ${binding.lane}`), { binding: bindingSummary(binding) });
      }
      if (scope.kind === "UNSCOPED") {
        return hold("HOLD_RESOURCE_UNKNOWN", "use lane-namespaced logical resource keys (META:<resource> or SALES:<resource>)", scope.keys.map((k) => `resource ${k} has no lane namespace`), { binding: bindingSummary(binding) });
      }
      if (isInstallOnlyBinding(binding)) {
        const outcome = await prepareInstall(deps, binding, runtime, intent, now);
        const versions = versionsOf(runtime);
        if (outcome.kind === "HOLD") return hold(outcome.code, outcome.safe_action, [...outcome.evidence, "no business plan or copied-history recovery was opened"], { binding: bindingSummary(binding), versions, observations: { install_phase: "INSTALL_PENDING", open_backend_plan: await activePlanReport(deps, binding, now) } });
        const continuation = await resumeInstallContinuation(deps, binding, runtime, now);
        if (continuation.kind === "HOLD") return hold(continuation.code, continuation.safe_action, continuation.evidence, { binding: bindingSummary(binding), versions });
        if (continuation.kind === "NONE") return hold("HOLD_PLAN_REPLAY_INVALID", "reprendre l'installation depuis l'état durable actuel", ["the prepared install plan has no observable continuation"], { binding: bindingSummary(binding), versions });
        // New and replayed plans share the same observation-driven continuation. The initial response therefore
        // has the same one-action ceiling as every cold resume and can never dump the whole install batch.
        const responsePlan = continuation.plan;
        const pendingWriteSymbol = continuation.kind === "ACTION" ? continuation.write.symbol : undefined;
        const verify = continuation.kind === "VERIFY" ? { plan_id: continuation.plan.plan_id, phase: continuation.phase } : undefined;
        return ok("PLAN_PREPARED", {
          plan_id: responsePlan.plan_id, plan_expires_at: responsePlan.expires_at.toISOString(), plan_state: responsePlan.plan_state,
          install_phase: outcome.phase, replayed: outcome.replayed,
          operation_count: responsePlan.operations.length,
          pending_write_symbol: pendingWriteSymbol, ...(verify ? { verify } : {}),
        }, {
          binding: bindingSummary(binding), versions,
          observations: { runtime_id: runtime.runtime_id, lifecycle_state: "UNBOUND", binding_mode: binding.binding_mode, install_phase: binding.install_phase },
          warnings: ["Les données copiées et l'historique restent isolés pendant l'installation."],
          next: { safe_action: pendingWriteSymbol !== undefined ? "continuer cette étape avec le writer backend gardé, sans action Notion native" : "vérifier maintenant l'étape durable déjà observée", permitted_tool_call: verify ? "os_verify" : "os_resume" },
        });
      }
      const { prepare } = await import("../plans/prepare.ts");
      const outcome = await prepare(deps, binding, runtime, intent, now);
      const versions = versionsOf(runtime);
      if (outcome.kind === "HOLD") {
        return hold(outcome.code, outcome.safe_action, outcome.evidence, { binding: bindingSummary(binding), versions, observations: { ...(outcome.observations ?? {}), open_backend_plan: await activePlanReport(deps, binding, now) }, warnings: outcome.warnings ?? [] });
      }
      const p = outcome.plan;
      return ok("PLAN_PREPARED", {
        plan_id: p.plan_id,
        plan_expires_at: p.expires_at.toISOString(),
        plan_state: p.plan_state,
        run_mode: p.run_mode,
        execution_attempt_id: p.execution_attempt_id,
        baseline_runtime_revision: p.baseline_runtime_revision,
        operations: p.operations.map((o) => ({ ordinal: o.ordinal, logical_resource_key: o.logical_resource_key, operation: o.operation, physical_target_ref: o.physical_target_ref ?? "NOT_YET_CREATED", target_data_source_ref: o.target_data_source_ref ?? "UNKNOWN", natural_key: o.natural_key ?? "NOT_APPLICABLE", baseline_revision: o.baseline_revision ?? "NOT_APPLICABLE", compared_fields: o.compared_fields, before_values: o.before_values, expected_values: o.expected_values })),
        stage1_writes: p.stage1_writes,

        replayed: outcome.replayed,
      }, {
        binding: bindingSummary(binding),
        versions,
        observations: { runtime_id: runtime.runtime_id, root_ref: runtime.root_ref, manifest_ref: runtime.manifest_ref, lifecycle_state: runtime.lifecycle_state, ...outcome.observations },
        warnings: outcome.warnings,
        // No permitted_tool_call while the writes are pending: none of the six tools may be called yet, and
        // naming os_verify here is what made a caller verify writes it had not performed.
        next: { safe_action: "continue through os_commit; only the guarded backend executor writes and verifies the stored plan" },
      });
    });
  },
  async os_verify(input, ctx, deps) {
    return withBinding(input.binding_handle, ctx, deps, async (binding, runtime) => {
      if (runtime.operation_policy === "LEGACY_READ_ONLY") return hold("HOLD_ACTION_NOT_AUTHORIZED", "finish the verified migration before recovery or recording", ["LEGACY_READ_ONLY forbids finalization"], { binding: bindingSummary(binding), versions: versionsOf(runtime) });
      const now = ctx.now ?? new Date();
      const found = await lookupPlan(deps.store.plans, input.plan_id, ctx.principal_id, binding);
      const versions = versionsOf(runtime);
      const base = { binding: bindingSummary(binding), versions };
      // The binding is valid here: an unknown plan keeps the validated binding/version context (P2, acceptance report).
      if (!found.ok) {
        if (found.reason === "PLAN_BINDING_MISMATCH" && input.phase === "TARGET") {
          const original = await deps.store.plans.get(input.plan_id);
          const eligible = original?.plan_kind === "BUSINESS"
            && original.principal_id === ctx.principal_id
            && original.principal_id === binding.principal_id
            && original.binding_id !== binding.binding_id
            && original.project === binding.project
            && original.lane === binding.lane
            && original.runtime_id === binding.runtime_id
            && original.runtime_generation === binding.runtime_generation
            && (original.plan_state === "EXPIRED" || (original.expires_at <= now && !["FINAL_VERIFIED", "ABORTED", "SUPERSEDED"].includes(original.plan_state)));
          if (eligible && original) {
            const { openRecoveryPlan } = await import("../recovery/engine.ts");
            const recovered = await openRecoveryPlan(deps, binding, runtime, original, {
              governing: {
                spec: runtime.versions.governing_spec === "UNKNOWN" ? "UNKNOWN" : runtime.versions.governing_spec.value,
                schema: runtime.versions.governing_schema === "UNKNOWN" ? "UNKNOWN" : runtime.versions.governing_schema.value,
                control: runtime.versions.governing_control === "UNKNOWN" ? "UNKNOWN" : runtime.versions.governing_control.value,
              },
              now,
            });
            if (recovered.kind === "HOLD") return hold(recovered.code, recovered.safe_action, recovered.evidence, { ...base, observations: recovered.observations ?? {}, warnings: recovered.warnings });

            const p = recovered.plan;
            return ok("PLAN_PREPARED", {
              plan_id: p.plan_id, plan_expires_at: p.expires_at.toISOString(), plan_state: p.plan_state,
              run_mode: p.run_mode, execution_attempt_id: p.execution_attempt_id, baseline_runtime_revision: p.baseline_runtime_revision,
              operations: p.operations.map((o) => ({ ordinal: o.ordinal, logical_resource_key: o.logical_resource_key, operation: o.operation, physical_target_ref: o.physical_target_ref ?? "NOT_YET_CREATED", target_data_source_ref: o.target_data_source_ref ?? "UNKNOWN", natural_key: o.natural_key ?? "NOT_APPLICABLE", baseline_revision: o.baseline_revision ?? "NOT_APPLICABLE", compared_fields: o.compared_fields, before_values: o.before_values, expected_values: o.expected_values })),
              stage1_writes: p.stage1_writes, replayed: recovered.replayed,
            }, {
              ...base,
              observations: { runtime_id: runtime.runtime_id, root_ref: runtime.root_ref, manifest_ref: runtime.manifest_ref, lifecycle_state: runtime.lifecycle_state, ...recovered.observations },
              warnings: recovered.warnings,
              next: { safe_action: "continue through os_commit; only the guarded backend executor writes and verifies the stored plan" },
            });
          }
        }
        return found.reason === "PLAN_NOT_FOUND" ? error("ERROR_PLAN_NOT_FOUND", "unknown plan_id", "call os_prepare to create a plan", base) : ownershipEnvelope(found);
      }
      const plan = found.plan;
      if (isInstallOnlyBinding(binding)) {

        if (!isInstallMappingPlan(plan) && !isInstallPromotionPlan(plan)) return hold("HOLD_PLAN_REPLAY_INVALID", "prepare only the exact installer step returned by os_resume", ["INSTALL_ONLY handle cannot verify a business plan"], base);
        if (input.phase === "FINAL") {
          const outcome = isInstallPromotionPlan(plan)
            ? await verifyInstallPromotionFinal(deps, binding, runtime, plan, now)
            : await verifyInstallMappingFinal(deps, binding, runtime, plan, now);
          if (outcome.kind === "HOLD") return hold(outcome.code, outcome.safe_action, [...outcome.evidence, "the clone remains INSTALL_PENDING and business progression is blocked"], base);
          const promoted = isInstallPromotionPlan(plan);
          return ok("TRANSACTION_VERIFIED", { plan_id: plan.plan_id, final_receipt_id: outcome.receipt_id, install_phase: promoted ? "reconnexion requise" : "structure vérifiée", manifest_promoted: promoted }, {
            ...base, observations: { binding_mode: promoted ? "STALE" : binding.binding_mode, install_phase: promoted ? "NOT_APPLICABLE" : binding.install_phase }, warnings: promoted ? ["L'affectation a été activée et cette connexion est maintenant obsolète."] : ["La structure est vérifiée ; l'identité de l'espace sera finalisée séparément."],
            next: { safe_action: promoted ? "se reconnecter puis reprendre ; les accès requis seront vérifiés avant tout travail commercial" : "reprendre normalement afin de finaliser séparément l'identité de l'espace", permitted_tool_call: promoted ? "os_bind" : "os_resume" },
          });
        }
        const outcome = await verifyInstallTarget(deps, binding, runtime, plan, now);
        if (outcome.kind === "HOLD") return hold(outcome.code, outcome.safe_action, [...outcome.evidence, "no install receipt was issued"], { ...base, observations: { binding_mode: binding.binding_mode, install_phase: binding.install_phase } });
        if (outcome.kind === "STEP") {

          return ok("PLAN_PREPARED", {
            plan_id: plan.plan_id,
            verification_step: outcome.step === "CANARY_UPDATE" ? "étape intermédiaire" : "mise à jour terminale du canari (encore TARGET)",
            pending_write_symbol: outcome.write.symbol,
            // Both canary mutations are intermediate writes inside TARGET verification. Expose the exact
            // follow-up call instead of leaving a model to infer the phase from a human-readable label.
            verify: { plan_id: plan.plan_id, phase: "TARGET" },
          }, {
            ...base, observations: { verification_ref: outcome.canary_ref, install_phase: "vérification en cours" }, warnings: [],
            next: { safe_action: "continuer cette étape avec le writer backend gardé, sans action Notion native", permitted_tool_call: "os_verify" },
          });
        }
        if (isInstallPromotionPlan(plan)) {

          return ok("TARGET_VERIFIED", { plan_id: plan.plan_id, target_receipt_id: outcome.receipt_id, install_phase: "état initial et identité prêts à finaliser" }, {
            ...base, observations: { install_phase: "identité à finaliser", structure_reverified: true }, warnings: ["L'identité est finalisée séparément ; les accès Gmail, calendrier et suivi restent à vérifier."],
            next: { safe_action: "finaliser l’état puis l’identité en dernier avec le writer backend gardé", permitted_tool_call: "os_verify" },
          });
        }
        const continuation = await resumeInstallContinuation(deps, binding, runtime, now);
        if (continuation.kind === "HOLD") return hold(continuation.code, continuation.safe_action, continuation.evidence, base);
        if (continuation.kind === "NONE") return hold("HOLD_PLAN_REPLAY_INVALID", "reprendre l'installation depuis l'état durable actuel", ["the target-verified mapping has no observable continuation"], base);
        const pendingWriteSymbol = continuation.kind === "ACTION" ? continuation.write.symbol : undefined;
        const verify = continuation.kind === "VERIFY" ? { plan_id: continuation.plan.plan_id, phase: continuation.phase } : undefined;
        return ok("TARGET_VERIFIED", {
          plan_id: plan.plan_id, target_receipt_id: outcome.receipt_id, verification_ref: outcome.canary_ref, install_phase: "structure relue",
          installation: { continuation: { plan_id: continuation.plan.plan_id, pending_write_symbol: pendingWriteSymbol, ...(verify ? { verify } : {}) } },
        }, {
          ...base, observations: { install_phase: "structure relue", verification_status: "terminée", verification_scope: "ce plan uniquement" }, warnings: [],
          next: { safe_action: pendingWriteSymbol !== undefined ? "continuer cette étape avec le writer backend gardé, sans action Notion native" : "effectuer la vérification finale de cette étape", permitted_tool_call: pendingWriteSymbol !== undefined ? "os_resume" : "os_verify" },
        });
      }
      if (input.phase === "FINAL") {
        const pre = finalPreconditionHold(plan);
        if (pre && pre.kind === "HOLD") return hold(pre.code, "call os_verify with phase=TARGET first; FINAL requires a valid target receipt", [...pre.evidence, "no final receipt issued"], base);
        const { verifyFinal, parkOnDrift } = await import("../verify/final.ts");
        const outcome = await verifyFinal(deps, binding, runtime, plan, now);
        if (outcome.kind === "HOLD") {
          const notes = outcome.drift ? await parkOnDrift(deps, plan, now, `${outcome.code} observed at FINAL`) : [];
          await deps.store.events.append({ event_type: "FINAL_VERIFY_HOLD", result: outcome.code, principal_id: binding.principal_id, binding_id: binding.binding_id, plan_id: plan.plan_id, runtime_id: binding.runtime_id, detail: { evidence: outcome.evidence }, created_at: now });
          return hold(outcome.code, outcome.safe_action, [...outcome.evidence, ...notes, "no final receipt issued; the change is NOT complete"], { ...base, observations: { plan_id: plan.plan_id, plan_state: (await deps.store.plans.get(plan.plan_id))?.plan_state ?? plan.plan_state, ...(outcome.observations ?? {}) }, warnings: outcome.warnings ?? [] });
        }
        const { routingMetadataForPlan } = await import("../effects/adapter.ts");
        const externalAction = await routingMetadataForPlan(deps, runtime, plan, outcome.target_receipt);
        // Whether THIS transaction moved the durable step: true only when it wrote a backend-derived resource (the
        // cursor). A verified answer that did not is the signal for the same-turn derived os_prepare (§1e), and the
        // reply's conduct says so; without this the caller has to infer it from the plan's operations.
        const derivedCatalog = runtime.adapter.controlPlane.resources ?? {};
        const stepMoved = plan.operations.some((o) => derivedCatalog[o.logical_resource_key]?.backendDerivedOnly === true);
        return ok("TRANSACTION_VERIFIED", {
          plan_id: plan.plan_id,
          final_receipt_id: outcome.receipt.receipt_id,
          target_receipt_id: outcome.target_receipt.receipt_id,
          run_ref: outcome.observations["run_ref"],
          verified_at: outcome.receipt.observed_at.toISOString(),
          repeated: outcome.repeated,
          step_moved: stepMoved,
          ...(externalAction ? { external_action: externalAction } : {}),
        }, {
          ...base,
          observations: { runtime_id: runtime.runtime_id, root_ref: runtime.root_ref, manifest_ref: runtime.manifest_ref, ...outcome.observations },
          warnings: outcome.warnings,
          next: { safe_action: externalAction ? "the ExternalActionIntent is durably represented and verified — that is NOT authorization at T-0 and NOT proof of any send. Route it only through an eligible execution mode (deterministic Mail Executor for automated sends; approved native test scope for EXTERNAL_ACTION_TEST); reconcile Gmail after any effect and persist transaction B" : "the transaction is durably verified; you may now say the change is complete. For further work call os_resume, then os_prepare", permitted_tool_call: "os_resume" },
        });
      }
      const { verifyTarget, invalidateOnDrift } = await import("../verify/target.ts");

      const outcome = await verifyTarget(deps, binding, runtime, plan, now);
      if (outcome.kind === "HOLD") {
        const notes = plan.plan_state === "TARGET_VERIFIED" && (outcome.code.startsWith("HOLD_TARGET_") || outcome.code === "HOLD_LEDGER_PREPARE_MISSING" || outcome.code === "HOLD_RUN_NOT_OPENED") ? await invalidateOnDrift(deps, plan, now, `${outcome.code} observed on repeated TARGET verification`) : [];
        await deps.store.events.append({ event_type: "TARGET_VERIFY_HOLD", result: outcome.code, principal_id: binding.principal_id, binding_id: binding.binding_id, plan_id: plan.plan_id, runtime_id: binding.runtime_id, detail: { evidence: outcome.evidence }, created_at: now });
        return hold(outcome.code, outcome.safe_action, [...outcome.evidence, ...notes, "no target receipt issued"], { ...base, observations: { plan_id: plan.plan_id, plan_state: (await deps.store.plans.get(plan.plan_id))?.plan_state ?? plan.plan_state, ...(outcome.observations ?? {}) }, warnings: outcome.warnings ?? [] });
      }

      const catalog = runtime.adapter.controlPlane.resources ?? {};
      const externalIntents = plan.operations.filter((o) => catalog[o.logical_resource_key]?.externalEffect).map((o) => {
        const t = (outcome.observations["targets"] as Array<{ ordinal: number; target_ref: string; observed: Record<string, string | null> }>).find((x) => x.ordinal === o.ordinal);
        return { ordinal: o.ordinal, intent_ref: t?.target_ref ?? "UNKNOWN", routing: t?.observed ?? {}, effect_status: t?.observed?.["Effect Status"] ?? "UNKNOWN", send_authority: "NONE" as const, note: "verified INTENT record only; no send has occurred and this plugin cannot send. Execution belongs to the governed Mail Executor (PG9); effect proof comes from competent-source (Gmail) reconciliation." };
      });
      return ok("TARGET_VERIFIED", {
        plan_id: plan.plan_id,
        target_receipt_id: outcome.receipt.receipt_id,
        ...(externalIntents.length > 0 ? { external_action_intents: externalIntents } : {}),
        receipt_expires_at: outcome.receipt.expires_at?.toISOString() ?? "UNKNOWN",
        repeated: outcome.repeated,
        run_ref: outcome.symbols["OPEN_RUN"],
        targets: outcome.observations["targets"],


      }, {
        ...base,
        observations: { runtime_id: runtime.runtime_id, root_ref: runtime.root_ref, manifest_ref: runtime.manifest_ref, ...outcome.observations },
        warnings: outcome.warnings,
        // Same reason as PLAN_PREPARED: the finalization writes have not happened yet, so no tool is permitted.
        next: { safe_action: "continue through os_commit; only the guarded backend executor writes and verifies the stored plan" },
      });
    });
  },
  async os_handoff(input, ctx, deps) {
    return withBinding(input.binding_handle, ctx, deps, async (binding, runtime) => {
      if (isInstallOnlyBinding(binding)) return hold("HOLD_INSTALL_REQUIRED", "finish the verified installation before requesting a handoff", ["runtime binding is INSTALL_ONLY"], { binding: bindingSummary(binding), versions: versionsOf(runtime) });
      const now = ctx.now ?? new Date();
      const resumed = await rehydrate(deps.notion, binding, runtime, deps.store, ctx.now ?? new Date());
      const { deriveHandoff } = await import("../handoff/engine.ts");
      const h = deriveHandoff(binding, resumed, now, input.format_hint);
      const base = { binding: bindingSummary(binding), versions: versionsOf(runtime), warnings: resumed.warnings };
      if (h.kind === "HOLD") return hold(h.code, h.safe_action, h.evidence, { ...base, observations: { ...h.partial, target_lane: "UNKNOWN" } });
      return ok("HANDOFF_READY", { ...h.handoff } as Record<string, unknown>, { ...base, observations: { runtime_id: runtime.runtime_id, root_ref: runtime.root_ref, manifest_ref: runtime.manifest_ref }, next: { safe_action: h.handoff.next_action, permitted_tool_call: "os_resume" } });
    });
  },
  async os_control_status(input, ctx, deps) {
    return withBinding(input.binding_handle, ctx, deps, async (binding, runtime) => {
      if (isInstallOnlyBinding(binding)) return hold("HOLD_INSTALL_REQUIRED", "finish the verified installation before requesting control adjudication", ["runtime binding is INSTALL_ONLY"], { binding: bindingSummary(binding), versions: versionsOf(runtime) });
      const { controlStatus } = await import("../control/engine.ts");
      const out = await controlStatus(deps.notion, deps.adapters.control, binding, runtime);
      const base = { binding: bindingSummary(binding), versions: versionsOf(runtime) };
      if (out.kind === "HOLD") return hold(out.code, out.safe_action, out.evidence, { ...base, observations: { ...(out.partial ?? {}), scope_hint: input.scope_hint ?? "NOT_APPLICABLE" }, warnings: out.warnings ?? [] });
      return ok("CONTROL_STATUS", { ...out.status } as Record<string, unknown>, { ...base, observations: { runtime_id: runtime.runtime_id, root_ref: runtime.root_ref, manifest_ref: runtime.manifest_ref, scope_hint: input.scope_hint ?? "NOT_APPLICABLE" }, warnings: out.warnings, next: { safe_action: out.status.result === "CONFIRMED" ? "current scope is control-confirmed; continue with os_resume" : "operational integrity PASS only; a control-confirmed gate still needs the independent verifier", permitted_tool_call: "os_resume" } });
    });
  },
};


/**
 * Candidate GTM inputs of a resume (PV-GTM-002). Capability is decided by the bound runtime — the governing Sales
 * contract adapter, or a META registration that explicitly PINS the candidate policy — never by the caller. When
 * it is off this returns an empty object and the Contract Pack is byte-identical to the adopted one.
 */
async function gtmInputs(deps: HarnessDeps, binding: BindingRecord, runtime: ResolvedRuntime, safety: Partial<import("../resume/derive.ts").ResumeState>) {
  const { gtmCapability, discoverGtmContainers, gtmAnalysisProjection } = await import("../gtm/context.ts");
  const registration = safety.meta_gtm_metrics;
  const capability = gtmCapability(binding.lane, runtime, registration);
  if (!capability.enabled) return { gtm_capability: false as const };
  if (binding.lane === "SALES") {
    return { gtm_capability: true as const, gtm_containers: await discoverGtmContainers(deps.notion, runtime), gtm_capability_source: capability.source };
  }
  const source = safety.meta_inputs === undefined || safety.meta_inputs === "NOT_FOUND" || safety.meta_inputs === "NOT_APPLICABLE" ? undefined : safety.meta_inputs;
  return {
    gtm_capability: true as const,
    meta_gtm_metrics: registration,
    gtm_analysis: gtmAnalysisProjection(registration, source),
    gtm_capability_source: capability.source,
  };
}

const INSTALL_GATE = "Installation de l'espace";
const INSTALL_CONTINUE_CONDUCT = "Installation routine, autonomous and silent: the server performed this batch of the installation itself. Keep this `say` silent, never promise the space is ready, and call os_resume again now with the same binding_handle; repeat while the reply says the installation continues. Never write anything in Notion yourself and never call another tool for it.";
const INSTALL_REBIND_CONDUCT = "The installation is complete and deliberately ended this connection. Silently call os_bind with no arguments, then os_resume with the fresh handle, and speak only that fresh resume's `say`. Never reuse the installer handle and never call the installation complete before this fresh pair.";

/**
 * W3.3 — INSTALL_ONLY os_resume installs on the server (install/execute.ts), one bounded batch per call. It hands
 * no native action to the chat and names no retired tool. Without a Notion writer it opens no plan, writes nothing
 * and answers HOLD_INSTALL_REQUIRED: the installation is never pushed back onto the chat.
 */
async function resumeInstallation(binding: BindingRecord, runtime: ResolvedRuntime, versions: Envelope["versions"], ctx: CallContext, deps: HarnessDeps): Promise<Envelope> {
  const summary = bindingSummary(binding);
  const observations = { runtime_id: runtime.runtime_id, root_ref: runtime.root_ref, manifest_ref: runtime.manifest_ref, lifecycle_state: "UNBOUND", binding_mode: "INSTALL_ONLY" };
  const writer = (deps as import("../transactions/execute.ts").TransactionDeps).notionWriter;
  if (!writer) {
    return hold("HOLD_INSTALL_REQUIRED", "l'installation est écrite par le serveur uniquement ; elle reprendra quand l'écriture serveur sera disponible", ["this process holds no Notion writer; the installation is written by the server only, never from the chat", "no installation plan was opened and nothing was written"], { binding: summary, versions, observations: { ...observations, install_phase: "INSTALL_PENDING", server_writes: "désactivées" } });
  }
  const principal = await deps.principals.get(binding.principal_id);
  if (!principal) return hold("HOLD_PERMISSION_UNKNOWN", "re-authenticate, then call os_bind", ["authenticated principal is no longer resolvable"], { binding: summary, versions });
  const { runInstallBatch, INSTALL_WRITES_PER_CALL } = await import("../install/execute.ts");
  const { Deadline, HARNESS_CALL_BUDGET_MS } = await import("../transactions/budget.ts");
  const fixed = ctx.now;
  const pinned = (deps as import("../transactions/commit.ts").CommitDeps).clock;
  const clock = pinned ?? (fixed ? () => fixed : () => new Date());
  const out = await runInstallBatch(deps, { binding, runtime, principal, writer, clock, deadline: new Deadline(() => clock().getTime(), (deps as import("../transactions/commit.ts").CommitDeps).commitBudgetMs ?? HARNESS_CALL_BUDGET_MS) });
  const now = clock();
  await deps.store.events.append({ event_type: "INSTALL_BATCH", result: out.kind === "HOLD" ? out.code : out.kind, principal_id: binding.principal_id, binding_id: binding.binding_id, runtime_id: binding.runtime_id, ...("plan_id" in out && out.plan_id ? { plan_id: out.plan_id } : {}), detail: { writes_sent: out.writes_sent, ...(out.kind === "CONTINUE" ? { reason: out.reason } : {}) }, created_at: now });
  const writes = { writes_sent: out.writes_sent, writes_per_call: INSTALL_WRITES_PER_CALL };
  if (out.kind === "HOLD") {
    return hold(out.code, out.safe_action, [...out.evidence, out.writes_sent > 0 ? `${out.writes_sent} installation write(s) were sent by this call before it stopped` : "nothing was written by this call"], { binding: summary, versions, observations: { ...observations, install_phase: "INSTALL_PENDING", ...writes } });
  }
  if (out.kind === "PROMOTED") {
    // The FINAL verifier stales the binding that prepared the promotion; this call's binding is spent too.
    await deps.store.bindings.setStatus(binding.binding_id, "STALE");
    return ok("RESUMED", {
      runtime_state: "UNBOUND", install_only: true,
      gate: { gate_key: INSTALL_GATE, status: "OPEN", formal_next_action: "se reconnecter pour vérifier les accès requis", formal_next_question: "NOT_APPLICABLE" },
      installation: { mode: "installation serveur par lots", phase: "reconnexion requise", business_progression: "bloquée", manifest_promoted: true, final_receipt_id: out.receipt_id, ...writes },
    }, {
      binding: { ...summary, binding_state: "STALE" }, versions,
      observations: { ...observations, binding_mode: "STALE", install_phase: "NOT_APPLICABLE" },
      warnings: ["L'affectation a été activée et cette connexion est maintenant obsolète."],
      next: { safe_action: "se reconnecter puis reprendre ; les accès requis seront vérifiés avant tout travail commercial", permitted_tool_call: "os_bind", conduct: INSTALL_REBIND_CONDUCT },
    });
  }
  const mapped = out.kind === "MAPPING_VERIFIED";
  const label = mapped ? "La structure de votre espace est vérifiée ; je finalise son identité à l'étape suivante."
    : out.phase === "ACTIVATION" ? "Je finalise l'identité de votre espace." : "Je relie et vérifie les éléments de votre espace.";
  return ok("RESUMED", {
    runtime_state: "UNBOUND", install_only: true,
    gate: { gate_key: INSTALL_GATE, status: "OPEN", formal_next_action: label, formal_next_question: "NOT_APPLICABLE" },
    installation: {
      mode: "installation serveur par lots", phase: mapped ? "structure vérifiée" : out.phase === "ACTIVATION" ? "activation en cours" : "cartographie en cours",
      business_progression: "bloquée", continues: true, ...(out.kind === "CONTINUE" ? { stopped_at: out.reason } : {}), ...writes,
    },
  }, {
    binding: summary, versions, observations,
    warnings: [...runtime.warnings, "Les données copiées et l'historique restent isolés pendant l'installation."],
    next: { safe_action: "reprendre l'installation avec le même accès ; le serveur écrit le lot suivant", permitted_tool_call: "os_resume", conduct: INSTALL_CONTINUE_CONDUCT },
  });
}

/** Read-only: the backend plan in flight for this binding's runtime generation. Never sweeps or transitions. */
async function activePlanReport(deps: HarnessDeps, binding: BindingRecord, now: Date, durableRecoveryPlanId?: string) {
  const { describeActivePlan, leaseKeyOf } = await import("../plans/service.ts");
  if (durableRecoveryPlanId) {
    const referenced = await deps.store.plans.get(durableRecoveryPlanId);
    const exactOwnedRecovery = referenced?.plan_kind === "BUSINESS"
      && referenced.principal_id === binding.principal_id
      && referenced.project === binding.project
      && referenced.lane === binding.lane
      && referenced.runtime_id === binding.runtime_id
      && referenced.runtime_generation === binding.runtime_generation
      // A plan that already reached a terminal state has nothing to recover: FINAL_VERIFIED consumed its receipt,
      // ABORTED/SUPERSEDED were closed, HOLD is a divergence. Reporting one as recoverable made os_resume serve a
      // continuation (os_verify TARGET) that can only answer HOLD_PLAN_REPLAY_INVALID — a dead end for the chat.
      // ADMISSION-SALES-001 exposed it: a Manifest blocker now raises HOLD_RECOVERY_REQUIRED while the durable
      // Run in view is COMPLETED, so the referenced plan is routinely a finished one.
      && referenced.plan_state !== "FINAL_VERIFIED" && referenced.plan_state !== "ABORTED" && referenced.plan_state !== "SUPERSEDED" && referenced.plan_state !== "HOLD"
      && (referenced.plan_state === "EXPIRED" || referenced.expires_at <= now);
    if (exactOwnedRecovery && referenced) {
      return describeActivePlan([referenced], await deps.store.leases.current(leaseKeyOf(binding), now), binding, now);
    }
  }
  const active = await deps.store.plans.findActive(binding.project, binding.lane, binding.runtime_generation);
  return describeActivePlan(active, await deps.store.leases.current(leaseKeyOf(binding), now), binding, now);
}

function versionsOf(r: ResolvedRuntime) {
  return { governing_spec: pick(r.versions.governing_spec), governing_schema: pick(r.versions.governing_schema), governing_control: pick(r.versions.governing_control), candidate_versions: r.versions.candidates.map((c) => c.value) };
}

function pick(v: import("../versions/registry.ts").ClassifiedVersion | "UNKNOWN"): string {
  return v === "UNKNOWN" ? "UNKNOWN" : v.value;
}

export async function dispatch(name: ToolName, rawInput: unknown, ctx: CallContext, deps: HarnessDeps): Promise<Envelope> {
  const parsed = toolInputSchemas[name].safeParse(rawInput);
  if (!parsed.success) return withConduct(name, withUserSentence(name, error("ERROR_INVALID_ARGUMENT", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), "fix the arguments; only LLM-controlled inputs are accepted")));
  // Each handler is typed against its own schema; the cast narrows the union at the single dispatch site.
  const envelope = await (handlers[name] as Handler<ToolName>)(parsed.data as never, ctx, deps);
  if (name === "os_bind" && !OS_BIND_CODES.has(envelope.code)) {
    // The public contract is closed: an unexpected code is an implementation error, never surfaced as a verdict.
    return withConduct(name, withUserSentence(name, hold("HOLD_UNKNOWN_REQUIRED_FACT", "report this as a harness defect; do not proceed", [`os_bind produced an out-of-contract code ${envelope.code}`])));
  }
  // Conduct is attached LAST: it reads the finished envelope (`say`, `ask`, `next`) so it never describes a reply
  // other than the one the caller is holding.
  return withConduct(name, withUserSentence(name, envelope));
}

/** W3.2: the two retired transaction names. Still announced by ListTools until W3.3 publishes the five-tool surface. */
export const LEGACY_TOOL_NAMES: ReadonlySet<string> = new Set<ToolName>(["os_prepare", "os_verify"]);
export const LEGACY_UPGRADE_SENTENCE = "Cette version de l'application doit être rafraîchie : réajoutez VERTIGO à la conversation." as const;

/**
 * PT-LEGACY-001 (W3.2, D4): an MCP call to a retired name answers this candidate refusal and nothing else. It reads no
 * binding, opens no plan, lease or Run and writes nothing; it is never routed to os_commit. The historical suites keep
 * `dispatch` on the old protocol until W3.3.
 */
export function legacyUpgradeRefusal(name: string): Omit<Extract<import("../transactions/commit.ts").CommitOutcome, { kind: "HELD" }>, "code"> & { readonly code: "HOLD_CLIENT_UPGRADE_REQUIRED"; readonly say: string } {
  return {
    kind: "HELD", origin: "INTENT", phase: "PREPARE", code: "HOLD_CLIENT_UPGRADE_REQUIRED",
    evidence: [`${name} is retired: it neither plans nor writes, and is never forwarded to another tool`],
    safe_action: "ask the user to re-add VERTIGO to the conversation; do not retry this call and claim no durable effect",
    missing: [], wrote_anything: false, warnings: [], say: LEGACY_UPGRADE_SENTENCE,
  };
}

/**
 * os_commit (W3.1, candidate): routed by MCP CallTool only, never announced by ListTools before W3.3. Same input as
 * os_prepare; the answer is the candidate TransactionOutcome (A.3) with its sentence, never the six-tool envelope.
 */
export async function dispatchCommit(rawInput: unknown, ctx: CallContext, deps: HarnessDeps & import("../transactions/commit.ts").CommitDeps): Promise<import("../transactions/commit.ts").CommitOutcome & { readonly say: string }> {
  const { commit } = await import("../transactions/commit.ts");
  const { commitSentence } = await import("../transactions/sentences.fr.ts");
  const said = (o: import("../transactions/commit.ts").CommitOutcome) => ({ ...o, say: commitSentence(o) });
  const refused = (code: import("../transactions/commit.ts").CommitHoldCode, evidence: readonly string[], safe_action: string) => said({ kind: "HELD", origin: "INTENT", phase: "PREPARE", code, evidence, safe_action, missing: [], wrote_anything: false, warnings: [] });
  const parsed = toolInputSchemas.os_commit.safeParse(rawInput);
  if (!parsed.success) return refused("ERROR_INVALID_ARGUMENT", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`), "fix the arguments; only LLM-controlled inputs are accepted");
  const live = await bindLive(parsed.data.binding_handle, ctx, deps);
  if (!live.ok) {
    const e = live.envelope;
    return refused(e.code as import("../transactions/commit.ts").CommitHoldCode, e.status === "HOLD" ? e.evidence : e.status === "ERROR" ? [e.message] : [], e.next.safe_action);
  }
  if (live.runtime.operation_policy === "LEGACY_READ_ONLY") return refused("HOLD_ACTION_NOT_AUTHORIZED", ["LEGACY_READ_ONLY forbids plans, recovery, leases, claims and Notion writes"], "finish the verified migration before recording; existing source facts remain read-only");
  if (parsed.data.external_event_evidence) {
    const { eventVersionAllowed } = await import("../effects/eventWrite.ts");
    if (!eventVersionAllowed(live.runtime)) return refused("HOLD_SCHEMA_MISMATCH", ["native event capture requires Sales 0.5.13 / schema 0.5.8 candidate"], "use the authorized candidate version; do not migrate a live runtime from this call");
  }
  return said(await commit(deps, live.binding, live.runtime, { ...(parsed.data.intent ? { intent: parsed.data.intent } : {}), ...(parsed.data.capability_evidence ? { capability_evidence: parsed.data.capability_evidence } : {}), ...(parsed.data.external_event_evidence ? { external_event_evidence: parsed.data.external_event_evidence } : {}) }, ctx));
}
