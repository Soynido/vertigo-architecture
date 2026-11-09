import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config/index.ts";
import { FilePrincipalRegistry } from "./auth/principal.ts";
import { createMemoryStore } from "./store/memory.ts";
import { FixtureNotionReadClient, HttpNotionReadClient, type NotionReadClient } from "./notion/readClient.ts";
import {PassiveSalesActivity} from './verify/passiveSalesActivity.ts';
import { HttpNotionClient, type NotionWriter } from "./notion/client.ts";
import { createAdapterRegistries } from "./versions/registry.ts";
import { registerBuiltinMetaAdapters } from "./versions/adapters/meta.ts";
import { registerBuiltinSalesAdapters } from "./versions/adapters/sales.ts";
import { registerBuiltinControlAdapters } from "./versions/adapters/control.ts";
import { EMPTY_SALES_REGISTRY, FileSalesRuntimeRegistry } from "./registry/salesRuntimes.ts";
import { COMMIT_TOOL_NAME, TOOL_NAMES, candidateResumeDescription, toolDescriptions, toolInputSchemas } from "./tools/surface.ts";
import { error } from "./tools/envelope.ts";
import { withUserSentence } from "./tools/messages.fr.ts";
import { candidateAppAvailability, candidatePlainLanguage, candidateResume, withConduct } from "./tools/conduct.ts";
import { redactSecrets } from "./server/redact.ts";
import { beginToolTrace, finishToolTrace } from "./server/toolTrace.ts";
import { dispatch, dispatchCommit, LEGACY_TOOL_NAMES, legacyUpgradeRefusal, type HarnessDeps } from "./tools/handlers.ts";
import type { CommitDeps } from "./transactions/commit.ts";
import { loadSkill } from "./tools/skill.ts";
import { PostgresBackend } from "./store/postgres.ts";
import { FileHttpTokenRegistry, startHttpServer } from "./server/http.ts";
import { readFileSync } from "node:fs";
import { NativeNoteControl, loadNativeNoteProfile } from "./verify/nativeNoteControl.ts";
import { createNativePilotServer } from "./server/nativePilot.ts";
import { NativeDirectionControl, loadNativeDirectionProfile } from "./verify/nativeDirectionControl.ts";
import { NativeMetaControl, loadNativeMetaProfile, type NativeMetaProfile } from "./verify/nativeMetaControl.ts";
import { RealDirectionControl, loadRealDirectionProfile } from './verify/realDirectionControl.ts';
import {NativeSalesControl,loadNativeSalesProfile,loadNativeSalesAdditionalProfiles,type NativeSalesProfile} from './verify/nativeSalesControl.ts';
import {createNativeSalesServer} from './server/nativeSales.ts';

export const GOVERNING_PLUGIN_SPEC = "PLUGIN_SPEC/0.3.0" as const;
export const SERVED_PLUGIN_CANDIDATE = "PLUGIN_SPEC/0.5.0-candidate" as const;

export interface BuildAttestation {
  readonly governing_spec: typeof GOVERNING_PLUGIN_SPEC;
  readonly served_candidate: typeof SERVED_PLUGIN_CANDIDATE;
  readonly revision: string;
  readonly dirty: boolean | "UNATTESTED_FIXTURE";
  readonly config_fingerprint: string;
}

/** Public, non-secret deployment identity carried by MCP initialize.serverInfo.version and the startup line. */
export function buildAttestation(config: HarnessDeps["config"]): BuildAttestation {
  return {
    governing_spec: GOVERNING_PLUGIN_SPEC,
    served_candidate: SERVED_PLUGIN_CANDIDATE,
    revision: config.buildRevision ?? "UNATTESTED_FIXTURE",
    dirty: config.buildDirty ?? "UNATTESTED_FIXTURE",
    config_fingerprint: config.configFingerprint ?? "UNATTESTED_FIXTURE",
  };
}

