/**
 * SETUP context sources — CONTRACT_PACK/0.3.0-candidate (W2.2). READ-ONLY: this module never writes, never plans
 * and never decides a step.
 *
 * It supplies the four sources the catalogue declares for SETUP, and only for the SALES lane:
 *  - `SETUP_POSITION`: the durable gate, its formal question as already derived, and `ResumeState.next_safe_action`
 *    carried verbatim — never an action rebuilt here;
 *  - `SETUP_PENDING_INPUT`: the ADDRESS of the declaration the step still waits for, one row per field that must
 *    carry the seller's answer. Never its structured values and never an intent: the executable intent lives only
 *    in `next.prepare_intent`, in the exact shape `os_prepare` accepts;
 *  - `SETUP_RULES` / `SETUP_ANSWERS`: the confirmed answers of the steps BEFORE the open gate, exactly as the bound
 *    governing contract's cursor transitions name them in the seller's own Business Configuration.
 *
 * Anything that cannot be resolved truthfully is ABSENT, never guessed, and never changes the resume status or the
 * pack's completeness. Values reach the projector only (D7): no evidence line, warning, log or event is built here.
 */
import type { NotionReadClient } from "../notion/readClient.ts";
import { propText, type Page } from "../notion/shapes.ts";
import { discoverDataSource, naturalKeyFilter, queryAll, readSchema } from "../plans/resources.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
import type { GateView, ResumeState } from "../resume/derive.ts";
import type { Lane } from "../tools/envelope.ts";
import type { DerivedCursorTransition } from "../versions/adapters/controlPlane.ts";
import { NEED_CONTEXT, SETUP_SOURCE_KEYS, type ContextNeed } from "./catalog.ts";
import type { ContextSource } from "./pack.ts";

const BUSINESS_CONFIG = "SALES:BUSINESS_CONFIG";
const CONFIG_ITEM = "Config Item";

/**
 * The six Business Configuration columns an answer is read from, each with the only type it may have. A predicate
 * naming any other column is not read under an inferred type: the answers are ABSENT instead.
 */
const ANSWER_COLUMNS: Readonly<Record<string, string>> = {
  [CONFIG_ITEM]: "title", Category: "select", State: "select", Value: "rich_text", Version: "rich_text", Source: "rich_text",
};

/** Served key → Business Configuration column, in projection order. `step_key` is the transition's own gate. */
const ANSWER_PROJECTION: ReadonlyArray<readonly [string, string]> = [
  ["config_item", CONFIG_ITEM], ["category", "Category"], ["state", "State"], ["value", "Value"], ["version", "Version"], ["source", "Source"],
];

/** The already-derived resume facts SETUP carries. Consumed, never reclassified. */
export type SetupSafety = Pick<ResumeState, "gate" | "next_safe_action" | "pending_step_input">;

const absent = (source_key: string): ContextSource => ({ source_key, status: "ABSENT", rows: [] });
const present = (source_key: string, rows: readonly unknown[]): ContextSource => ({ source_key, status: "PRESENT", rows });

/** Whether the normalized needs select the SETUP context at all. When they do not, nothing is read. */
export function setupSelected(needs: readonly ContextNeed[]): boolean {
  return needs.some((n) => NEED_CONTEXT[n] === "SETUP");
}

/**
 * The SETUP sources for this turn. Empty when SETUP is not selected. On META, the four sections exist and all four
 * are ABSENT: W2.2 projects no META business content, and no SALES value crosses the lane. Call it only outside an
 * outer HOLD: a held resume supplies no SETUP source, so its four sections are ABSENT.
 */
export async function readSetupSources(client: NotionReadClient, runtime: ResolvedRuntime, lane: Lane, needs: readonly ContextNeed[], safety: SetupSafety): Promise<readonly ContextSource[]> {
  if (!setupSelected(needs)) return [];
  if (lane !== "SALES") return Object.values(SETUP_SOURCE_KEYS).map(absent);
  let answers: { readonly rules: readonly unknown[]; readonly answers: readonly unknown[] } | undefined;
  try {
    answers = await readAnswers(client, runtime, safety.gate);
  } catch {
    // An unreadable source is ABSENT. The failure is not echoed: its message could name a stored value.
    answers = undefined;
  }
  return [
    positionSource(safety),
    pendingSource(safety),
    answers ? present(SETUP_SOURCE_KEYS.RULES, answers.rules) : absent(SETUP_SOURCE_KEYS.RULES),
    answers ? present(SETUP_SOURCE_KEYS.ANSWERS, answers.answers) : absent(SETUP_SOURCE_KEYS.ANSWERS),
  ];
}

