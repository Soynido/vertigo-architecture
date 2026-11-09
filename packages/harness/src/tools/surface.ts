import { z } from "zod";

/**
 * W3.3 — the five-tool surface of the BUILD TARGET (PDEC-018, PLUGIN_SPEC/0.5.0-candidate, NOT ADOPTED): exactly
 * these names are announced by ListTools. The LIVE manifest (`packages/plugin/manifest.json`) keeps its six names
 * until adoption; the two are proved separately, never declared equal. No other tool may be exported. Forbidden:
 * os_finalize, os_mark_verified, os_set_gate, os_create_run, os_update_manifest, os_write_notion, os_control_pass.
 */
export const TOOL_NAMES = ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"] as const;
export type PublicToolName = (typeof TOOL_NAMES)[number];

/**
 * The historical six handler names. `os_prepare` / `os_verify` are no longer announced and answer only the W3.2
 * upgrade refusal over MCP; their handlers stay internal (historical suites, the renderer kept until W3.3L).
 */
export const HANDLER_NAMES = ["os_bind", "os_resume", "os_prepare", "os_verify", "os_handoff", "os_control_status"] as const;
export type ToolName = (typeof HANDLER_NAMES)[number];

export const laneSchema = z.enum(["META", "SALES"]);

const osPrepareObject = z
  .object({
    binding_handle: z.string().min(1),
    intent: z
      .object({
        action_class: z.string().min(1),
        summary: z.string().min(1),
        mutations: z
          .array(
            z
              .object({
                logical_resource_key: z.string().min(1),
                operation: z.enum(["CREATE", "UPDATE", "UPSERT"]),
                record_selector: z.object({ natural_key: z.string().optional(), logical_record_key: z.string().optional(), existing_object_id: z.string().optional() }).strict(),
                desired_changes: z.record(z.unknown()),
              })
              .strict(),
          )
          .min(1),
      })
      .strict()
      .optional(),
    capability_evidence: z
      .object({
        challenge: z.string().min(1).max(8192),
        competent_source: z.string().min(1).max(128),
        source_identity: z.string().min(1).max(320).refine((v) => !/[;|\u0000-\u001f\u007f]/.test(v), "source_identity contains a reserved delimiter or control character").optional(),
        evidence_ref: z.string().min(1).max(512).refine((v) => !/[|\u0000-\u001f\u007f]/.test(v), "evidence_ref contains a reserved delimiter or control character"),
        verified_at: z.string().datetime({ offset: true }),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Business intent and backend-owned capability evidence are mutually exclusive at the public schema boundary. */
const osPrepareSchema = Object.assign(
  osPrepareObject.superRefine((value, ctx) => {
    if (value.intent && value.capability_evidence) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "intent and capability_evidence are mutually exclusive" });
  }),
  // Preserve the frozen-surface structural introspection used by architecture tests.
  { shape: osPrepareObject.shape },
);

// W4.3: an outbound native-read attestation, not server verification of Gmail.
const opaque = (max: number) => z.string().min(1).max(max).refine((v) => !/[|;\u0000-\u001f\u007f]/.test(v));
const mailbox = z.string().email().max(320);
const pageUuid = z.string().regex(/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i, "expected a Notion UUID");
export const externalEventEvidenceSchema = z.object({
  provider: z.literal("GMAIL"), source_identity: mailbox, evidence_ref: opaque(512), observed_at: z.string().datetime({ offset: true }),
  message: z.object({ message_id: opaque(256), thread_id: opaque(256), from: mailbox, to: z.array(mailbox).min(1).max(20),
    date: z.string().datetime({ offset: true }), subject: z.string().max(512).optional(), action_key: opaque(256).optional() }).strict(),
  contact_refs: z.array(pageUuid).min(1).max(20), intent_ref: pageUuid.optional(),
}).strict();
export type ExternalEventEvidence = z.infer<typeof externalEventEvidenceSchema>;
const osCommitObject = osPrepareObject.extend({ external_event_evidence: externalEventEvidenceSchema.optional() });
const osCommitSchema = Object.assign(osCommitObject.superRefine((v, ctx) => {
  if ([v.intent, v.capability_evidence, v.external_event_evidence].filter(Boolean).length > 1)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "intent, capability_evidence and external_event_evidence are mutually exclusive" });
}), { shape: osCommitObject.shape });