export function serverImplementationVersion(config: HarnessDeps["config"]): string {
  const a = buildAttestation(config);
  if (a.revision === "UNATTESTED_FIXTURE") return "0.5.0-candidate+fixture.unattested";
  return `0.5.0-candidate+rev.${a.revision}.dirty.${a.dirty ? "true" : "false"}.cfg.${a.config_fingerprint}`;
}

/**
 * PV0-024F: the fixture Notion world, keyed exactly like FixtureNotionReadClient expects
 * (`page:` / `database:` / `data_source:` / `children:` / `query:`). Absent ⇒ an empty world, i.e. the previous
 * behavior. `loadConfig` already refuses this file outside HARNESS_ENV=fixture, so no live deployment can reach it.
 */
function loadFixtureWorld(file: string | undefined): ReadonlyMap<string, unknown> {
  if (!file) return new Map();
  return new Map(Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>));
}

/**
 * PV-WRITE-001 / W1.1: the live process holds one Notion client, used for reads and — once the transaction
 * executor exists (W1.4+) — for the two allowlisted writes. Nothing reads `notionWriter` yet. The fixture
 * process has no writer. `clock` lets tests pin time; production uses the wall clock.
 */
type NativeOwnerDeps={readonly nativeNotePilot?:NativeNoteControl;readonly nativeDirectionPilot?:NativeDirectionControl;readonly nativeMetaControl?:NativeMetaControl};
export interface ServerDeps extends HarnessDeps, NativeOwnerDeps {
  readonly notionWriter?: NotionWriter;
  readonly clock?: () => Date;
}