function positionSource(safety: SetupSafety): ContextSource {
  const g = safety.gate;
  if (!g) return absent(SETUP_SOURCE_KEYS.POSITION);
  return present(SETUP_SOURCE_KEYS.POSITION, [{ gate_key: g.gate_key, gate_status: g.status, next_question: g.formal_next_question, next_safe_action: safety.next_safe_action }]);
}

function pendingSource(safety: SetupSafety): ContextSource {
  const p = safety.pending_step_input;
  return present(SETUP_SOURCE_KEYS.PENDING_INPUT, p
    ? p.required_non_empty.map((answer_field) => ({ gate_key: p.gate_key, logical_resource_key: p.logical_resource_key, natural_key: p.natural_key, answer_field }))
    : []);
}

/** A cell read under its one admitted type: title / rich_text as concatenated plain_text, select as its name. Untrimmed. */
function cell(row: Page, column: string): string | undefined {
  return row.properties[column]?.type === ANSWER_COLUMNS[column] ? propText(row, column) : undefined;
}

/** Every published predicate, compared after trim() like the transition observer. Only the served values stay raw. */
function conforms(row: Page, t: DerivedCursorTransition): boolean {
  return Object.entries(t.evidence.equals).every(([column, value]) => (cell(row, column) ?? "").trim() === value.trim())
    && t.evidence.nonEmpty.every((column) => (cell(row, column) ?? "").trim() !== "");
}

function project(row: Page, stepKey: string): Record<string, string> {
  const out: Record<string, string> = { step_key: stepKey };
  for (const [key, column] of ANSWER_PROJECTION) {
    const v = cell(row, column);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * The answers already given for the steps before the open gate, split by their PUBLISHED category: CONSTRAINT is a
 * rule, anything else an answer. `undefined` means both sections are ABSENT — there is no partial answer.
 *
 * Relevant means exactly: a cursor transition of the bound governing contract whose evidence lives in
 * SALES:BUSINESS_CONFIG and whose `fromGate` comes strictly before the current gate in its `gateSequence`. The
 * database is discovered under the bound runtime root by the existing discovery; no Registry copy addresses it.
 */
async function readAnswers(client: NotionReadClient, runtime: ResolvedRuntime, gate: GateView | undefined): Promise<{ rules: unknown[]; answers: unknown[] } | undefined> {
  const cp = runtime.adapter.controlPlane;
  const sequence = cp.gateSequence?.gates;
  if (!sequence || !gate || gate.status !== "OPEN" || typeof gate.gate_key !== "string") return undefined;
  const at = sequence.indexOf(gate.gate_key);
  if (at < 0) return undefined; // READY is terminal, and HOLD or an unknown step is not a step of the walk
  const relevant = (cp.cursorTransitions ?? []).filter((t) => {
    const from = sequence.indexOf(t.fromGate);
    return t.evidence.logicalResourceKey === BUSINESS_CONFIG && from >= 0 && from < at;
  });

  // Structural refusals need no data, so they are decided before anything is read.
  const keys = relevant.map((t) => t.evidence.naturalKey);
  if (new Set(keys).size !== keys.length) return undefined;
  if (relevant.some((t) => !Object.hasOwn(t.evidence.equals, "Category"))) return undefined;
  if (relevant.some((t) => [...Object.keys(t.evidence.equals), ...t.evidence.nonEmpty].some((c) => !Object.hasOwn(ANSWER_COLUMNS, c)))) return undefined;
  const spec = cp.resources?.[BUSINESS_CONFIG];
  if (!spec || (spec.scope ?? "RUNTIME") !== "RUNTIME" || spec.naturalKeyProperty !== CONFIG_ITEM) return undefined;

  const disc = await discoverDataSource(client, runtime, spec);
  if (!disc.ok) return undefined;
  // Nothing before this gate: the answer is "none yet", stated without reading the schema or any row.
  if (relevant.length === 0) return { rules: [], answers: [] };
  const schema = await readSchema(client, disc.ds);
  if (!schema || Object.entries(ANSWER_COLUMNS).some(([column, type]) => schema.properties.get(column) !== type)) return undefined;

  const rules: unknown[] = [];
  const answers: unknown[] = [];
  for (const t of relevant) {
    const key = t.evidence.naturalKey;
    // One server filter, on the key alone; then the same client-side check as findRows. Duplicates are counted
    // here, before any other predicate, so a confirmed row can never hide a rival draft.
    const rows = (await queryAll(client, disc.ds, naturalKeyFilter(ANSWER_COLUMNS[CONFIG_ITEM], CONFIG_ITEM, key)))
      .filter((p) => (propText(p, CONFIG_ITEM) ?? "").trim() === key.trim());
    if (rows.length > 1) return undefined;
    const row = rows[0];
    if (!row || !conforms(row, t)) continue;
    ((t.evidence.equals["Category"] ?? "").trim() === "CONSTRAINT" ? rules : answers).push(project(row, t.fromGate));
  }
  return { rules, answers };
}
