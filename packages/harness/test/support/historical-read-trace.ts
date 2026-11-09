/** Diagnostic only. Never imported by the served harness; no retry, writer or authority. */
import type { NotionReadClient } from "../../src/notion/client.ts";

const METHODS = ["retrievePage", "retrieveDatabase", "retrieveDataSource", "retrieveBlockChildren", "queryDataSource"] as const;
const CLASSES = ["NotionApiError", "Error", "TypeError", "AbortError"];
const CODES = ["unauthorized", "restricted_resource", "object_not_found", "validation_error", "rate_limited", "internal_server_error", "service_unavailable", "invalid_request_url", "invalid_json", "missing_version", "conflict_error"];
export interface SafeReadFailure {
  class: string;
  status: number | "TIMEOUT" | "TRANSPORT" | "UNKNOWN";
  notion_code: string;
}
/** Only data descriptors: do not touch message, stack, body, URL, headers or hostile getters. */
export function safeReadFailure(error: unknown): SafeReadFailure {
  const unknown: SafeReadFailure = { class: "UNKNOWN", status: "UNKNOWN", notion_code: "WITHHELD" };
  if (error === null || typeof error !== "object") return unknown;
  try {
    const data = (key: string): unknown => Object.getOwnPropertyDescriptor(error, key)?.value;
    const proto = Object.getPrototypeOf(error) as object | null;
    const ctor: unknown = proto ? Object.getOwnPropertyDescriptor(proto, "constructor")?.value : undefined;
    const name: unknown = typeof ctor === "function" ? Object.getOwnPropertyDescriptor(ctor, "name")?.value : undefined;
    const status = data("status"), code = data("notionCode");
    return {
      class: typeof name === "string" && CLASSES.includes(name) ? name : unknown.class,
      status: typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status
        : status === "TIMEOUT" || status === "TRANSPORT" ? status : unknown.status,
      notion_code: typeof code === "string" && CODES.includes(code) ? code : unknown.notion_code,
    };
  } catch { return unknown; }
}

export interface ReadTraceRow {
  attempt: number;
  method: typeof METHODS[number];
  ref: string | "INVALID_REF";
  outcome: "VALUE" | "ERROR";
  method_elapsed_ms: number | null;
  failure?: SafeReadFailure;
}
export interface ReadTrace { rows: ReadTraceRow[]; total_attempts: number; dropped: number; complete: boolean }

export function traceHistoricalReads(source: NotionReadClient, limit = 600, clock = Date.now): {
  client: NotionReadClient;
  snapshot(): ReadTrace;
} {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error("INVALID_TRACE_BOUND");
  const rows: ReadTraceRow[] = [];
  let attempts = 0, dropped = 0;
  const time = (): number | null => { try { const n = clock(); return Number.isFinite(n) ? n : null; } catch { return null; } };
  const elapsed = (start: number | null): number | null => {
    const end = time(); return start !== null && end !== null && end >= start ? end - start : null;
  };
  const append = (row: ReadTraceRow) => { if (rows.length < limit) rows.push(row); else dropped++; };
  const client = Object.freeze(Object.fromEntries(METHODS.map(method => [method, async (...args: unknown[]) => {
    const attempt = ++attempts, start = time(), first = args[0];
    const ref = typeof first === "string" && /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(first)
      ? first.replaceAll("-", "").toLowerCase() : "INVALID_REF";
    try {
      const value = await Reflect.apply(source[method], source, args);
      append({ attempt, method, ref, outcome: "VALUE", method_elapsed_ms: elapsed(start) });
      return value;
    } catch (error) {
      append({ attempt, method, ref, outcome: "ERROR", method_elapsed_ms: elapsed(start), failure: safeReadFailure(error) });
      throw error;
    }
  }]))) as unknown as NotionReadClient;
  return { client, snapshot: () => structuredClone({ rows, total_attempts: attempts, dropped, complete: dropped === 0 }) };
}
