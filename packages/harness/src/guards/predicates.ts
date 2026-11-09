/**
 * Evaluation of the approved P0 predicates (Sales 0.5.11 candidate, W3.1R). A mechanical guard, not the Daily
 * P0–P5 engine: it compares typed values, never computes coverage or a BREACH, and never reads a free-text verdict.
 *
 * Three-valued: a leaf whose operand is not readable (another authority, outside the read allowlist, unconfirmed or
 * not in effect), whose types disagree, or whose pointer is not an effective constraint is UNKNOWN. ANY with one
 * true is true, ALL with one false is false, otherwise UNKNOWN stays UNVERIFIABLE.
 */
import type { Operand, Predicate, ValueType } from "./index.ts";
import { refKey, type GuardSnapshot } from "./snapshot.ts";

export type P0Verdict = "TRIGGERED" | "NOT_TRIGGERED" | "UNVERIFIABLE";
type Tri = boolean | undefined;
type Typed = { readonly type: ValueType; readonly value: string | number | boolean };

function valueOf(o: Operand, s: GuardSnapshot): Typed | undefined {
  if ("literal" in o) return { type: o.literal.value_type, value: o.literal.value };
  const r = s.refs.get(refKey(o.ref));
  return r && r.readable && r.known === true && r.value !== undefined ? { type: o.ref.value_type, value: r.value } : undefined;
}

export function evaluate(p: Predicate, s: GuardSnapshot): Tri {
  switch (p.op) {
    case "PRESENT": {
      const v = valueOf(p.operand, s);
      if (!v) return undefined;
      return v.type === "TEXT" ? v.value !== "" : true;
    }
    case "EQUAL": case "NOT_EQUAL": {
      const l = valueOf(p.left, s);
      const r = valueOf(p.right, s);
      if (!l || !r || l.type !== r.type) return undefined;
      return (l.value === r.value) === (p.op === "EQUAL");
    }
    case "NUMBER_LT": case "NUMBER_GTE": {
      const l = valueOf(p.left, s);
      const r = valueOf(p.right, s);
      if (!l || !r || l.type !== "NUMBER" || r.type !== "NUMBER" || typeof l.value !== "number" || typeof r.value !== "number") return undefined;
      return p.op === "NUMBER_LT" ? l.value < r.value : l.value >= r.value;
    }
    case "POINTER_STATUS_IS": {
      const c = s.constraints.get(p.config_id);
      return c ? c.status === p.status : undefined;
    }
    case "ALL": {
      const vs = p.terms.map((t) => evaluate(t, s));
      if (vs.includes(false)) return false;
      return vs.every((v) => v === true) ? true : undefined;
    }
    case "ANY": {
      const vs = p.terms.map((t) => evaluate(t, s));
      if (vs.includes(true)) return true;
      return vs.every((v) => v === false) ? false : undefined;
    }
  }
}

export interface P0Evaluation {
  /** One verdict per active P0 Decision Rule, by Rule ID. A rule without an index entry is UNVERIFIABLE. */
  readonly verdicts: ReadonlyMap<number, P0Verdict>;
  /** Index entries naming no active P0 rule: the index does not describe the rules it was approved for. */
  readonly extra: readonly number[];
}

export function evaluateP0(s: GuardSnapshot): P0Evaluation {
  const entries = new Map(s.index.p0_rules.map((e) => [e.rule_id, e.predicate]));
  const verdicts = new Map<number, P0Verdict>();
  for (const id of s.p0_rule_ids) {
    const predicate = entries.get(id);
    const v = predicate ? evaluate(predicate, s) : undefined;
    verdicts.set(id, v === true ? "TRIGGERED" : v === false ? "NOT_TRIGGERED" : "UNVERIFIABLE");
  }
  const active = new Set(s.p0_rule_ids);
  return { verdicts, extra: s.index.p0_rules.map((e) => e.rule_id).filter((id) => !active.has(id)) };
}
