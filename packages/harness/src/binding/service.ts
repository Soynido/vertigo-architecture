/**
 * Binding service (PV0-005). Creates opaque server-side bindings fixed to principal / project / lane /
 * resolved runtime identity / runtime generation, with an absolute TTL, and checks liveness on every
 * stateful use: TTL ⇒ EXPIRED, principal no longer active ⇒ REVOKED, runtime generation changed ⇒ STALE.
 * A binding is never silently retargeted to a replacement runtime; the caller must os_bind again.
 */
import { randomUUID } from "node:crypto";
import type { Principal, PrincipalRegistry } from "../auth/principal.ts";
import type { HarnessConfig } from "../config/index.ts";
import type { ResolvedRuntime, ResolutionOutcome } from "../resolvers/types.ts";
import type { BackendStore } from "../store/memory.ts";
import type { Lane } from "../tools/envelope.ts";
import { generateHandle, hashHandle } from "./handle.ts";
import type { BindingRecord } from "./store.ts";

export interface CreatedBinding {
  readonly handle: string;
  readonly record: BindingRecord;
}

function versionValue(v: ResolvedRuntime["versions"]["governing_spec"]): string {
  return v === "UNKNOWN" ? "UNKNOWN" : v.value;
}

/** Creates a BOUND binding for an already authorized principal and an already resolved runtime. */
export async function createBinding(store: BackendStore, config: HarnessConfig, principal: Principal, project: string, lane: Lane, runtime: ResolvedRuntime, now: Date): Promise<CreatedBinding> {
  const handle = generateHandle();
  const record: BindingRecord = {
    binding_id: randomUUID(),
    handle_hash: hashHandle(handle),
    principal_id: principal.principal_id,
    project,
    lane,
    runtime_logical_key: runtime.logical_key,
    runtime_id: runtime.runtime_id,
    runtime_generation: runtime.runtime_generation,
    binding_mode: runtime.access_mode,
    install_phase: runtime.access_mode === "INSTALL_ONLY" ? "INSTALL_PENDING" : "NOT_APPLICABLE",
    resolved_manifest_ref: runtime.manifest_ref,
    governing_versions_snapshot: { spec: versionValue(runtime.versions.governing_spec), schema: versionValue(runtime.versions.governing_schema), control: versionValue(runtime.versions.governing_control) },
    status: "BOUND",
    created_at: now,
    expires_at: new Date(now.getTime() + config.bindingTtlHours * 3600 * 1000),
  };
  await store.bindings.insert(record);
  await store.events.append({ event_type: "BIND_CREATED", result: "BOUND", principal_id: principal.principal_id, binding_id: record.binding_id, runtime_id: record.runtime_id, created_at: now });
  return { handle, record };
}

export type LivenessOutcome =
  | { readonly ok: true; readonly principal: Principal; readonly runtime: ResolvedRuntime }
  | { readonly ok: false; readonly kind: "REVOKED" }
  | { readonly ok: false; readonly kind: "EXPIRED" }
  | { readonly ok: false; readonly kind: "ROTATED"; readonly previous_generation: string; readonly current_generation: string }
  | { readonly ok: false; readonly kind: "RUNTIME_CHANGED"; readonly previous_runtime_id: string; readonly current_runtime_id: string }
  | { readonly ok: false; readonly kind: "VERSION_CHANGED"; readonly changes: readonly string[] }
  | { readonly ok: false; readonly kind: "MODE_CHANGED"; readonly previous_mode: BindingRecord["binding_mode"]; readonly current_mode: ResolvedRuntime["access_mode"] }
  | { readonly ok: false; readonly kind: "RESOLUTION_HOLD"; readonly outcome: Extract<ResolutionOutcome, { kind: "HOLD" }> };

/**
 * Liveness of a binding whose ownership has ALREADY been verified for the calling principal.
 * Order: TTL, principal status, then a fresh runtime resolution whose generation must match.
 * State transitions are persisted (EXPIRED / REVOKED / STALE) and never reversed.
 */
