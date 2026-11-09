import type { BindingRecord } from "./store.ts";

/**
 * The runtime binding a Production Guard approval belongs to (W3.1). A chat handle expires with its conversation;
 * the approval must not. It is bound to what the handle binds: this principal's assignment to this physical runtime
 * in this project and lane. The generation is kept beside it and compared on every use, so a rotated runtime has
 * no approval until the operator renews it.
 */
export function guardBindingId(b: Pick<BindingRecord, "project" | "lane" | "principal_id" | "runtime_logical_key" | "runtime_id">): string {
  return JSON.stringify(["SALES_GUARD_BINDING/1", b.project, b.lane, b.principal_id, b.runtime_logical_key, b.runtime_id]);
}
