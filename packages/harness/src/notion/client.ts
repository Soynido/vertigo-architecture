/**
 * Notion client (PV-WRITE-001 / W1.1, decision PDEC-018 — CANDIDATE, NOT ADOPTED).
 *
 * The harness's only path to api.notion.com. It reads exactly as before, and it can perform exactly two
 * writes: create a row in a data source, and update the properties of a page. Nothing else is reachable —
 * no archive, no delete, no block, no database, no comment, no icon or cover, no content — and each write
 * body is checked before it leaves the process. Nothing in the harness calls the two write methods yet:
 * the transaction executor (W1.4 onwards) will be their single caller, and PT-ARCH-004 will hold that.
 *
 * Retry discipline differs by direction, on purpose. A read, or any request refused with 429, was not
 * applied and is retried. A write that fails with 5xx, a timeout or a transport error MAY have been applied:
 * it is never retried here; it is reported as ambiguous and the executor decides (locate before resend).
 * Canary shared429Cooldown is stricter: first429 closes this instance to all future writes and a refused
 * write is never retried internally. The caller stops; recovery needs a fresh process/binding/guard.
 */

export interface NotionHttp {
  (input: string, init: { method: "GET" | "POST" | "PATCH"; headers: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{ status: number; headers?: { get(name: string): string | null }; json(): Promise<unknown> }>;
}

export interface NotionReadPolicy {
  /** Minimum spacing between two requests of this client. Ignored when ratePerSecond is set. */
  readonly minimumIntervalMs?: number;
  /** Token bucket: sustained requests per second for this client (one client per process). */
  readonly ratePerSecond?: number;
  /** Token bucket capacity. Defaults to 1 when ratePerSecond is set. */
  readonly burst?: number;
  /** Canary opt-in: reads share429 cooldown; first429 permanently closes this instance to writes. */
  readonly shared429Cooldown?: boolean;
  /** Canary opt-in: with shared cooldown, first429 also closes queued/future reads, without retry. */
  readonly abortReadsOn429?: boolean;
  readonly max429Retries?: number;
  readonly retryBaseMs?: number;
  /** Per-request timeout. 0 or absent disables it. */
  readonly requestTimeoutMs?: number;
}
export type NotionHttpPolicy = NotionReadPolicy;

const API = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03"; // Notion API version header, not a VERTIGO runtime version
const ID = "[0-9a-f-]+";

/** Allowlisted read endpoints. POST is permitted only where the Notion API uses it for reads. */
const READ_ALLOWLIST: ReadonlyArray<{ method: "GET" | "POST"; path: RegExp }> = [
  { method: "GET", path: new RegExp(`^/pages/${ID}$`) },
  { method: "GET", path: new RegExp(`^/pages/${ID}/properties/[^/]+$`) },
  { method: "GET", path: new RegExp(`^/blocks/${ID}$`) },
  { method: "GET", path: new RegExp(`^/blocks/${ID}/children(\\?.*)?$`) },
  { method: "GET", path: new RegExp(`^/databases/${ID}$`) },
  { method: "GET", path: new RegExp(`^/data_sources/${ID}$`) },
  { method: "POST", path: new RegExp(`^/data_sources/${ID}/query$`) },
  { method: "POST", path: new RegExp(`^/databases/${ID}/query$`) },
  { method: "POST", path: /^\/search$/ },
  { method: "GET", path: /^\/users\/me$/ },
];

/** The two write routes, and nothing else. */
const WRITE_ALLOWLIST: ReadonlyArray<{ method: "POST" | "PATCH"; path: RegExp }> = [
  { method: "POST", path: /^\/pages$/ },
  { method: "PATCH", path: new RegExp(`^/pages/${ID}$`) },
];

export class NotionWriteRefused extends Error {
  override readonly name = "NotionWriteRefused";
}

/** A Notion refusal or transport failure, classified for the caller. */
export class NotionApiError extends Error {
  override readonly name = "NotionApiError";
  readonly status: number | "TRANSPORT" | "TIMEOUT";
  /** Notion error code when the API gave one: validation_error, object_not_found, rate_limited, conflict_error… */
  readonly notionCode: string;
  /** true ⇒ Notion may have applied the write (5xx, timeout, transport): a CREATE must be located before any resend. */
  readonly ambiguous: boolean;
  /** true ⇒ a later attempt can succeed (429 exhausted, 409, 5xx, transport, timeout). */
  readonly retryable: boolean;
  constructor(status: number | "TRANSPORT" | "TIMEOUT", notionCode: string, ambiguous: boolean, retryable: boolean, message: string) {
    super(message);
    this.status = status;
    this.notionCode = notionCode;
    this.ambiguous = ambiguous;
    this.retryable = retryable;
  }
}

/**
 * Server-side order and page size of one data-source query (W2.3, read-only). Absent, the query is sent exactly as
 * before: no `sorts`, no `page_size`. The cursor stays internal to the caller that pages; it is never served.
 */
export interface NotionQueryOptions {
  readonly sorts?: readonly Readonly<Record<string, unknown>>[];
  /** 1 to 100, as the Notion API accepts it. */
  readonly page_size?: number;
}

export interface NotionReadClient {
  retrievePage(pageId: string): Promise<unknown>;
  retrieveDatabase(databaseId: string): Promise<unknown>;
  retrieveDataSource(dataSourceId: string): Promise<unknown>;
  retrieveBlockChildren(blockId: string, cursor?: string): Promise<unknown>;
  queryDataSource(dataSourceId: string, filter: unknown, cursor?: string, options?: NotionQueryOptions): Promise<unknown>;
}

/** One REST property value as sent to Notion, e.g. { rich_text: [...] } or { select: { name } }. */
export type NotionPropertyValue = Readonly<Record<string, unknown>>;
export type NotionProperties = Readonly<Record<string, NotionPropertyValue>>;

/** Who writes: for the operational trace (plan and symbol, never values). */
export interface NotionWriteContext {
  readonly plan_id: string;
  readonly symbol: string;
}

export interface NotionWriteResult {
  /** Normalized 32-hex page id. */
  readonly id: string;
  readonly last_edited_time: string;
}

export interface NotionWriter {
  /** POST /v1/pages { parent: { type: "data_source_id", data_source_id }, properties }. The only create: a row. */
  createPage(dataSourceId: string, properties: NotionProperties, ctx: NotionWriteContext): Promise<NotionWriteResult>;
  /** PATCH /v1/pages/{id} { properties }. Never archived, in_trash, icon, cover or content. */
  updatePage(pageId: string, properties: NotionProperties, ctx: NotionWriteContext): Promise<NotionWriteResult>;
}

export interface NotionClient extends NotionReadClient, NotionWriter {}

/** Refuses anything that is not an allowlisted read. Kept as the read-side guard. */
export function assertReadOnly(method: string, path: string): void {
  const allowed = READ_ALLOWLIST.some((r) => r.method === method && r.path.test(path));
  if (!allowed) throw new NotionWriteRefused(`refused ${method} ${path}: not an allowlisted Notion read`);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Refuses anything that is not one of the two allowlisted writes with an exactly-shaped body:
 * POST /pages carries only { parent: { type: "data_source_id", data_source_id }, properties };
 * PATCH /pages/{id} carries only { properties }.
 */
export function assertWriteAllowed(method: string, path: string, body: unknown): void {
  const route = WRITE_ALLOWLIST.find((r) => r.method === method && r.path.test(path));
  if (!route) throw new NotionWriteRefused(`refused ${method} ${path}: not one of the two allowlisted Notion writes`);
  if (!isRecord(body)) throw new NotionWriteRefused(`refused ${method} ${path}: the body must be an object`);
  const keys = Object.keys(body).sort();
  if (method === "POST") {
    if (keys.join(",") !== "parent,properties") throw new NotionWriteRefused(`refused POST /pages: body keys must be exactly parent and properties, got ${keys.join(", ") || "none"}`);
    const parent = body["parent"];
    if (!isRecord(parent) || Object.keys(parent).sort().join(",") !== "data_source_id,type" || parent["type"] !== "data_source_id" || typeof parent["data_source_id"] !== "string" || parent["data_source_id"] === "") {
      throw new NotionWriteRefused("refused POST /pages: the parent must be exactly { type: \"data_source_id\", data_source_id }");
    }
  } else if (keys.join(",") !== "properties") {
    throw new NotionWriteRefused(`refused PATCH ${path}: body keys must be exactly properties, got ${keys.join(", ") || "none"}`);
  }
  if (!isRecord(body["properties"])) throw new NotionWriteRefused(`refused ${method} ${path}: properties must be an object`);
}

const normalizeId = (id: string): string => id.replace(/-/g, "").toLowerCase();

async function notionCodeOf(res: { json(): Promise<unknown> }): Promise<string> {
  try {
    const body = await res.json();
    return isRecord(body) && typeof body["code"] === "string" ? body["code"] : "unknown";
  } catch {
    return "unknown";
  }
}

export class HttpNotionClient implements NotionClient {
  readonly #token: string;
  readonly #http: NotionHttp;
  readonly #minimumIntervalMs: number;
  readonly #ratePerSecond: number;
  readonly #burst: number;
  readonly #shared429Cooldown: boolean;
  readonly #abortReadsOn429: boolean;
  #cooldownUntil = 0;
  #writesInvalidated = false;
  readonly #max429Retries: number;
  readonly #retryBaseMs: number;
  readonly #requestTimeoutMs: number;
  #nextAllowedAt = 0;
  #tokens: number;
  #refilledAt = Date.now();
  #paceTail: Promise<void> = Promise.resolve();

  constructor(token: string, http: NotionHttp, policy: NotionHttpPolicy = {}) {
    this.#token = token;
    this.#http = http;
    this.#minimumIntervalMs = Math.max(0, policy.minimumIntervalMs ?? 0);
    this.#ratePerSecond = Math.max(0, policy.ratePerSecond ?? 0);
    this.#burst = Math.max(1, policy.burst ?? 1);
    this.#tokens = this.#burst;
    this.#shared429Cooldown = policy.shared429Cooldown === true;
    if (policy.abortReadsOn429 === true && !this.#shared429Cooldown) throw new Error("abortReadsOn429 requires shared429Cooldown");
    this.#abortReadsOn429 = policy.abortReadsOn429 === true;
    this.#max429Retries = Math.max(0, policy.max429Retries ?? 3);
    this.#retryBaseMs = Math.max(0, policy.retryBaseMs ?? 1);
    this.#requestTimeoutMs = Math.max(0, policy.requestTimeoutMs ?? 0);
  }

  /** Serializes every request of this client through one pacing queue, reads and writes alike. */
  async #pace(write = false): Promise<void> {
    let release = () => {};
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const before = this.#paceTail;
    this.#paceTail = before.then(() => turn);
    await before;
    try {
      if (write) this.#requireWritable(); else this.#requireReadable();
      // A later in-flight 429 can extend the pause while this request waits. Re-check before dispatch.
      while (Date.now() < this.#cooldownUntil) {
        await new Promise((resolve) => setTimeout(resolve, this.#cooldownUntil - Date.now()));
      }
      if (this.#ratePerSecond > 0) {
        const refill = () => {
          const now = Date.now();
          this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#refilledAt) / 1_000) * this.#ratePerSecond);
          this.#refilledAt = now;
        };
        refill();
        if (this.#tokens < 1) {
          await new Promise((resolve) => setTimeout(resolve, ((1 - this.#tokens) / this.#ratePerSecond) * 1_000));
          refill();
        }
        this.#tokens = Math.max(0, this.#tokens - 1);
      } else {
        const delay = Math.max(0, this.#nextAllowedAt - Date.now());
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        this.#nextAllowedAt = Date.now() + this.#minimumIntervalMs;
      }
      if (write) this.#requireWritable(); else this.#requireReadable();
      // A 429 may also arrive during token/spacing sleep; it still blocks this dispatch.
      while (Date.now() < this.#cooldownUntil) {
        await new Promise((resolve) => setTimeout(resolve, this.#cooldownUntil - Date.now()));
      }
    } finally {
      release();
    }
  }

  /** Never wait out429 then send under the old guard. No reset: caller must stop this canary process. */
  #requireWritable(): void {
    if (this.#writesInvalidated) throw new NotionApiError(429, "rate_limited", false, true,
      "canary write not dispatched after429; stop this instance and resume with fresh binding and guard");
  }

  #requireReadable(): void {
    if (this.#abortReadsOn429 && this.#writesInvalidated) throw new NotionApiError(429, "rate_limited", false, true,
      "canary read not dispatched after429; stop this instance, no reset or automatic recreation");
  }

  #init(method: "GET" | "POST" | "PATCH", body?: unknown) {
    return {
      method,
      headers: { Authorization: `Bearer ${this.#token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(this.#requestTimeoutMs > 0 ? { signal: AbortSignal.timeout(this.#requestTimeoutMs) } : {}),
    };
  }

  async #backoff(attempt: number, res: { headers?: { get(name: string): string | null } }, wait = true): Promise<void> {
    const retryAfter = Number(res.headers?.get("retry-after") ?? "");
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : this.#retryBaseMs * (2 ** attempt);
    if (this.#shared429Cooldown) {
      this.#writesInvalidated = true;
      this.#cooldownUntil = Math.max(this.#cooldownUntil, Date.now() + delay);
    }
    if (wait && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }

  async #read(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    assertReadOnly(method, path);
    for (let attempt = 0; attempt <= this.#max429Retries; attempt += 1) {
      this.#requireReadable();
      await this.#pace();
      this.#requireReadable(); // Close the microtask gap before HTTP, as for writes.
      const res = await this.#http(`${API}${path}`, this.#init(method, body));
      if (res.status !== 429) {
        if (res.status >= 400) throw new NotionApiError(res.status, await notionCodeOf(res), false, res.status >= 500, `notion read failed ${res.status} for ${method} ${path}`);
        return res.json();
      }
      if (this.#abortReadsOn429 || attempt === this.#max429Retries) {
        await this.#backoff(attempt, res, false);
        throw new NotionApiError(429, "rate_limited", false, true, `notion read failed 429 for ${method} ${path} after ${attempt + 1} attempts`);
      }
      await this.#backoff(attempt, res);
    }
    throw new Error(`notion read failed for ${method} ${path}`);
  }

  async #write(method: "POST" | "PATCH", path: string, body: unknown, ctx: NotionWriteContext): Promise<NotionWriteResult> {
    assertWriteAllowed(method, path, body);
    const where = `${method} ${path} (plan ${ctx.plan_id}, ${ctx.symbol})`;
    for (let attempt = 0; attempt <= this.#max429Retries; attempt += 1) {
      this.#requireWritable();
      await this.#pace(true);
      this.#requireWritable(); // Also closes the microtask gap between pacing completion and HTTP dispatch.
      let res: Awaited<ReturnType<NotionHttp>>;
      try {
        res = await this.#http(`${API}${path}`, this.#init(method, body));
      } catch (err) {
        const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
        throw new NotionApiError(timedOut ? "TIMEOUT" : "TRANSPORT", timedOut ? "timeout" : "transport_error", true, true, `notion write ${timedOut ? "timed out" : "failed in transport"} for ${where}`);
      }
      if (res.status === 429) {
        if (this.#shared429Cooldown) {
          await this.#backoff(attempt, res, false);
          throw new NotionApiError(429, "rate_limited", false, true, `canary write refused429 for ${where}; fresh process and guard required`);
        }
        // 429 means the request was not applied: retrying it cannot duplicate anything.
        if (attempt === this.#max429Retries) {
          await this.#backoff(attempt, res, false);
          throw new NotionApiError(429, "rate_limited", false, true, `notion write refused 429 for ${where} after ${attempt + 1} attempts`);
        }
        await this.#backoff(attempt, res);
        continue;
      }
      if (res.status >= 500) throw new NotionApiError(res.status, await notionCodeOf(res), true, true, `notion write failed ${res.status} for ${where}; it may have been applied`);
      if (res.status >= 400) throw new NotionApiError(res.status, await notionCodeOf(res), false, res.status === 409, `notion write refused ${res.status} for ${where}`);
      const page = await res.json();
      if (!isRecord(page) || typeof page["id"] !== "string") throw new NotionApiError(res.status, "malformed_response", true, false, `notion write for ${where} returned no page id`);
      return { id: normalizeId(page["id"]), last_edited_time: typeof page["last_edited_time"] === "string" ? page["last_edited_time"] : "UNKNOWN" };
    }
    throw new Error(`notion write failed for ${where}`);
  }

  retrievePage(pageId: string) { return this.#read("GET", `/pages/${pageId}`); }
  retrieveDatabase(databaseId: string) { return this.#read("GET", `/databases/${databaseId}`); }
  retrieveDataSource(dataSourceId: string) { return this.#read("GET", `/data_sources/${dataSourceId}`); }
  retrieveBlockChildren(blockId: string, cursor?: string) {
    return this.#read("GET", `/blocks/${blockId}/children${cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : ""}`);
  }
  queryDataSource(dataSourceId: string, filter: unknown, cursor?: string, options?: NotionQueryOptions) {
    const size = options?.page_size;
    if (size !== undefined && (!Number.isInteger(size) || size < 1 || size > 100)) {
      return Promise.reject(new Error(`refused query of ${dataSourceId}: page_size must be an integer from 1 to 100`));
    }
    return this.#read("POST", `/data_sources/${dataSourceId}/query`, {
      filter,
      ...(options?.sorts && options.sorts.length > 0 ? { sorts: options.sorts } : {}),
      ...(size !== undefined ? { page_size: size } : {}),
      ...(cursor ? { start_cursor: cursor } : {}),
    });
  }

  createPage(dataSourceId: string, properties: NotionProperties, ctx: NotionWriteContext): Promise<NotionWriteResult> {
    return this.#write("POST", "/pages", { parent: { type: "data_source_id", data_source_id: dataSourceId }, properties }, ctx);
  }
  updatePage(pageId: string, properties: NotionProperties, ctx: NotionWriteContext): Promise<NotionWriteResult> {
    return this.#write("PATCH", `/pages/${pageId}`, { properties }, ctx);
  }
}