export async function checkLiveness(
  store: BackendStore,
  principals: PrincipalRegistry,
  binding: BindingRecord,
  now: Date,
  resolve: (principal: Principal, project: string, lane: Lane) => Promise<ResolutionOutcome>,
): Promise<LivenessOutcome> {
  if (binding.expires_at <= now) {
    if (binding.status === "BOUND") {
      await store.bindings.setStatus(binding.binding_id, "EXPIRED");
      await store.events.append({ event_type: "BIND_EXPIRED", result: "EXPIRED", principal_id: binding.principal_id, binding_id: binding.binding_id, runtime_id: binding.runtime_id, created_at: now });
    }
    return { ok: false, kind: "EXPIRED" };
  }
  const principal = await principals.get(binding.principal_id);
  if (!principal || principal.status !== "ACTIVE") {
    if (binding.status === "BOUND") {
      await store.bindings.setStatus(binding.binding_id, "REVOKED");
      await store.events.append({ event_type: "BIND_REVOKED", result: "REVOKED", principal_id: binding.principal_id, binding_id: binding.binding_id, runtime_id: binding.runtime_id, created_at: now });
    }
    return { ok: false, kind: "REVOKED" };
  }
  const outcome = await resolve(principal, binding.project, binding.lane);
  if (outcome.kind === "HOLD") return { ok: false, kind: "RESOLUTION_HOLD", outcome };
  if (outcome.runtime.access_mode !== binding.binding_mode) {
    if (binding.status === "BOUND") {
      await store.bindings.setStatus(binding.binding_id, "STALE");
      await store.events.append({ event_type: "BIND_MODE_CHANGED", result: "STALE", principal_id: binding.principal_id, binding_id: binding.binding_id, runtime_id: binding.runtime_id, detail: { previous_mode: binding.binding_mode, current_mode: outcome.runtime.access_mode }, created_at: now });
    }
    return { ok: false, kind: "MODE_CHANGED", previous_mode: binding.binding_mode, current_mode: outcome.runtime.access_mode };
  }
  if (outcome.runtime.runtime_id !== binding.runtime_id) {
    if (binding.status === "BOUND") {
      await store.bindings.setStatus(binding.binding_id, "STALE");
      await store.events.append({ event_type: "RUNTIME_ASSIGNMENT_CHANGED", result: "STALE", principal_id: binding.principal_id, binding_id: binding.binding_id, runtime_id: binding.runtime_id, detail: { previous_runtime_id: binding.runtime_id, current_runtime_id: outcome.runtime.runtime_id }, created_at: now });
    }
    return { ok: false, kind: "RUNTIME_CHANGED", previous_runtime_id: binding.runtime_id, current_runtime_id: outcome.runtime.runtime_id };
  }
  if (outcome.runtime.runtime_generation !== binding.runtime_generation) {
    if (binding.status === "BOUND") {
      await store.bindings.setStatus(binding.binding_id, "STALE");
      await store.events.append({ event_type: "RUNTIME_ROTATION_DETECTED", result: "STALE", principal_id: binding.principal_id, binding_id: binding.binding_id, runtime_id: binding.runtime_id, detail: { previous_generation: binding.runtime_generation, current_generation: outcome.runtime.runtime_generation }, created_at: now });
    }
    return { ok: false, kind: "ROTATED", previous_generation: binding.runtime_generation, current_generation: outcome.runtime.runtime_generation };
  }
  const currentVersions = {
    spec: versionValue(outcome.runtime.versions.governing_spec),
    schema: versionValue(outcome.runtime.versions.governing_schema),
    control: versionValue(outcome.runtime.versions.governing_control),
  };
  const changes = Object.entries(currentVersions)
    .filter(([key, value]) => (binding.governing_versions_snapshot[key] ?? "UNKNOWN") !== value)
    .map(([key, value]) => `${key}: ${binding.governing_versions_snapshot[key] ?? "UNKNOWN"} -> ${value}`);
  // INSTALL_ONLY handles pin the exact governing contract used to build their
  // authority snapshot, so a version change must invalidate them before any
  // install write or promotion can continue. Ordinary BUSINESS handles are
  // intentionally different: resume/control must receive the freshly resolved
  // runtime so their adapter-specific version transition and FINAL-conflict
  // logic can qualify the change themselves.
  if (changes.length > 0 && binding.binding_mode === "INSTALL_ONLY") {
    if (binding.status === "BOUND") {
      await store.bindings.setStatus(binding.binding_id, "STALE");
      await store.events.append({ event_type: "GOVERNING_VERSION_CHANGED", result: "STALE", principal_id: binding.principal_id, binding_id: binding.binding_id, runtime_id: binding.runtime_id, detail: { changes }, created_at: now });
    }
    return { ok: false, kind: "VERSION_CHANGED", changes };
  }
  return { ok: true, principal, runtime: outcome.runtime };
}
