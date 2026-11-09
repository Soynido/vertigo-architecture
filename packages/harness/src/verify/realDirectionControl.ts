/** Real recipient-scoped direction control. Native Notion performs the returned writes.
 * Owner-session approval is an attestation, not a cryptographic proof of a human click.
 * No mail, Calendar, local policy update, arbitrary target, or commercial outcome writer.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { NotionReadClient } from '../notion/readClient.ts';
import type { PrincipalRegistry } from '../auth/principal.ts';
import type { SalesRuntimeRegistry } from '../registry/salesRuntimes.ts';
import { withRegistryLock } from '../registry/salesRuntimes.ts';
import {nextMetaOrientationPublication,observeMetaOrientationPublication,type MetaOrientationScope} from './realDirectionPublication.ts';
const uuid = z.string().regex(/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i).transform(s => s.replaceAll('-', '').toLowerCase());
const text = z.string().trim().min(1).max(1500), key = z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/), day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
const plain = text.refine(v => !/(?:https?:\/\/|(?:app\.)?notion\.(?:so|com)\/)/i.test(v), 'Use recipient-safe prose, not private source URLs.');
export const realDirectionBody = z.object({ title: plain.refine(v => v.length <= 160), objective: plain, horizon: z.object({ start: day, end: day }).strict().refine(x => x.start <= x.end), recommendations: z.array(plain).max(8), constraints: z.array(plain).max(8) }).strict();
const recipientSchema = z.object({ key, principal_id: text,project:text.default('VERTIGO'), rep_identity_key: text, runtime_id: text, root_page_id: uuid, receipts_source_id: uuid, manifest_page_id: uuid, manifest_data_source_id: uuid, mailbox: z.string().email().transform(s=>s.toLowerCase()), generation: text,schema_version:text,sales_contract_version:text }).strict();
const publicationSchema=z.object({contract:z.literal('META_ORIENTATION/1.0'),journal_root_id:uuid,protected_source_ids:z.array(uuid).min(4).max(64),meta_runtime_id:text,meta_manifest_page_id:uuid,meta_manifest_source_id:uuid,meta_schema_version:text,spec_version:text,control_version:text,runs_source_id:uuid,ledger_source_id:uuid,decisions_source_id:uuid}).strict();
const profileSchema = z.object({ kind: z.literal('REAL_DIRECTION_PROFILE/3'), owner_principal_id: text,project:z.enum(['VERTIGO','VERTIGO_META_OS']).default('VERTIGO'), meta_root_id: uuid, definitions_source_id: uuid, publication:publicationSchema, journal_file: z.string().refine(isAbsolute), receipt_secret: z.string().regex(/^[a-f0-9]{64}$/), recipients: z.array(recipientSchema).min(1).max(3) }).strict().superRefine((p, c) => {
    for (const field of ['key', 'principal_id', 'rep_identity_key', 'runtime_id', 'mailbox'] as const) {
        if (new Set(p.recipients.map(r => r[field])).size !== p.recipients.length) c.addIssue({ code: 'custom', message: 'duplicate recipient ' + field });
    }
    const physical=[p.meta_root_id,p.definitions_source_id,p.publication.journal_root_id,p.publication.meta_manifest_page_id,p.publication.meta_manifest_source_id,p.publication.runs_source_id,p.publication.ledger_source_id,p.publication.decisions_source_id,...p.recipients.flatMap(r=>[r.root_page_id,r.receipts_source_id,r.manifest_page_id,r.manifest_data_source_id])];
    if(new Set(physical).size!==physical.length||p.recipients.some(r=>r.principal_id===p.owner_principal_id)) c.addIssue({code:'custom',message:'owner/recipient collision'});
    if(new Set(p.publication.protected_source_ids).size!==p.publication.protected_source_ids.length||[p.definitions_source_id,p.publication.runs_source_id,p.publication.ledger_source_id,p.publication.decisions_source_id].some(id=>p.publication.protected_source_ids.includes(id)))c.addIssue({code:'custom',message:'orientation/global source collision'});
});
export type RealDirectionProfile = z.input<typeof profileSchema>;
export const realDirectionInput = z.discriminatedUnion('action', [
    z.object({ action: z.literal('STATUS'), recipient: key.optional() }).strict(), z.object({ action: z.literal('CONTEXT') }).strict(), z.object({ action: z.literal('CONSUME') }).strict(), z.object({ action: z.literal('VERIFY_CONSUMPTION') }).strict(),
    z.object({ action: z.literal('PREPARE'), recipient: key, request_key: text.max(160), direction: realDirectionBody }).strict(),
    z.object({ action: z.literal('APPROVE'), proposal_id: z.string().uuid(), approval_hash: z.string().regex(/^[a-f0-9]{64}$/), confirmation: text.max(500) }).strict(),
    z.object({ action: z.literal('VERIFY'), proposal_id: z.string().uuid() }).strict(),
]);
// MCP needs an object schema; run() enforces the strict action-specific discriminated union.
export const realDirectionToolInput = z.object({
    action: z.enum(['STATUS', 'CONTEXT', 'CONSUME', 'VERIFY_CONSUMPTION', 'PREPARE', 'APPROVE', 'VERIFY']),
    recipient: key.optional(), request_key: text.max(160).optional(), direction: realDirectionBody.optional(),
    proposal_id: z.string().uuid().optional(), approval_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(), confirmation: text.max(500).optional(),
}).strict();
type Recipient = z.infer<typeof recipientSchema>;
type Body = z.infer<typeof realDirectionBody>;
const proposalSchema = z.object({ id: z.string().uuid(), request_key: text, recipient: key, assignment:recipientSchema, version: z.number().int().positive(), base_version: z.number().int().nonnegative(), created_at: z.string().datetime(), body: realDirectionBody, approval_hash: z.string(), stage: z.enum(['DRAFT', 'APPROVED', 'PUBLISHED']), approved_at: z.string().datetime().optional(), confirmation: text.optional(),previous_pointer:z.string().max(2048).optional() }).strict();
type Proposal = z.infer<typeof proposalSchema>;
const consumptionSchema = z.object({ id: z.string().uuid(), proposal_id: z.string().uuid(), created_at: z.string().datetime(), verified: z.boolean(), receipt_id: uuid.optional() }).strict();
type Consumption = z.infer<typeof consumptionSchema>;
const journalSchema = z.object({ schema: z.literal(1), scope: z.string(), proposals: z.array(proposalSchema).max(150), active: z.record(z.string()), consumptions: z.record(consumptionSchema) }).strict();
type Journal = z.infer<typeof journalSchema>;
export interface RealDirectionWrite {
    operation: 'CREATE_IF_ABSENT';
    data_source_id: string;
    key_property: string;
    key: string;
    properties: Record<string, string>;
}
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const refusal = (e: unknown) => { const codes = ['INCOMPLETE_READ', 'INVALID_JOURNAL', 'FOREIGN_JOURNAL', 'JOURNAL_BOUND', 'RECIPIENT_ASSIGNMENT_CHANGED', 'SCOPE_MISMATCH', 'MISSING_RECORD', 'AMBIGUOUS_RECORD', 'FIELDS_MISMATCH', 'CHANGED_DURING_READ', 'RECEIPT_ID_CHANGED', 'ACCESS_DENIED','PUBLICATION_UNCONFIRMED','UNMANAGED_CURRENT_POINTER','CURRENT_POINTER_CHANGED']; return e instanceof Error && codes.includes(e.message) ? e.message : 'SOURCE_OR_JOURNAL_UNAVAILABLE'; };
const object = (x: unknown): Record<string, any> => { if (!x || typeof x !== 'object' || Array.isArray(x))
    throw Error('INCOMPLETE_READ'); return x as any; };
const norm = (x: unknown) => typeof x === 'string' ? x.replaceAll('-', '').toLowerCase() : '';
const rootRef = (x: unknown) => { const direct=uuid.safeParse(x);if(direct.success)return direct.data;try{const u=new URL(String(x));if(u.protocol==='https:'&&['app.notion.com','notion.so','www.notion.so'].includes(u.hostname)&&!u.username&&!u.password){const tail=uuid.safeParse(u.pathname.match(/([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/?$/i)?.[1]);if(tail.success)return tail.data;}}catch{}return undefined;};
function value(p: any): unknown { if (p?.has_more === true)
    throw Error('INCOMPLETE_READ'); if (p?.type === 'rich_text' || p?.type === 'title') {
    const a = p[p.type];
    if (!Array.isArray(a) || a.length >= 25 || a.some((x: any) => typeof x.plain_text !== 'string'))
        throw Error('INCOMPLETE_READ');
    return a.map((x: any) => x.plain_text).join('');
} if (p?.type === 'select')
    return p.select?.name ?? null; if (p?.type === 'checkbox')
    return p.checkbox; throw Error('INCOMPLETE_READ'); }
export function loadRealDirectionProfile(path: string): RealDirectionProfile { return profileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
export class RealDirectionControl {
    readonly #p: z.infer<typeof profileSchema>;
    readonly #scope: string;
    readonly reader: NotionReadClient;
    readonly principals: PrincipalRegistry;
    readonly registry: SalesRuntimeRegistry;
    readonly clock: () => Date;
    constructor(profile: RealDirectionProfile, reader: NotionReadClient, principals: PrincipalRegistry, registry: SalesRuntimeRegistry, clock = () => new Date()) {
        this.#p = profileSchema.parse(profile);
        this.#scope = hash({kind:this.#p.kind,owner_principal_id:this.#p.owner_principal_id,project:this.#p.project,meta_root_id:this.#p.meta_root_id,definitions_source_id:this.#p.definitions_source_id,publication:this.#p.publication});
        this.reader = reader;
        this.principals = principals;
        this.registry = registry;
        this.clock = clock;
    }
    owns(id: string | undefined) { return Boolean(id && (id === this.#p.owner_principal_id || this.#p.recipients.some(r => r.principal_id === id))); }
    #sign(domain: string, payload: string) { return createHmac('sha256', this.#p.receipt_secret).update(domain + '\0' + this.#scope + '\0' + payload).digest('hex'); }
    async #journal(): Promise<Journal> { try {
        const st = await lstat(this.#p.journal_file);
        if (!st.isFile() || st.isSymbolicLink() || st.size > 1048576)
            throw Error('INVALID_JOURNAL');
        const e = JSON.parse(await readFile(this.#p.journal_file, 'utf8'));
        if (typeof e.payload !== 'string' || typeof e.signature !== 'string' || !/^[a-f0-9]{64}$/.test(e.signature) || !timingSafeEqual(Buffer.from(e.signature, 'hex'), Buffer.from(this.#sign('REAL_DIRECTION_JOURNAL/1', e.payload), 'hex')))
            throw Error('INVALID_JOURNAL');
        const j = journalSchema.parse(JSON.parse(e.payload));
        if (j.scope !== this.#scope)
            throw Error('FOREIGN_JOURNAL');
        return j;
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            return { schema: 1, scope: this.#scope, proposals: [], active: {}, consumptions: {} };
        throw e;
    } }
    async #save(j: Journal, principalId: string, recipient: Recipient) { if (!await this.#identity(principalId))
        throw Error('ACCESS_DENIED'); await this.#assignment(recipient); const payload = JSON.stringify(j), body = JSON.stringify({ payload, signature: this.#sign('REAL_DIRECTION_JOURNAL/1', payload) }), temp = this.#p.journal_file + '.' + randomUUID() + '.tmp'; if (Buffer.byteLength(body) > 1048576)
        throw Error('JOURNAL_BOUND'); try {
        const f = await open(temp, 'wx', 0o600);
        try {
            await f.writeFile(body);
            await f.sync();
        }
        finally {
            await f.close();
        }
        await rename(temp, this.#p.journal_file);
        const d = await open(dirname(this.#p.journal_file), 'r');
        try {
            await d.sync();
        }
        finally {
            await d.close();
        }
    }
    finally {
        await unlink(temp).catch(() => { });
    } }
    async #identity(id: string | undefined) { if (!this.owns(id))
        return; const p = await this.principals.get(id!); if (!p || p.status !== 'ACTIVE')
        return; if (id === this.#p.owner_principal_id)
        return p.meta_authority === 'COMPANY_OWNER' && p.allowed_projects.includes(this.#p.project) && p.allowed_lanes.includes('META') ? { owner: true as const } : undefined; const r = this.#p.recipients.find(x => x.principal_id === id)!; if (!p.allowed_projects.includes(r.project)||!p.allowed_lanes.includes('SALES') || p.rep_identity_key !== r.rep_identity_key)
        return; const a = await this.registry.lookup(r.rep_identity_key); if (!a || a.status !== 'KNOWN' || rootRef(a.root_ref) !== r.root_page_id || a.expected_instance_id !== r.runtime_id || a.pointer_generation !== r.generation || a.expected_gmail_identity&&a.expected_gmail_identity.toLowerCase() !== r.mailbox.toLowerCase())
        return; return { owner: false as const, recipient: r }; }
    async #assignment(r: Recipient) {
        const actor=await this.#identity(r.principal_id);if(!actor||actor.owner)throw Error('RECIPIENT_ASSIGNMENT_CHANGED');
        await this.#chain(r.manifest_data_source_id,r.root_page_id);
        const read=async()=>{const p=object(await this.reader.retrievePage(r.manifest_page_id));if(p.object!=='page'||norm(p.id)!==r.manifest_page_id||p.archived!==false||p.in_trash!==false||p.parent?.type!=='data_source_id'||norm(p.parent.data_source_id)!==r.manifest_data_source_id||!Number.isFinite(Date.parse(p.last_edited_time)))throw Error('SCOPE_MISMATCH');const props=object(p.properties),email=props['Gmail Identity']?.type==='email'?props['Gmail Identity'].email:value(props['Gmail Identity']);if(props['Instance ID']?.type!=='rich_text'||value(props['Instance ID'])!==r.runtime_id||typeof email!=='string'||email.toLowerCase()!==r.mailbox.toLowerCase()||props['Root URL']?.type!=='url'||rootRef(props['Root URL'].url)!==r.root_page_id)throw Error('RECIPIENT_ASSIGNMENT_CHANGED');return{id:norm(p.id),revision:p.last_edited_time,runtime:r.runtime_id,mailbox:email.toLowerCase(),root:r.root_page_id};};
        const first=await read(),last=await read();if(JSON.stringify(first)!==JSON.stringify(last))throw Error('CHANGED_DURING_READ');
    }
    async #chain(source: string, root: string) { const rootPage = object(await this.reader.retrievePage(root)); if (rootPage.object !== 'page' || norm(rootPage.id) !== root || rootPage.archived !== false || rootPage.in_trash !== false)
        throw Error('SCOPE_MISMATCH'); let p = object(await this.reader.retrieveDataSource(source)); if (p.object !== 'data_source' || norm(p.id) !== source || p.archived === true || p.in_trash === true)
        throw Error('SCOPE_MISMATCH'); const seen = new Set<string>([source]); for (let i = 0; i < 12; i++) {
        const parent = object(p.parent), type = parent.type, id = norm(parent[type]);
        if (!id || seen.has(id))
            throw Error('SCOPE_MISMATCH');
        if (type === 'page_id' && id === root)
            return;
        seen.add(id);
        p = object(await (type === 'database_id' ? this.reader.retrieveDatabase(id) : type === 'page_id' ? this.reader.retrievePage(id) : Promise.reject(Error('SCOPE_MISMATCH'))));
        if (norm(p.id) !== id || p.archived === true || p.in_trash === true)
            throw Error('SCOPE_MISMATCH');
    } throw Error('SCOPE_MISMATCH'); }
    #definition(p: Proposal, r: Recipient): RealDirectionWrite { const body = { kind: 'REAL_DIRECTION_VERSION/1', proposal_id: p.id, version: p.version, recipient: { key: r.key, runtime_id: r.runtime_id, root_page_id: r.root_page_id, generation: r.generation }, approved_by: this.#p.owner_principal_id, approved_at: p.approved_at, approval_provenance: 'OWNER_SESSION_ATTESTATION', does_not_change_local_authority: true, direction: p.body }; const payload = JSON.stringify(body), content = JSON.stringify({ payload, signature: this.#sign('REAL_DIRECTION_VERSION/1', payload) }), key = 'REAL_DIRECTION:' + r.key + ':' + p.version + ':' + p.id; return { operation: 'CREATE_IF_ABSENT', data_source_id: this.#p.definitions_source_id, key_property: 'Definition Key', key, properties: { Definition: p.body.title, 'Definition Key': key, 'Definition Type': 'TOOLKIT_ITEM', Status: 'APPROVED_FOR_VERSION', 'Target Version': 'REAL_DIRECTION/1:' + p.version, Content: content, 'Decision Ref': 'OWNER_SESSION:' + p.id, 'Source Refs': 'OWNER_APPROVAL_ATTESTED; no private source content transmitted', 'Parameters': 'Recipient ' + r.key + '; preserves local rules/history/methods; no external action authority.' } }; }
    #receipt(p: Proposal, r: Recipient, c: Consumption): RealDirectionWrite { const data = { kind: 'REAL_DIRECTION_CONSUMPTION/1', id: c.id, proposal_id: p.id, version: p.version, runtime_id: r.runtime_id, recipient: r.key, observed_at: c.created_at, claim: 'DIRECTION_LOADED_NOT_BUSINESS_EXECUTED' }, payload = JSON.stringify(data), key = 'REAL_DIRECTION_RECEIVED:' + r.runtime_id + ':' + p.id; return { operation: 'CREATE_IF_ABSENT', data_source_id: r.receipts_source_id, key_property: 'Idempotency Key', key, properties: { Receipt: 'Orientation META reçue — ' + p.body.title, 'Idempotency Key': key, 'Event Type': 'OTHER', 'Source System': 'OTHER', 'Source Account': r.mailbox, 'Source Event ID': p.id, 'Source Confidence': 'AUTHORITATIVE_TOOL', Verified: '__NO__', Notes: JSON.stringify({ payload, signature: this.#sign('REAL_DIRECTION_CONSUMPTION/1', payload) }) } }; }
    async #match(write: RealDirectionWrite, root: string) { await this.#chain(write.data_source_id, root); const query = async () => { const q = object(await this.reader.queryDataSource(write.data_source_id, { property: write.key_property, rich_text: { equals: write.key } }, undefined, { page_size: 2 })); if (q.object !== 'list' || q.has_more !== false || !Array.isArray(q.results))
        throw Error('INCOMPLETE_READ'); if (q.results.length === 0)
        throw Error('MISSING_RECORD'); if (q.results.length !== 1)
        throw Error('AMBIGUOUS_RECORD'); const p = object(q.results[0]); if (p.object !== 'page' || !uuid.safeParse(p.id).success || p.archived !== false || p.in_trash !== false || p.parent?.type !== 'data_source_id' || norm(p.parent.data_source_id) !== write.data_source_id || !Number.isFinite(Date.parse(p.last_edited_time)))
        throw Error('SCOPE_MISMATCH'); for (const [k, v] of Object.entries(write.properties)) {
        const type = k === 'Definition' || k === 'Receipt' ? 'title' : ['Event Type', 'Source System', 'Source Confidence', 'Definition Type', 'Status'].includes(k) ? 'select' : k === 'Verified' ? 'checkbox' : 'rich_text';
        if (p.properties?.[k]?.type !== type || value(p.properties[k]) !== (k === 'Verified' ? v === '__YES__' : v))
            throw Error('FIELDS_MISMATCH');
    } return { id: norm(p.id), revision: p.last_edited_time }; }; const first = await query(), last = await query(); if (JSON.stringify(first) !== JSON.stringify(last))
        throw Error('CHANGED_DURING_READ'); return first; }
    #active(j: Journal, r: Recipient) { const p = j.proposals.find(x => x.id === j.active[r.key]); if (p && p.stage !== 'PUBLISHED')
        throw Error('INVALID_JOURNAL'); return p; }
    #reply(status: string, fields: Record<string, unknown> = {}) { return { status, ...fields, next_action: 'Préserver les méthodes, règles, historique et autorité locale. Cette direction ne permet aucun envoi ni effet externe. Préparer une action utile adaptée au contexte ; aucune progression en arrière-plan.' }; }
    #draft(p: Proposal) { return this.#reply('DRAFT', { proposal_id: p.id, approval_hash: p.approval_hash, recipient: p.recipient, version: p.version, direction: p.body, approval_required: true, approval_provenance: 'OWNER_SESSION_ATTESTATION_REQUIRED' }); }
    #binding(p:Proposal,r:Recipient){if(JSON.stringify(p.assignment)!==JSON.stringify(r))throw Error('RECIPIENT_ASSIGNMENT_CHANGED');}
    async #metaAssignment(){
        const s=this.#p.publication;await this.#chain(s.meta_manifest_source_id,this.#p.meta_root_id);
        const read=async()=>{const p=object(await this.reader.retrievePage(s.meta_manifest_page_id));
            if(p.object!=='page'||norm(p.id)!==s.meta_manifest_page_id||p.archived!==false||p.in_trash!==false||p.parent?.type!=='data_source_id'||norm(p.parent.data_source_id)!==s.meta_manifest_source_id||!Number.isFinite(Date.parse(p.last_edited_time)))throw Error('SCOPE_MISMATCH');
            const props=object(p.properties);for(const [name,expected]of Object.entries({'Meta Runtime ID':s.meta_runtime_id,'META Schema Version':s.meta_schema_version,'Spec Version':s.spec_version,'Control Version':s.control_version}))if(props[name]?.type!=='rich_text'||value(props[name])!==expected)throw Error('SCOPE_MISMATCH');
            if(props['Meta Root URL']?.type!=='url'||rootRef(props['Meta Root URL'].url)!==this.#p.meta_root_id)throw Error('SCOPE_MISMATCH');
            return JSON.stringify({id:p.id,revision:p.last_edited_time,properties:props});};
        if(await read()!==await read())throw Error('CHANGED_DURING_READ');
    }
    async #pointer(r:Recipient){
        const read=async()=>{const p=object(await this.reader.retrievePage(r.manifest_page_id)),props=object(p.properties);
            for(const [name,expected]of Object.entries({'Schema Version':r.schema_version,'Sales Contract Version':r.sales_contract_version}))if(props[name]?.type!=='rich_text'||value(props[name])!==expected)throw Error('SCOPE_MISMATCH');
            if(props['Objective Package URL']?.type!=='url')throw Error('INCOMPLETE_READ');const pointer=props['Objective Package URL'].url??'';
            if(typeof pointer!=='string'||pointer!==''&&!rootRef(pointer))throw Error('SCOPE_MISMATCH');return {pointer,revision:p.last_edited_time};};
        const first=await read(),last=await read();if(JSON.stringify(first)!==JSON.stringify(last))throw Error('CHANGED_DURING_READ');return first.pointer;
    }
    async #publication(p:Proposal,r:Recipient,observationOnly=false){
        this.#binding(p,r);if(!p.approved_at||p.previous_pointer===undefined||p.stage==='DRAFT')throw Error('INVALID_JOURNAL');
        await this.#metaAssignment();const s=this.#p.publication;
        const scope:MetaOrientationScope={kind:s.contract,journal_root_id:s.journal_root_id,protected_source_ids:s.protected_source_ids,meta_root_id:this.#p.meta_root_id,definitions_source_id:this.#p.definitions_source_id,meta_runtime_id:s.meta_runtime_id,meta_schema_version:s.meta_schema_version,spec_version:s.spec_version,control_version:s.control_version,runs_source_id:s.runs_source_id,ledger_source_id:s.ledger_source_id,decisions_source_id:s.decisions_source_id,recipient:{root_page_id:r.root_page_id,runtime_id:r.runtime_id,manifest_page_id:r.manifest_page_id,manifest_source_id:r.manifest_data_source_id,schema_version:r.schema_version,sales_contract_version:r.sales_contract_version}};
        const package_text=JSON.stringify({kind:'RECIPIENT_DIRECTION/1',contract:s.contract,proposal_id:p.id,version:p.version,recipient_runtime_id:r.runtime_id,recipient_root_id:r.root_page_id,recipient_generation:r.generation,classification:'RECIPIENT_SAFE',authority_change:false,schema_version:r.schema_version,sales_contract_version:r.sales_contract_version,direction:p.body});
        // Canonical schema order survives JSON round-trips; the published stage is
        // local bookkeeping, not a change to the immutable approved native intent.
        const payload=JSON.stringify(proposalSchema.parse({...p,stage:'APPROVED'}));
        return (observationOnly?observeMetaOrientationPublication:nextMetaOrientationPublication)(this.reader,scope,{proposal_id:p.id,definition_properties:this.#definition(p,r).properties,package_text,previous_pointer:p.previous_pointer,approved_at:p.approved_at,sealed_intent:JSON.stringify({payload,signature:this.#sign('META_ORIENTATION_INTENT/1',payload)})},this.clock);
    }
    async #publishedProof(p:Proposal,r:Recipient){const result=await this.#publication(p,r,true);if(result.status!=='ORIENTATION_NATIVE_VERIFIED')throw Error('PUBLICATION_UNCONFIRMED');return result;}
    async #approved(p:Proposal,r:Recipient){
        this.#binding(p,r);if(p.stage!=='APPROVED')throw Error('INVALID_JOURNAL');
        return {...await this.#publication(p,r),version:p.version,recipient:r.key,approval_required:false,approval_provenance:'SAME_IMMUTABLE_PROPOSAL_ALREADY_ATTESTED'};
    }
    async run(id: string | undefined, raw: unknown): Promise<any> {
        const principalId = id!;
        let actor;
        try {
            actor = await this.#identity(id);
        }
        catch {
            return this.#reply('UNCONFIRMED', { reason: 'IDENTITY_UNAVAILABLE' });
        }
        if (!actor)
            return this.#reply('ACCESS_DENIED');
        const input = realDirectionInput.safeParse(raw);
        if (!input.success)
            return this.#reply('INVALID_ARGUMENT');
        const v = input.data;
        if (!actor.owner && ['PREPARE', 'APPROVE', 'VERIFY', 'STATUS'].includes(v.action) || actor.owner && ['CONTEXT', 'CONSUME', 'VERIFY_CONSUMPTION'].includes(v.action))
            return this.#reply('ACCESS_DENIED');
        try {
            // Durable rename + signature verification provides a complete read
            // snapshot. Never hold the writer lock over remote read-only proof.
            const readOnly = v.action === 'STATUS' || v.action === 'CONTEXT';
            let observedJournal: string | undefined;
            const execute = async () => {
                try {
                    const j = await this.#journal();
                    if (readOnly) observedJournal = hash(j);
                    if (actor.owner) {
                        if (v.action === 'STATUS') {
                            const recipients = v.recipient ? this.#p.recipients.filter(r=>r.key===v.recipient) : this.#p.recipients;
                            if (!recipients.length) return this.#reply('INVALID_RECIPIENT');
                            return this.#reply('OBSERVED', { recipients: await Promise.all(recipients.map(async (r) => { const p = this.#active(j, r), c = p ? j.consumptions[p.id] : undefined, waiting=j.proposals.filter(p=>p.recipient===r.key&&p.stage!=='PUBLISHED'), base = { key: r.key, published_version: null as number | null, consumed_version: null as number | null, receipt_id: null as string | null, pending_proposals: waiting.length }; try {
                                    await this.#assignment(r);
                                    const pending=waiting.slice(-5).map(candidate=>{
                                        this.#binding(candidate,r);
                                        const stale=candidate.base_version!==(p?.version??0),expired=candidate.stage==='DRAFT'&&this.clock().getTime()-Date.parse(candidate.created_at)>86400000;
                                        const status=stale?'STALE_PROPOSAL':expired?'PROPOSAL_EXPIRED':candidate.stage==='APPROVED'?'APPROVED_PENDING_NOTION':'DRAFT';
                                        return {status,proposal_id:candidate.id,request_key:candidate.request_key,recipient:r.key,version:candidate.version,base_version:candidate.base_version,created_at:candidate.created_at,direction:candidate.body,approval_hash:candidate.approval_hash,approval_required:status==='DRAFT',can_resume:status==='APPROVED_PENDING_NOTION'};
                                    }),pendingView={pending,pending_coverage:waiting.length>5?'PARTIAL':'COMPLETE'};
                                    if (!p)
                                        return { ...base, ...pendingView, status: 'NO_PUBLISHED_DIRECTION' };
                                    this.#binding(p,r);
                                    const publication = await this.#publishedProof(p,r);
                                    base.published_version = p.version;
                                    if (c?.verified) {
                                        const found = await this.#match(this.#receipt(p, r, c), r.root_page_id);
                                        if (found.id !== c.receipt_id)
                                            throw Error('RECEIPT_ID_CHANGED');
                                        base.consumed_version = p.version;
                                        base.receipt_id = found.id;
                                    }
                                    const current = await this.#identity(r.principal_id);
                                    if (!current || current.owner) throw Error('RECIPIENT_ASSIGNMENT_CHANGED');
                                    const today = this.clock().toISOString().slice(0,10);
                                    return { ...base, ...pendingView, status: c?.verified ? 'CONSUMED' : 'PUBLISHED', proposal_id: p.id, direction: p.body, approved_at: p.approved_at, publication_completed_at: publication.publication_completed_at, publication_time_precision: publication.publication_time_precision, native_chain_verified: true, does_not_change_local_authority: true, effective_state: today < p.body.horizon.start ? 'SCHEDULED' : today > p.body.horizon.end ? 'EXPIRED' : 'CURRENT' };
                                }
                                catch (e) {
                                    return { ...base, status: 'UNCONFIRMED', reason: refusal(e) };
                                } })), not_proved: ['BUSINESS_RESULT', 'WORKFLOW_EXECUTION', 'HUMAN_CLICK'] });
                        }
                        if (v.action === 'PREPARE') {
                            const r = this.#p.recipients.find(x => x.key === v.recipient);
                            if (!r)
                                return this.#reply('INVALID_RECIPIENT');
                            await this.#assignment(r);
                            await this.#chain(this.#p.definitions_source_id,this.#p.meta_root_id);
                            const existing = j.proposals.find(x => x.request_key === v.request_key);
                            if (existing) {
                                if (existing.recipient !== r.key || JSON.stringify(existing.body) !== JSON.stringify(v.direction))
                                    return this.#reply('REQUEST_KEY_CONFLICT');
                                this.#binding(existing,r);
                                if (existing.stage === 'PUBLISHED') {
                                    if(this.#active(j,r)?.id===existing.id)await this.#publishedProof(existing,r);
                                    return this.#reply(this.#active(j, r)?.id === existing.id ? 'PUBLISHED' : 'SUPERSEDED', { proposal_id: existing.id, recipient: r.key, version: existing.version, current_version: this.#active(j, r)?.version, repeated: true });
                                }
                                if((this.#active(j,r)?.version??0)!==existing.base_version)return this.#reply('STALE_PROPOSAL');
                                if(existing.stage==='APPROVED')return this.#approved(existing,r);
                                return this.#draft(existing);
                            }
                            if (j.proposals.length >= 150)
                                return this.#reply('LIMIT_REACHED');
                            const active=this.#active(j,r),previous_pointer=await this.#pointer(r);
                            if(!active&&previous_pointer)throw Error('UNMANAGED_CURRENT_POINTER');
                            if(active){
                                // An operator-authorized generation rotation may propose a new
                                // bound version on the same physical OS, never adopt old authority.
                                if(JSON.stringify({...active.assignment,generation:r.generation})!==JSON.stringify(r))throw Error('RECIPIENT_ASSIGNMENT_CHANGED');
                                await this.#publishedProof(active,active.assignment);
                            }
                            const version = active?.version ?? 0, id = randomUUID(), body = realDirectionBody.parse(v.direction), p: Proposal = { id, request_key: v.request_key, recipient: r.key, assignment:r, base_version: version, version: version + 1, created_at: this.clock().toISOString(), body, stage: 'DRAFT',previous_pointer, approval_hash: hash({ scope: this.#scope, id, assignment:r, version: version + 1, body,previous_pointer }) };
                            j.proposals.push(p);
                            await this.#save(j, principalId, r);
                            return this.#draft(p);
                        }
                        if (v.action === 'APPROVE' || v.action === 'VERIFY') {
                            const p = j.proposals.find(x => x.id === v.proposal_id);
                            if (!p)
                                return this.#reply('NOT_FOUND');
                            const r = this.#p.recipients.find(x => x.key === p.recipient)!;
                            await this.#assignment(r);
                            this.#binding(p,r);
                            if (p.stage === 'PUBLISHED' && this.#active(j, r)?.id !== p.id)
                                return this.#reply('SUPERSEDED', { proposal_id: p.id, version: p.version, current_version: this.#active(j, r)?.version });
                            if (p.stage !== 'PUBLISHED' && (this.#active(j, r)?.version ?? 0) !== p.base_version)
                                return this.#reply('STALE_PROPOSAL');
                            if (v.action === 'APPROVE') {
                                if (v.approval_hash !== p.approval_hash)
                                    return this.#reply('APPROVAL_MISMATCH');
                                if(p.stage==='PUBLISHED'){await this.#publishedProof(p,r);return this.#reply('PUBLISHED',{proposal_id:p.id,version:p.version,recipient:r.key,approval_required:false});}
                                if(p.stage==='APPROVED')return this.#approved(p,r);
                                const confirmation = v.confirmation.trim().toLowerCase();
                                if (!['oui', 'ok', 'yes', 'je valide', 'je confirme', 'validé', 'approuvé', 'je valide cette proposition pour ce destinataire.'].includes(confirmation))
                                    return this.#reply('APPROVAL_REQUIRED');
                                if (p.stage === 'DRAFT') {
                                    if (Date.parse(this.clock().toISOString()) - Date.parse(p.created_at) > 86400000)
                                        return this.#reply('PROPOSAL_EXPIRED');
                                    if ((this.#active(j, r)?.version ?? 0) !== p.base_version)
                                        return this.#reply('STALE_PROPOSAL');
                                    await this.#chain(this.#p.definitions_source_id,this.#p.meta_root_id);
                                    await this.#metaAssignment();
                                    if(p.previous_pointer!==await this.#pointer(r))throw Error('CURRENT_POINTER_CHANGED');
                                    p.stage = 'APPROVED';
                                    p.approved_at = this.clock().toISOString();
                                    p.confirmation = v.confirmation;
                                    await this.#save(j, principalId, r);
                                }
                                return this.#approved(p,r);
                            }
                            if (p.stage === 'DRAFT')
                                return this.#reply('APPROVAL_REQUIRED');
                            if (p.stage !== 'PUBLISHED' && (this.#active(j, r)?.version ?? 0) !== p.base_version)
                                return this.#reply('STALE_PROPOSAL');
                            const publication=await this.#publication(p,r);
                            if(publication.status!=='ORIENTATION_NATIVE_VERIFIED')return {...publication,version:p.version,recipient:r.key,approval_required:false};
                            if (p.stage !== 'PUBLISHED') {
                                p.stage = 'PUBLISHED';
                                j.active[r.key] = p.id;
                                await this.#save(j, principalId, r);
                            }
                            return this.#reply('PUBLISHED', { proposal_id: p.id, version: p.version, recipient: r.key,contract:'META_ORIENTATION/1.0',native_chain_verified:true,control_confirmed:false,business_result_verified:false, claim: 'EXACT_APPROVED_DIRECTION_PUBLISHED_NOT_LOCAL_POLICY_REPLACED' });
                        }
                    }
                    else {
                        const r = actor.recipient, p = this.#active(j, r);
                        await this.#assignment(r);
                        if (!p)
                            return this.#reply('NO_PUBLISHED_DIRECTION');
                        this.#binding(p,r);
                        await this.#publishedProof(p,r);
                        const today = this.clock().toISOString().slice(0, 10);
                        if (today < p.body.horizon.start)
                            return this.#reply('NOT_YET_EFFECTIVE', { version: p.version });
                        if (today > p.body.horizon.end)
                            return this.#reply('EXPIRED_DIRECTION', { version: p.version });
                        if (v.action === 'CONTEXT')
                            return this.#reply('PUBLISHED_DIRECTION', { version: p.version, proposal_id: p.id, recipient: r.key, direction: p.body, does_not_change_local_authority: true, needs_consumption: !j.consumptions[p.id]?.verified });
                        if (v.action === 'CONSUME' || v.action === 'VERIFY_CONSUMPTION') {
                            let c = j.consumptions[p.id];
                            if (!c) {
                                if (v.action === 'VERIFY_CONSUMPTION')
                                    return this.#reply('CONSUMPTION_REQUIRED');
                                c = { id: randomUUID(), proposal_id: p.id, created_at: this.clock().toISOString(), verified: false };
                                j.consumptions[p.id] = c;
                                await this.#save(j, principalId, r);
                            }
                            const w = this.#receipt(p, r, c);
                            try {
                                const found = await this.#match(w, r.root_page_id);
                                if (c.verified && c.receipt_id !== found.id)
                                    throw Error('RECEIPT_ID_CHANGED');
                                c.verified = true;
                                c.receipt_id = found.id;
                                await this.#save(j, principalId, r);
                                return this.#reply('CONSUMED', { version: p.version, receipt_id: found.id, claim: 'LOCAL_CONTROL_RECEIPT_OBSERVED_NOT_BUSINESS_RESULT' });
                            }
                            catch (e) {
                                if (v.action === 'VERIFY_CONSUMPTION' || c.verified)
                                    return this.#reply('UNCONFIRMED', { reason: refusal(e) });
                                if (e instanceof Error && e.message === 'MISSING_RECORD')
                                    return this.#reply('CONSUMPTION_PENDING_NOTION', { version: p.version, writes: [w], claim: 'NO_CONSUMPTION_CLAIM_BEFORE_READBACK' });
                                throw e;
                            }
                        }
                    }
                    return this.#reply('INVALID_ARGUMENT');
                }
                catch (e) {
                    return this.#reply('UNCONFIRMED', { reason: refusal(e) });
                }
            };
            const result = readOnly ? await execute() : await withRegistryLock(this.#p.journal_file, execute);
            const current=await this.#identity(principalId);
            if(!current)return this.#reply('ACCESS_DENIED');
            if(!current.owner){try{await this.#assignment(current.recipient);}catch(e){return this.#reply('UNCONFIRMED',{reason:refusal(e)});}}
            else if(typeof result.recipient==='string'){
                const recipient=this.#p.recipients.find(r=>r.key===result.recipient);
                if(recipient){try{await this.#assignment(recipient);}catch(e){return this.#reply('UNCONFIRMED',{reason:refusal(e)});}}
            }
            if (readOnly && observedJournal !== undefined) {
                try { if (observedJournal !== hash(await this.#journal())) return this.#reply('UNCONFIRMED', { reason: 'CHANGED_DURING_READ' }); }
                catch (e) { return this.#reply('UNCONFIRMED', { reason: refusal(e) }); }
            }
            return result;
        }
        catch {
            return this.#reply('UNCONFIRMED', { reason: 'JOURNAL_LOCK_UNAVAILABLE' });
        }
    }
}