export function buildDeps(env: NodeJS.ProcessEnv = process.env): ServerDeps {
  const config = loadConfig(env);
  const live = config.harnessEnv === "fixture"
    ? undefined
    : new HttpNotionClient(config.notionReadToken as string, (url, init) => fetch(url, init), { ratePerSecond: 2.8, max429Retries: 4, retryBaseMs: 1_000, requestTimeoutMs: 30_000 });
  const notion: NotionReadClient = live ?? new FixtureNotionReadClient(loadFixtureWorld(config.fixtureWorldFile));
  const adapters = createAdapterRegistries();
  registerBuiltinMetaAdapters(adapters.metaRuntime);
  registerBuiltinSalesAdapters(adapters.salesRuntime);
  registerBuiltinControlAdapters(adapters.control);
  const salesRegistry = config.salesRuntimeRegistryFile ? new FileSalesRuntimeRegistry(config.salesRuntimeRegistryFile) : EMPTY_SALES_REGISTRY;
  const principals = new FilePrincipalRegistry(config.principalsFile);
  const nativeNotePilot = config.nativeNotePilotFile ? new NativeNoteControl(loadNativeNoteProfile(config.nativeNotePilotFile), notion, principals) : undefined;
  let nativeDirectionPilot:NativeDirectionControl|undefined;
  if(config.nativeDirectionPilotFile&&nativeNotePilot){
    try{
      const profile=loadNativeDirectionProfile(config.nativeDirectionPilotFile);
      if(nativeNotePilot.owns(profile.principal_id))nativeDirectionPilot=new NativeDirectionControl(profile,notion,principals);
      else console.error("private_direction_pilot=DISABLED code=OWNER_MISMATCH");
    }catch{console.error("private_direction_pilot=DISABLED code=PROFILE_UNAVAILABLE");}
  }
  let nativeMetaControl:NativeMetaControl|undefined;
  let nativeMetaProfile:NativeMetaProfile|undefined;
  if(config.nativeMetaProfileFile&&nativeNotePilot){
    try{const profile=loadNativeMetaProfile(config.nativeMetaProfileFile);
      if(nativeNotePilot.owns(profile.principal_id)){nativeMetaProfile=profile;nativeMetaControl=new NativeMetaControl(profile,notion,principals);}
      else console.error("private_meta_control=DISABLED code=OWNER_MISMATCH");
    }catch{console.error("private_meta_control=DISABLED code=PROFILE_UNAVAILABLE");}
  }
  let nativeSalesControl:NativeSalesControl|undefined;
  let primarySalesProfile:NativeSalesProfile|undefined;
  if(config.nativeSalesProfileFile){try{const profile=loadNativeSalesProfile(config.nativeSalesProfileFile);if(!nativeNotePilot?.owns(profile.principal_id)){primarySalesProfile=profile;nativeSalesControl=new NativeSalesControl(profile,notion,principals,salesRegistry);}else console.error('native_sales_control=DISABLED code=OWNER_COLLISION');}catch{console.error('native_sales_control=DISABLED code=PROFILE_UNAVAILABLE');}}
  let nativeSalesControls:NativeSalesControl[]=[];
  const configuredSalesProfiles:NativeSalesProfile[]=primarySalesProfile?[primarySalesProfile]:[];
  if(config.nativeSalesAdditionalProfilesFile){try{
   const profiles=loadNativeSalesAdditionalProfiles(config.nativeSalesAdditionalProfilesFile,primarySalesProfile);
   if(profiles.some(p=>nativeNotePilot?.owns(p.principal_id)))throw new Error('OWNER_COLLISION');
   nativeSalesControls=profiles.map(p=>new NativeSalesControl(p,notion,principals,salesRegistry));
   configuredSalesProfiles.push(...profiles);
  }catch{console.error('native_sales_additions=DISABLED code=PROFILE_UNAVAILABLE');}}
  // Owner-only, independently paced read side; no seller callback, writer, timer or public schema change.
  if(nativeMetaControl&&nativeMetaProfile){
   try{
   if(live&&!config.notionReadToken)throw Error('PASSIVE_READ_CONNECTION_UNAVAILABLE');
   const activityReader=live&&config.notionReadToken?new HttpNotionReadClient(config.notionReadToken,(url,init)=>fetch(url,init),{ratePerSecond:2,burst:1,max429Retries:0,requestTimeoutMs:2500}):notion;
   const controls=[...(nativeSalesControl?[nativeSalesControl]:[]),...nativeSalesControls];
   const activity=new PassiveSalesActivity(activityReader,configuredSalesProfiles,id=>controls.find(c=>c.owns(id))?.isAdmitted(id)??Promise.resolve(false));
   nativeMetaControl=new NativeMetaControl(nativeMetaProfile,notion,principals,()=>activity.read());
   }catch{console.error('passive_activity=DISABLED code=PROFILE_UNAVAILABLE');}
  }
  let realDirectionControl:RealDirectionControl|undefined;
  if(config.nativeRealDirectionProfileFile){try{
   const profile=loadRealDirectionProfile(config.nativeRealDirectionProfileFile);
   if(!nativeMetaControl||!nativeMetaProfile||!nativeNotePilot?.owns(profile.owner_principal_id)||nativeMetaProfile.principal_id!==profile.owner_principal_id||nativeMetaProfile.root_page_id!==profile.meta_root_id)throw Error('OWNER_PROFILE_MISMATCH');
   if(nativeMetaProfile.project!==(profile.project??'VERTIGO')||nativeMetaProfile.runtime_id!==profile.publication.meta_runtime_id||nativeMetaProfile.manifest_page_id!==profile.publication.meta_manifest_page_id||nativeMetaProfile.manifest_data_source_id!==profile.publication.meta_manifest_source_id)throw Error('OWNER_PUBLICATION_PROFILE_MISMATCH');
   const knownGlobalSources=[nativeMetaProfile.manifest_data_source_id,...Object.entries(nativeMetaProfile.operating_sources??{}).filter(([name])=>name.endsWith('data_source_id')).map(([,id])=>id)];
   if(knownGlobalSources.some(id=>!profile.publication.protected_source_ids.includes(id)))throw Error('GLOBAL_SOURCE_PROTECTION_MISSING');
   for(const recipient of profile.recipients){const seller=configuredSalesProfiles.find(p=>p.principal_id===recipient.principal_id);
    if(seller&&seller.project!==(recipient.project??'VERTIGO'))throw Error('RECIPIENT_PROJECT_MISMATCH');
    if(!seller||seller.rep_identity_key!==recipient.rep_identity_key||seller.runtime_id!==recipient.runtime_id||seller.root_page_id!==recipient.root_page_id||seller.receipts_data_source_id!==recipient.receipts_source_id||seller.manifest_page_id!==recipient.manifest_page_id||seller.manifest_data_source_id!==recipient.manifest_data_source_id||seller.expected_gmail_identity.toLowerCase()!==recipient.mailbox.toLowerCase())throw Error('RECIPIENT_PROFILE_MISMATCH');
   }
   realDirectionControl=new RealDirectionControl(profile,notion,principals,salesRegistry);
  }catch{console.error('real_direction_control=DISABLED code=PROFILE_UNAVAILABLE');}}
  return { config, principals, store: createMemoryStore(), notion, adapters, salesRegistry, ...(live ? { notionWriter: live } : {}), ...(nativeNotePilot ? {nativeNotePilot} : {}), ...(nativeDirectionPilot?{nativeDirectionPilot}:{}), ...(nativeMetaControl?{nativeMetaControl}:{}),...(nativeSalesControl?{nativeSalesControl}:{}),...(nativeSalesControls.length?{nativeSalesControls}:{}),...(realDirectionControl?{realDirectionControl}:{}) };
}

