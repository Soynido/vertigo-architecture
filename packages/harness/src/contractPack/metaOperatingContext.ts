import type { NotionReadClient } from "../notion/readClient.ts";
import type { ResolvedRuntime } from "../resolvers/types.ts";
type Status = "NOT_SELECTED" | "UNAVAILABLE" | "PARTIAL" | "COMPLETE";
type RecordValue = Record<string, unknown>;
type Issue = {
    ref: string;
    code: string;
};
type Document = {
    role: string;
    page_ref: string;
    last_edited_time?: string;
    status: Status;
    items: Array<{
        block_ref: string;
        parent_ref?: string;
        type: string;
        text: string;
    }>;
    issues: Issue[];
};
type Table = {
    role: string;
    registry_key: string;
    database_ref?: string;
    data_source_ref?: string;
    status: Status;
    has_more: boolean | "UNKNOWN";
    rows: Array<{
        page_ref: string;
        last_edited_time?: string;
        values: RecordValue;
    }>;
    omitted_columns: string[];
    issues: Issue[];
};
export interface MetaOperatingContext {
    readonly policy_role: "CANDIDATE_NOT_ADOPTED";
    readonly trust: "SOURCE_DATA_ONLY";
    readonly effectivity: "NOT_EVALUATED";
    readonly scope: "BOUND_META_PRIVATE_OPERATING_SOURCES_ONLY";
    readonly status: Status;
    readonly mapping_adapter_version?: string;
    readonly governing_schema_version?: string;
    readonly root_ref?: string;
    readonly atomic: false;
    readonly stability: "NOT_VERIFIED";
    readonly references_followed: false;
    readonly reads: number;
    readonly blocks_seen: number;
    readonly issues_omitted: number;
    readonly limits: typeof LIMITS;
    readonly documents: readonly Document[];
    readonly tables: readonly Table[];
    readonly issues: readonly Issue[];
}
const LIMITS = { reads: 20, document_reads: 5, reserved_table_reads: 6, blocks: 512, depth: 4, response_bytes: 96 * 1024, document_bytes: 24 * 1024, table_bytes: 20 * 1024, rows_per_table: 11 } as const;
const record = (v: unknown): v is RecordValue => v !== null && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v.replaceAll("-", "").toLowerCase()) ? v.replaceAll("-", "").toLowerCase() : undefined;
function pointer(v: unknown): string | undefined { if (typeof v !== "string")
    return undefined; const direct = uuid(v); if (direct)
    return direct; try {
    const u = new URL(v);
    return uuid(u.pathname.split("/").at(-1));
}
catch {
    return undefined;
} }
function parent(v: RecordValue, type: string, id: string) { return record(v.parent) && v.parent.type === type && uuid(v.parent[type]) === id; }
const active = (v: RecordValue) => v.archived === false && v.in_trash !== true;
function text(v: unknown): string { if (!Array.isArray(v) || v.some(x => !record(x) || typeof x.plain_text !== "string"))
    throw Error("TEXT"); return v.map(x => (x as {
    plain_text: string;
}).plain_text).join(""); }
function cell(v: unknown, type: string): unknown {
    if (!record(v) || v.type !== type)
        throw Error("CELL");
    const b = v[type];
    if (type === "rich_text" || type === "title")
        return text(b);
    if (type === "select") {
        if (b === null)
            return null;
        if (!record(b) || typeof b.name !== "string")
            throw Error("SELECT");
        return b.name;
    }
    if (type === "url" || type === "created_time" || type === "last_edited_time") {
        if (b !== null && typeof b !== "string")
            throw Error("STRING");
        return b;
    }
    if (type === "number") {
        if (b !== null && (typeof b !== "number" || !Number.isFinite(b)))
            throw Error("NUMBER");
        return b;
    }
    if (type === "date") {
        if (b === null)
            return null;
        if (!record(b) || typeof b.start !== "string" || (b.end !== null && typeof b.end !== "string") || (b.time_zone !== null && typeof b.time_zone !== "string"))
            throw Error("DATE");
        return { start: b.start, end: b.end, time_zone: b.time_zone };
    }
    if (type === "people") {
        if (!Array.isArray(b) || b.some(x => !record(x) || !uuid(x.id)))
            throw Error("PEOPLE");
        return b.map(x => ({ id: (x as RecordValue).id }));
    }
    if (type === "unique_id") {
        if (!record(b) || !Number.isSafeInteger(b.number) || (b.number as number) < 0 || (b.prefix !== null && typeof b.prefix !== "string"))
            throw Error("ID");
        return { number: b.number, prefix: b.prefix };
    }
    throw Error("TYPE");
}
const DECISIONS = { Decision: "title", Status: "select", Resolution: "rich_text", Type: "select", Reason: "rich_text", Alternatives: "rich_text", "Affected Objects": "rich_text", "Evidence Refs": "rich_text", "Decided At": "date", "Effective At": "date", "Opened At": "date", "Review At": "date", "Must Review By": "date", Owner: "people", "Decision ID": "unique_id", "Last Edited": "last_edited_time", Created: "created_time" };
const OBJECTIVES = { Objective: "title", Status: "select", Target: "number", Baseline: "number", Type: "select", Reason: "rich_text", "Metric Key": "rich_text", "Metric Version": "rich_text", "Decision Ref": "rich_text", "Derived From": "rich_text", "Evaluation Cadence": "rich_text", "Guardrail Action": "rich_text", "Scope Note": "rich_text", "Scope Account IDs": "rich_text", "Scope Segments": "rich_text", "Scope Sequence Keys": "rich_text", "Published Objective Ref": "rich_text", "Horizon Start": "date", "Horizon End": "date", "Review At": "date", Owner: "people", "Scope Owner": "people", "Objective ID": "unique_id", "Last Edited": "last_edited_time", Created: "created_time" };
const TEXT = new Set(["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "toggle", "quote", "callout", "code"]);
const STRUCTURAL = new Set(["divider", "table", "column", "column_list", "table_of_contents", "synced_block"]);
/** Caller must already admit the authenticated owner and normalized need. No writer, URL fetch, external
 * reference traversal, lifecycle interpretation or cached business authority is reachable from this reader. */
export async function readMetaOperatingContext(client: NotionReadClient, runtime: ResolvedRuntime, selected: boolean): Promise<MetaOperatingContext> {
    const profile = runtime.adapter.controlPlane.metaOperatingContext, root = uuid(runtime.root_ref);
    const governingSchema = runtime.versions.governing_schema === "UNKNOWN" ? undefined : runtime.versions.governing_schema.value;
    const documents: Document[] = [], tables: Table[] = [], issues: Issue[] = [];
    let reads = 0, blocks = 0, failures = 0, issuesOmitted = 0, stopped = false;
    let activeDocument: Document | undefined, documentReadStart = 0;
    const result = (status: Status): MetaOperatingContext => ({ policy_role: "CANDIDATE_NOT_ADOPTED", trust: "SOURCE_DATA_ONLY", effectivity: "NOT_EVALUATED", scope: "BOUND_META_PRIVATE_OPERATING_SOURCES_ONLY", status,
        ...(profile ? { mapping_adapter_version: runtime.adapter.version, ...(governingSchema ? { governing_schema_version: governingSchema } : {}) } : {}), ...(root && status !== "NOT_SELECTED" ? { root_ref: root } : {}), atomic: false, stability: "NOT_VERIFIED", references_followed: false, reads, blocks_seen: blocks, issues_omitted: issuesOmitted, limits: LIMITS, documents, tables, issues });
    function issue(ref: string, code: string, target: Issue[] = issues) { failures++; target.push({ ref, code }); if (Buffer.byteLength(JSON.stringify(result("PARTIAL"))) > LIMITS.response_bytes - 1024) {
        target.pop();
        issuesOmitted++;
    } }
    if (!selected || runtime.lane !== "META" || runtime.access_mode !== "BUSINESS" || !profile)
        return result("NOT_SELECTED");
    if (!root) {
        issue("RUNTIME", "INVALID_ROOT");
        return result("UNAVAILABLE");
    }
    async function read(ref: string, method: "page" | "database" | "source" | "children" | "query", cursor?: string, filter?: unknown): Promise<RecordValue | undefined> {
        // Keep one document's nesting from consuming the other document or either table.
        if (activeDocument && (reads - documentReadStart >= LIMITS.document_reads || reads >= LIMITS.reads - LIMITS.reserved_table_reads)) {
            issue(ref, "DOCUMENT_READ_LIMIT", activeDocument.issues);
            haltedDocuments.add(activeDocument);
            return undefined;
        }
        if (stopped || reads >= LIMITS.reads) {
            issue(ref, "READ_LIMIT");
            stopped = true;
            return undefined;
        }
        reads++;
        try {
            const v = await (method === "page" ? client.retrievePage(ref) : method === "database" ? client.retrieveDatabase(ref) : method === "source" ? client.retrieveDataSource(ref) : method === "children" ? client.retrieveBlockChildren(ref, cursor) : client.queryDataSource(ref, filter, cursor, { page_size: LIMITS.rows_per_table, ...(filter ? {} : { sorts: [{ timestamp: "last_edited_time", direction: "descending" }] }) }));
            if (!record(v)) {
                issue(ref, "INVALID_RESPONSE");
                return undefined;
            }
            return v;
        }
        catch {
            issue(ref, "READ_FAILED");
            return undefined;
        }
    }
    async function entity(ref: string, method: "page" | "database" | "source", type?: string, parentId?: string) { const p = await read(ref, method); if (!p)
        return undefined; if (p.object !== (method === "source" ? "data_source" : method) || uuid(p.id) !== ref || !active(p) || (type && parentId && !parent(p, type, parentId))) {
        issue(ref, "INVALID_ENTITY_PARENT_OR_ACTIVITY");
        return undefined;
    } return p; }
    const seen = new Set<string>(), visited = new Set<string>(), haltedDocuments = new Set<Document>();
    async function children(ref: string, consume: (b: RecordValue, id: string) => Promise<boolean | void>): Promise<boolean> {
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
            const v = await read(ref, "children", cursor);
            if (!v)
                return false;
            if (!Array.isArray(v.results) || typeof v.has_more !== "boolean" || (v.has_more ? typeof v.next_cursor !== "string" || !v.next_cursor.length : v.next_cursor !== null)) {
                issue(ref, "INVALID_LIST");
                return false;
            }
            for (const b of v.results) {
                if (++blocks > LIMITS.blocks) {
                    issue(ref, "BLOCK_LIMIT");
                    stopped = true;
                    return false;
                }
                const id = record(b) ? uuid(b.id) : undefined;
                if (!record(b) || b.object !== "block" || !id || !active(b) || (!parent(b, "page_id", ref) && !parent(b, "block_id", ref)) || seen.has(id)) {
                    issue(ref, "INVALID_OR_DUPLICATE_CONTAINED_BLOCK");
                    return false;
                }
                seen.add(id);
                if (await consume(b, id) === false || stopped)
                    return false;
            }
            if (!v.has_more)
                return true;
            cursor = v.next_cursor as string;
            if (cursors.has(cursor)) {
                issue(ref, "PAGINATION_CYCLE");
                return false;
            }
            cursors.add(cursor);
        } while (!stopped);
        return false;
    }
    if (!await entity(root, "page"))
        return result("UNAVAILABLE");
    const rootChildren: RecordValue[] = [];
    if (!await children(root, async (b) => { rootChildren.push(b); }))
        return result("UNAVAILABLE");
    function child(matches: RecordValue[], type: string): string | undefined { if (matches.length !== 1 || matches[0]!.type !== type) {
        issue("PATH", "MISSING_OR_AMBIGUOUS_CONTAINED_RESOURCE");
        return undefined;
    } return uuid(matches[0]!.id); }
    const registryDb = child(rootChildren.filter(b => record(b.child_database) && b.child_database.title === runtime.adapter.controlPlane.resourceRegistryDatabaseTitle), "child_database");
    if (!registryDb)
        return result("UNAVAILABLE");
    const registry = await entity(registryDb, "database", "page_id", root);
    if (!registry || !Array.isArray(registry.data_sources) || registry.data_sources.length !== 1 || !record(registry.data_sources[0])) {
        issue("REGISTRY", "INVALID_DATA_SOURCE");
        return result("UNAVAILABLE");
    }
    const registryDs = uuid(registry.data_sources[0].id);
    if (!registryDs) {
        issue("REGISTRY", "INVALID_ID");
        return result("UNAVAILABLE");
    }
    const keys = ["META_COMPANY_FRAME", "META_DECISIONS", "META_OBJECTIVES"];
    const rows = await read(registryDs, "query", undefined, { or: keys.map(k => ({ property: "Resource Key", rich_text: { equals: k } })) });
    if (!rows || !Array.isArray(rows.results) || rows.has_more !== false || rows.next_cursor !== null) {
        issue("REGISTRY", "INCOMPLETE_MAPPING");
        return result("UNAVAILABLE");
    }
    const targets = new Map<string, string>();
    for (const key of keys) {
        const matches = rows.results.filter(p => { try {
            return record(p) && record(p.properties) && cell(p.properties["Resource Key"], "rich_text") === key;
        }
        catch {
            return false;
        } });
        if (matches.length !== 1) {
            issue(key, "MISSING_OR_AMBIGUOUS_REGISTRY_KEY");
            continue;
        }
        const p = matches[0] as RecordValue, props = p.properties as RecordValue;
        try {
            const ref = pointer(cell(props["Resource URL"], "url")), kind = key === "META_COMPANY_FRAME" ? "PAGE" : "DATABASE";
            if (p.object !== "page" || !uuid(p.id) || !active(p) || !parent(p, "data_source_id", registryDs) || cell(props.Scope, "select") !== "PRIVATE_META" || cell(props.Status, "select") !== "RESOLVED" || cell(props["Schema Version"], "rich_text") !== governingSchema || pointer(cell(props["Parent URL"], "url")) !== root || cell(props["Resource Type"], "select") !== kind || !ref)
                throw Error("REGISTRY");
            if (!child(rootChildren.filter(b => uuid(b.id) === ref), kind === "PAGE" ? "child_page" : "child_database"))
                continue;
            targets.set(key, ref);
        }
        catch {
            issue(key, "INVALID_REGISTRY_MAPPING");
        }
    }
    const frame = targets.get("META_COMPANY_FRAME");
    if (frame && !rootChildren.some(b => uuid(b.id) === frame && record(b.child_page) && b.child_page.title === profile.companyFrameTitle)) {
        issue("META_COMPANY_FRAME", "UNEXPECTED_TITLE");
        targets.delete("META_COMPANY_FRAME");
    }
    const pkg = child(rootChildren.filter(b => record(b.child_page) && typeof b.child_page.title === "string" && new RegExp(profile.privatePackageTitlePattern).test(b.child_page.title)), "child_page");
    async function visit(ref: string, depth: number, doc: Document): Promise<void> {
        if (haltedDocuments.has(doc))
            return;
        if (visited.has(ref) || depth > LIMITS.depth) {
            issue(ref, "DEPTH_OR_CYCLE", doc.issues);
            return;
        }
        visited.add(ref);
        await children(ref, async (b, id) => {
            const type = b.type, body = typeof type === "string" ? b[type] : undefined;
            if (typeof type !== "string" || !record(body) || typeof b.has_children !== "boolean") {
                issue(id, "INVALID_BLOCK", doc.issues);
                return;
            }
            if (type === "synced_block" && body.synced_from !== null) {
                issue(id, "EXTERNAL_SYNC_NOT_FOLLOWED", doc.issues);
                return;
            }
            let value = "";
            try {
                if (TEXT.has(type))
                    value = text(body.rich_text);
                else if (type === "table_row") {
                    if (!Array.isArray(body.cells))
                        throw Error("CELLS");
                    value = body.cells.map(text).join(" | ");
                }
                else if (type === "equation") {
                    if (typeof body.expression !== "string")
                        throw Error("EQUATION");
                    value = body.expression;
                }
                else if (!STRUCTURAL.has(type)) {
                    issue(id, "UNSUPPORTED_REFERENCE_NOT_FOLLOWED", doc.issues);
                    return;
                }
            }
            catch {
                issue(id, "INVALID_TEXT", doc.issues);
                return;
            }
            const richValues = type === "table_row" && Array.isArray(body.cells) ? body.cells.flat() : body.rich_text;
            if (Array.isArray(richValues) && richValues.some(v => record(v) && v.type === "mention"))
                issue(id, "MENTION_NOT_FOLLOWED", doc.issues);
            if (value) {
                doc.items.push({ block_ref: id, ...(ref === doc.page_ref ? {} : { parent_ref: ref }), type, text: value });
                if (Buffer.byteLength(JSON.stringify(doc)) > LIMITS.document_bytes - 512) {
                    doc.items.pop();
                    issue(id, "BYTE_LIMIT", doc.issues);
                    haltedDocuments.add(doc);
                    return false;
                }
                if (Buffer.byteLength(JSON.stringify(result("PARTIAL"))) > LIMITS.response_bytes - 2048) {
                    doc.items.pop();
                    issue(id, "BYTE_LIMIT", doc.issues);
                    stopped = true;
                    return false;
                }
            }
            if (b.has_children)
                await visit(id, depth + 1, doc);
            if (haltedDocuments.has(doc))
                return false;
        });
    }
    for (const [role, ref] of [["COMPANY_FRAME", targets.get("META_COMPANY_FRAME")], ["PRIVATE_BUSINESS_PACKAGE", pkg]] as const) {
        if (!ref)
            continue;
        const doc: Document = { role, page_ref: ref, status: "UNAVAILABLE", items: [], issues: [] };
        documents.push(doc);
        if (stopped) {
            issue(ref, "NOT_REACHED", doc.issues);
            continue;
        }
        activeDocument = doc;
        documentReadStart = reads;
        const start = failures;
        try {
            const p = await entity(ref, "page", "page_id", root);
            if (!p)
                continue;
            if (typeof p.last_edited_time === "string")
                doc.last_edited_time = p.last_edited_time;
            await visit(ref, 0, doc);
            doc.status = failures === start ? "COMPLETE" : doc.items.length ? "PARTIAL" : "UNAVAILABLE";
        } finally {
            activeDocument = undefined;
        }
    }
    for (const [role, key, fields] of [["DECISIONS", "META_DECISIONS", DECISIONS], ["OBJECTIVES", "META_OBJECTIVES", OBJECTIVES]] as const) {
        const ref = targets.get(key);
        const t: Table = { role, registry_key: key, ...(ref ? { database_ref: ref } : {}), status: "UNAVAILABLE", has_more: "UNKNOWN", rows: [], omitted_columns: [], issues: [] };
        tables.push(t);
        if (!ref || stopped) {
            issue(key, stopped ? "NOT_REACHED" : "UNRESOLVED_REGISTRY_MAPPING", t.issues);
            continue;
        }
        const db = await entity(ref, "database", "page_id", root);
        if (!db || !Array.isArray(db.data_sources) || db.data_sources.length !== 1 || !record(db.data_sources[0])) {
            issue(key, "INVALID_DATA_SOURCE", t.issues);
            continue;
        }
        const ds = uuid(db.data_sources[0].id);
        if (!ds) {
            issue(key, "INVALID_ID", t.issues);
            continue;
        }
        t.data_source_ref = ds;
        const start = failures, s = await entity(ds, "source", "database_id", ref);
        if (!s || !record(s.properties)) {
            issue(key, "INVALID_DATA_SOURCE_SCHEMA", t.issues);
            continue;
        }
        const required = role === "DECISIONS" ? "Decision" : "Objective";
        let bad = false;
        for (const [k, type] of Object.entries(fields)) {
            const p = s.properties[k];
            if (!p) {
                t.omitted_columns.push(k);
                if (k === required || k === "Status")
                    bad = true;
            }
            else if (!record(p) || p.type !== type)
                bad = true;
        }
        if (bad) {
            issue(key, "INCOMPATIBLE_SCHEMA", t.issues);
            continue;
        }
        if (t.omitted_columns.length)
            issue(key, "COLUMNS_NOT_SUPPLIED", t.issues);
        const q = await read(ds, "query");
        if (!q) {
            issue(key, "QUERY_NOT_REACHED_OR_FAILED", t.issues);
            continue;
        }
        if (!Array.isArray(q.results) || q.results.length > LIMITS.rows_per_table || typeof q.has_more !== "boolean" || (q.has_more ? typeof q.next_cursor !== "string" || !q.next_cursor.length : q.next_cursor !== null)) {
            issue(key, "INVALID_WINDOW", t.issues);
            continue;
        }
        t.has_more = q.has_more;
        const rowIds = new Set<string>();
        for (const p of q.results) {
            try {
                const id = record(p) ? uuid(p.id) : undefined;
                if (!record(p) || p.object !== "page" || !id || rowIds.has(id) || !active(p) || !parent(p, "data_source_id", ds) || !record(p.properties))
                    throw Error("ROW");
                rowIds.add(id);
                const values: RecordValue = {};
                for (const [k, type] of Object.entries(fields))
                    if (s.properties[k]) {
                        values[k] = cell(p.properties[k], type);
                        const prop = p.properties[k];
                        if (record(prop) && Array.isArray(prop[type]) && (prop[type] as unknown[]).some(v => record(v) && v.type === "mention"))
                            issue(id, "MENTION_NOT_FOLLOWED", t.issues);
                    }
                const row = { page_ref: id, ...(typeof p.last_edited_time === "string" ? { last_edited_time: p.last_edited_time } : {}), values };
                t.rows.push(row);
                if (Buffer.byteLength(JSON.stringify(t)) > LIMITS.table_bytes - 512) {
                    t.rows.pop();
                    issue(key, "BYTE_LIMIT", t.issues);
                    break;
                }
                if (Buffer.byteLength(JSON.stringify(result("PARTIAL"))) > LIMITS.response_bytes - 2048) {
                    t.rows.pop();
                    issue(key, "BYTE_LIMIT", t.issues);
                    stopped = true;
                    break;
                }
            }
            catch {
                issue(key, "INVALID_ROW", t.issues);
            }
        }
        if (q.has_more)
            issue(key, "ROW_WINDOW_LIMIT", t.issues);
        t.status = failures === start ? "COMPLETE" : t.rows.length ? "PARTIAL" : "UNAVAILABLE";
    }
    return result(failures ? documents.some(d => d.items.length) || tables.some(t => t.rows.length) ? "PARTIAL" : "UNAVAILABLE" : "COMPLETE");
}