/** Only LLM-controlled inputs. Authority fields (roots, runtime IDs, owners, gates, versions) are rejected. */
export const toolInputSchemas = {
  os_bind: z.object({ project: z.string().min(1).optional(), lane: laneSchema.optional() }).strict(),
  os_resume: z.object({ binding_handle: z.string().min(1), topic_hint: z.string().optional() }).strict(),
  os_prepare: osPrepareSchema,
  os_verify: z.object({ binding_handle: z.string().min(1), plan_id: z.string().min(1), phase: z.enum(["TARGET", "FINAL"]) }).strict(),
  os_handoff: z.object({ binding_handle: z.string().min(1), format_hint: z.string().optional() }).strict(),
  os_control_status: z.object({ binding_handle: z.string().min(1), scope_hint: z.string().optional() }).strict(),
  /** Candidate os_commit: legacy intent/evidence inputs plus the version-gated W4.3 native capture. */
  os_commit: osCommitSchema,
} as const satisfies Record<ToolName | PublicToolName, z.ZodTypeAny>;

/** os_commit — PDEC-018 candidate, NOT ADOPTED; W4.3 adds only a version-gated native capture. */
export const COMMIT_TOOL_NAME = "os_commit" as const;
export const commitInputSchema = toolInputSchemas.os_commit;
export const candidateResumeDescription = "Returns the bound space's current durable state and bounded selected context. Before returning, the server resumes its own unfinished work and may journal bounded user-local Notion changes as observed, without confirmation; authority, external facts and published doctrine are never adopted as local changes. Inputs: binding_handle, optional topic_hint read-plan tokens. Chat history is never state. Returns say and next.conduct; a hold does not grant write or send authority.";
export const commitDescription = "Prepares, writes, reads back and proves one transaction on the server inside the bound space, then the step movement it authorizes when time allows. Inputs: binding_handle, and either the intent served by os_resume, capability_evidence from a remediation challenge, external_event_evidence (one outbound native Gmail capture, only on Sales 0.5.13 candidate), or nothing (backend-derived step movement). Native captures are caller attestations, never server-verified Gmail effects. Returns a transaction outcome with `say`.";

/**
 * Factual descriptions (PV-CONDUCT-001). A description says WHAT a tool is and takes; it is read once at
 * initialize and cached by the client for the connector's lifetime, and a description written as a page of
 * imperatives was flagged by ChatGPT as a suspicious instruction. What to DO with a reply travels on the reply
 * itself, as `next.conduct`, computed live in tools/conduct.ts — so behaviour ships with a backend deploy and
 * never needs the connector to be recreated.
 */
export const toolDescriptions: Readonly<Record<ToolName | PublicToolName, string>> = {
  os_bind: "Call this first, before anything else, on the first message of every conversation about the user's VERTIGO space (META OS pilotage or Personal SALES OS prospection), with no arguments and without asking the user anything: nothing about that space — its step, its question, its state — is known before this has returned, and chat memory is never a substitute. Opens the space for this conversation and returns an opaque, expiring binding_handle. Optional inputs: project and lane; on the first call both are omitted and inferred from the authenticated user. Roots, runtime IDs, owners, current gate, current Run and versions are backend-resolved and never accepted from the caller. Read-only. Every reply carries `say` (the sentence for the user) and `next.conduct` (what to do with the reply).",
  os_resume: "The only source of the space's current state — current step, its question, open work, a pending answer or confirmation — read live from Notion on every message, after os_bind; chat history and memory are never state. Inputs: binding_handle, plus an optional topic_hint made of read-plan tokens. Read-only for an installed space; for a space still being installed, it performs the next bounded batch of that installation on the server. The reply carries `say` and `next.conduct`.",
  os_prepare: "Prepares one backend transaction plan and returns the Notion actions that the native Notion app must execute; this tool writes nothing. Inputs: binding_handle, and either the intent served by os_resume, or capability_evidence from a remediation challenge, or nothing at all (the backend then derives the installation step or the authorized step movement). The reply carries `say` and `next.conduct`.",
  os_verify: "Verifies a prepared plan by independent readback of Notion. phase TARGET reads back the stage-1 writes; phase FINAL reads back the finalization writes and the last State write. Returns the next rendered actions or the verified result, with `say` and `next.conduct`. Read-only.",
  os_handoff: "Produces a handoff text from current durable state. Read-only; the caller cannot supply the next lane, run or gate.",
  os_control_status: "Reports CONTROL status under the governing CONTROL version. Read-only; candidate versions are reported, never applied.",
  os_commit: commitDescription,
};