/** Packaged deployment: the durable PostgreSQL transaction store when DATABASE_URL is set (plans, receipts, leases survive restarts). */
export async function buildLiveDeps(env: NodeJS.ProcessEnv = process.env): Promise<ServerDeps> {
  const deps = buildDeps(env);
  if (!deps.config.databaseUrl) return deps;
  const backend = new PostgresBackend(deps.config.databaseUrl);
  await backend.migrateAll(new URL("../migrations/", import.meta.url));
  return { ...deps, store: backend.store() };
}

/** Default five-tool surface; explicitly configured native profiles have isolated read/control surfaces. */
export function createServer(deps: HarnessDeps & NativeOwnerDeps, principalId: string | undefined): McpServer {
  const realDirection=principalId&&deps.realDirectionControl?.owns(principalId)?deps.realDirectionControl:undefined;
  if (principalId && deps.nativeNotePilot?.owns(principalId)) return createNativePilotServer(deps.nativeNotePilot, principalId, serverImplementationVersion(deps.config),deps.nativeDirectionPilot?.owns(principalId)?deps.nativeDirectionPilot:undefined,deps.nativeMetaControl?.owns(principalId)?deps.nativeMetaControl:undefined,realDirection);
  if(principalId&&deps.nativeSalesControl?.owns(principalId))return createNativeSalesServer(deps.nativeSalesControl,principalId,serverImplementationVersion(deps.config),realDirection);
  const addedSales=principalId?deps.nativeSalesControls?.find(control=>control.owns(principalId)):undefined;
  if(principalId&&addedSales)return createNativeSalesServer(addedSales,principalId,serverImplementationVersion(deps.config),realDirection);
  const skill = loadSkill();
  // The skill travels with the plugin: server instructions (read at initialize), a prompt and a resource. Not a tool.
  // 0.3.0 remains the governing Notion package. This process serves the guarded 0.5.0 candidate implementation;
  // a repository deploy cannot adopt it. Live HTTP adds the exact source/config identity to serverInfo.
  const server = new McpServer({ name: "vertigo-os-harness", version: serverImplementationVersion(deps.config) }, { instructions: skill });
  server.registerPrompt("vertigo_skill", { description: "VERTIGO OS operating skill: opening ritual, voice rules (repeat `say` verbatim, one question per turn, no codes/ids/JSON), verified transaction choreography, SALES email routing." }, () => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: skill } }] }));
  server.registerResource("vertigo_skill", "vertigo://skill", { title: "VERTIGO OS skill", description: "The plugin's operating skill (markdown).", mimeType: "text/markdown" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: skill }] }));
  for (const name of TOOL_NAMES) {
    if (name === COMMIT_TOOL_NAME) {
      // Announced here; answered by the CallTool route below, which parses its raw arguments itself.
      server.registerTool(name, { description: toolDescriptions[name], inputSchema: toolInputSchemas[name] }, async (input: unknown) => callCommit(deps as CommitDeps, principalId, input));
      continue;
    }
    server.registerTool(name, { description: name === "os_resume" ? candidateResumeDescription : toolDescriptions[name], inputSchema: toolInputSchemas[name] }, async (input: unknown) => {
      const trace = beginToolTrace(name);
      // A thrown error used to leave the transport as a bare JSON-RPC failure: no `tool=` line in the log, and a
      // caller left to quote the exception. Observed 2026-09-23 15:54Z on a primary-key collision. It is now an
      // envelope like any other: logged, in French for the seller, with the conduct that says nothing was written.
      let dispatched = await dispatch(name, input, { principal_id: principalId, ...(name === "os_resume" ? { candidate_resume: true as const } : {}), ...(name === "os_bind" ? { readonly_initial_read: true as const } : {}) }, deps).catch((err: unknown) =>
        withConduct(name, withUserSentence(name, error("ERROR_INTERNAL", redactSecrets(err instanceof Error ? err.message : String(err)), "retry the same call once; if it fails again, report it to the operator with the time"))));
      // W3.4: the five-tool candidate never relays the six-tool continuation (os_prepare/os_verify, native writes) nor
      // a gate key in `say`. Serialization-only: dispatch and its historical oracles are untouched.
      const ownerMetaStatus = Boolean(principalId && deps.config.metaRecoveryStatusPrincipalIds?.includes(principalId));
      if (name === "os_bind" && dispatched.status === "OK" && dispatched.code === "BOUND" && dispatched.result["initial_read"] &&
        (ownerMetaStatus || (dispatched.observations as Record<string, unknown>)["operation_policy"] === "LEGACY_READ_ONLY")) {
        const initial = candidatePlainLanguage("os_resume", candidateAppAvailability(candidateResume(dispatched.result["initial_read"] as ReturnType<typeof candidateResume>, ownerMetaStatus)));
        const initialResult = initial.status === "OK" ? initial.result : {};
        let initialMetadata: unknown = initial;
        if (initial.status === "OK") { const { result: _result, ...metadata } = initial; initialMetadata = metadata; }
        dispatched = { ...dispatched, result: { ...initialResult, ...dispatched.result, initial_read: initialMetadata },
          ...(initial.say !== undefined ? { say: initial.say } : {}), ...(initial.ask ? { ask: initial.ask } : {}),
          next: { safe_action: initial.next.safe_action,
            conduct: "This binding reply already includes its freshly read initial state's data in result; result.initial_read contains that read's status, limits and conduct. For this first reply, use ONLY that fresh state and its served conduct below, not the binding summary or chat history. The initial read performed no Notion writes and grants no new mutation authority. Do not repeat os_resume merely to retrieve the same initial state; keep this handle for the next human message. " + initial.next.conduct } };
      }
      const envelope = candidatePlainLanguage(name, candidateAppAvailability(name === "os_resume" ? candidateResume(dispatched, ownerMetaStatus) : dispatched));
      // Operational trace only: tool name and closed result enums are enough to diagnose a remote choreography.
      // Never log inputs, handles, ids, Notion values or credentials.
      finishToolTrace(trace, envelope);
      let text = JSON.stringify(envelope);
      if (name === "os_bind" && ownerMetaStatus && envelope.status === "OK" && envelope.result["initial_read"] && envelope.result["local_meta_operating_context"]) {
        const { next, result, ...metadata } = envelope;
        const { local_meta_operating_context, ...state } = result;
        const context = local_meta_operating_context as { documents?: readonly { role?: string }[] };
        const preferred = Array.isArray(context.documents) ? { ...context, documents: [
          ...context.documents.filter(d => d.role === "PRIVATE_BUSINESS_PACKAGE"),
          ...context.documents.filter(d => d.role !== "PRIVATE_BUSINESS_PACKAGE"),
        ] } : local_meta_operating_context;
        // Preserve every field, but put fresh instructions and selected facts before bulky legacy state.
        text = JSON.stringify({ next, ...metadata, result: { local_meta_operating_context: preferred, ...state } });
      }
      return { content: [{ type: "text" as const, text }], isError: envelope.status === "ERROR" };
    });
  }
  routeCommit(server, deps as CommitDeps, principalId);
  return server;
}

/**
 * `os_commit` answers its raw CallTool arguments here (W3.1), and is announced by ListTools since W3.3. W3.2:
 * `os_prepare`/`os_verify` are no longer announced and answer the upgrade refusal before any argument parsing or
 * binding read; they are never forwarded to os_commit. Every other name goes to the SDK's own tools/call handler.
 */
function routeCommit(server: McpServer, deps: CommitDeps, principalId: string | undefined): void {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, (request: unknown, extra: unknown) => Promise<unknown>> })._requestHandlers;
  const inner = handlers?.get("tools/call");
  if (!inner) throw new Error("MCP tools/call handler not found; os_commit cannot be staged on this SDK");
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (LEGACY_TOOL_NAMES.has(request.params.name)) {
      const refusal = legacyUpgradeRefusal(request.params.name);
      console.error(`${new Date().toISOString()} tool=${request.params.name} outcome=${refusal.kind} code=${refusal.code}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(refusal) }], isError: false };
    }
    if (request.params.name !== COMMIT_TOOL_NAME) return inner(request, extra) as never;
    return callCommit(deps, principalId, request.params.arguments ?? {});
  });
}

async function callCommit(deps: CommitDeps, principalId: string | undefined, args: unknown) {
  const trace = beginToolTrace(COMMIT_TOOL_NAME);
  const now = deps.clock?.();
  const outcome = await dispatchCommit(args, { principal_id: principalId, ...(now ? { now } : {}) }, deps).catch((err: unknown) => ({
    kind: "HELD" as const, origin: "INTENT" as const, phase: "PREPARE" as const, code: "ERROR_INTERNAL" as const,
    evidence: [redactSecrets(err instanceof Error ? err.message : String(err))], safe_action: "retry the same call once; if it fails again, report it to the operator with the time",
    // Unknown whether a write left before the failure: never claim that nothing was written.
    missing: [], wrote_anything: true, warnings: [], say: "Une erreur interne a interrompu l’appel ; ce qui a pu être écrit sera repris sans duplication.",
  }));
  // Closed enums only, like every tool line: never inputs, handles, ids, Notion values or credentials.
  finishToolTrace(trace, outcome);
  return { content: [{ type: "text" as const, text: JSON.stringify(outcome) }], isError: false };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const deps = await buildLiveDeps();
  if (deps.config.transport === "http") {
    // Remote MCP endpoint: the bearer token → principal mapping is deployment config; callers never name a principal.
    const listening = await startHttpServer(deps, await FileHttpTokenRegistry.load(deps.config.httpTokensFile as string), deps.config.httpPort, deps.config.httpHost, deps.config.allowPathToken);
    const a = buildAttestation(deps.config);
    console.error(`vertigo-os-harness listening on http://${deps.config.httpHost}:${listening.port}/mcp candidate=${a.served_candidate} governing=${a.governing_spec} revision=${a.revision} dirty=${a.dirty} config=${a.config_fingerprint} credentials=${deps.config.allowPathToken ? "header-or-url-path" : "header-only"} notion_writer=${deps.notionWriter ? "held_unused" : "none"}`);
    // An operator reading the log must be able to tell, without reading the environment, whether a URL is still
    // a credential on this deployment.
    if (deps.config.allowPathToken) console.error("warning: HARNESS_ALLOW_PATH_TOKEN is on, so the /mcp/<token> URL is itself a credential and cannot be shared; set it to false once every application sends an Authorization header");
  } else {
    // Transport-level principal: V0 dev binding reads it from the environment.
    const server = createServer(deps, process.env["HARNESS_PRINCIPAL_ID"]);
    await server.connect(new StdioServerTransport());
  }
}
