/**
 * A controlled Personal SALES runtime pinned to the CANDIDATE Sales contract (PV-GTM-002, W04/W05).
 *
 * Everything is synthetic: fabricated ids, the reserved `example.invalid` host, a fixture rep. The candidate
 * contract and schema strings are DISCOVERED from the adapter registry (`gtmCapableVersions`), never written
 * here, so no governing-looking version literal exists in the tests and PT-ARCH-002 keeps holding.
 *
 * The runtime carries the real control plane (03) plus the GTM containers (04) of the candidate catalog, so the
 * six tools run end to end against it: bind → resume → prepare → native writes → verify TARGET → finalization →
 * verify FINAL, exactly as on any other runtime.
 */
import type { Principal } from "../../src/auth/principal.ts";
import { CANDIDATE_POLICY_VERSION } from "../../src/contractPack/catalog.ts";
import type { Block, Page, RichText } from "../../src/notion/shapes.ts";
import { capabilityProofKey } from "../../src/resume/capabilities.ts";
import type { SalesRuntimeEntry } from "../../src/registry/salesRuntimes.ts";
import { gtmCapableVersions, registerBuiltinSalesAdapters, type SalesContractAdapter } from "../../src/versions/adapters/sales.ts";
import { buildWorld, OWNER, REP_B } from "../unit/binding-fixtures.ts";
import { synthetic, text } from "../unit/meta-fixtures.ts";
import { registryEntries } from "../unit/sales-fixtures.ts";
import { buildResumeWorld, registryRow, runPage, salesStatePage, SCHEMAS, setRowsIn, type ResumeWorld } from "../unit/resume-fixtures.ts";

const rt = (s: string): RichText[] => [text(s)];
const list = (blocks: Block[]) => ({ results: blocks, has_more: false, next_cursor: null });
const T = (names: [string, string][]) => ({ properties: Object.fromEntries(names.map(([n, t]) => [n, { type: t }])) });

export const REP_GTM: Principal = { principal_id: "p-rep-gtm", display_name: "Fixture GTM rep", status: "ACTIVE", allowed_projects: ["VERTIGO"], allowed_lanes: ["SALES"], rep_identity_key: "rep-gtm" };
export const REP_GTM_KEY = "rep-gtm";
export const REP_GTM_MAILBOX = "rep-gtm@example.invalid";
export const REP_GTM_INSTANCE = "SALESOS-FIXTURE-GTM";

export const G = {
  root: synthetic("gtm-root"),
  boot: synthetic("gtm-boot"),
  manifestDb: synthetic("gtm-manifest-db"), manifestDs: synthetic("gtm-manifest-ds"), manifestRow: synthetic("gtm-manifest-row"),
  contractPage: synthetic("gtm-contract-page"),
  cp: synthetic("gtm-cp"),
  stateDb: synthetic("gtm-state-db"), stateDs: synthetic("gtm-state-ds"), stateRow: synthetic("gtm-state-row"),
  runsDb: synthetic("gtm-runs-db"), runsDs: synthetic("gtm-runs-ds"), run1: synthetic("gtm-run-1"),
  ledgerDb: synthetic("gtm-ledger-db"), ledgerDs: synthetic("gtm-ledger-ds"),
  extDb: synthetic("gtm-ext-db"), extDs: synthetic("gtm-ext-ds"),
  capabilityDb: synthetic("gtm-capability-db"), capabilityDs: synthetic("gtm-capability-ds"),
  gtmPage: synthetic("gtm-04"),
  campaignsDb: synthetic("gtm-campaigns-db"), campaignsDs: synthetic("gtm-campaigns-ds"),
  versionsDb: synthetic("gtm-versions-db"), versionsDs: synthetic("gtm-versions-ds"),
  participationsDb: synthetic("gtm-participations-db"), participationsDs: synthetic("gtm-participations-ds"),
  enrollmentsDb: synthetic("gtm-enrollments-db"), enrollmentsDs: synthetic("gtm-enrollments-ds"),
  exposuresDb: synthetic("gtm-exposures-db"), exposuresDs: synthetic("gtm-exposures-ds"),
  episodesDb: synthetic("gtm-episodes-db"), episodesDs: synthetic("gtm-episodes-ds"),
  attributionsDb: synthetic("gtm-attributions-db"), attributionsDs: synthetic("gtm-attributions-ds"),
  coverageDb: synthetic("gtm-coverage-db"), coverageDs: synthetic("gtm-coverage-ds"),
  revisionsDb: synthetic("gtm-revisions-db"), revisionsDs: synthetic("gtm-revisions-ds"),
  snapshotsDb: synthetic("gtm-snapshots-db"), snapshotsDs: synthetic("gtm-snapshots-ds"),
} as const;

export const GTM_SCHEMAS = {
  capabilityProofs: T([["Capability Proof", "title"], ["Capability Proof Key", "rich_text"], ["Capability Key", "rich_text"], ["State", "select"], ["Runtime ID", "rich_text"], ["Principal Key", "rich_text"], ["Operating Mode", "rich_text"], ["Competent Source", "select"], ["Evidence Ref", "rich_text"], ["Verified At", "date"], ["Scope", "rich_text"]]),
  campaigns: T([["Campaign", "title"], ["Campaign Key", "rich_text"], ["Owner Rep", "rich_text"], ["Runtime ID", "rich_text"], ["Configured Offer", "rich_text"], ["Configured Price", "rich_text"], ["Status", "select"], ["Started At", "date"], ["Ended At", "date"], ["List Ref", "rich_text"], ["Dedup Ref", "rich_text"]]),
  approachVersions: T([["Approach Version", "title"], ["Approach Version Key", "rich_text"], ["Approach Key", "rich_text"], ["Version Label", "rich_text"], ["Authority Scope", "rich_text"], ["Variant Of", "rich_text"], ["Provenance Note", "rich_text"]]),
  participations: T([["Participation", "title"], ["Participation Key", "rich_text"], ["Approach Version", "rich_text"], ["Campaign", "rich_text"], ["Owner Rep", "rich_text"], ["Runtime ID", "rich_text"], ["Task Ref", "rich_text"]]),
  enrollments: T([["Enrollment", "title"], ["Enrollment Key", "rich_text"], ["Campaign", "rich_text"], ["Contact", "rich_text"], ["Account", "rich_text"], ["State", "select"], ["Started At", "date"], ["Ended At", "date"], ["Qualification Ref", "rich_text"], ["Evidence Ref", "rich_text"]]),
  exposures: T([
    ["Exposure", "title"], ["Exposure Key", "rich_text"], ["Contact", "rich_text"], ["Message Ref", "rich_text"],
    ["Campaign", "rich_text"], ["Approach Version", "rich_text"], ["Participation", "rich_text"],
    ["Communicated Offer", "rich_text"], ["Communicated Price", "rich_text"], ["Price Communicated", "rich_text"],
    ["Currency", "rich_text"], ["Price Unit", "rich_text"], ["Price Scope", "rich_text"], ["Price Cause Claimed", "rich_text"],
    ["Override Evidence", "rich_text"], ["Message Variant", "select"], ["Template Ref", "rich_text"],
    ["Link Sent", "rich_text"], ["Link Read", "rich_text"], ["Link Read Evidence", "rich_text"],
    ["Send Evidence", "select"], ["Provider Receipt", "rich_text"], ["Pinned At", "date"],
  ]),
  episodes: T([
    ["Episode", "title"], ["Meeting Episode ID", "rich_text"], ["Episode Kind", "select"], ["Contact", "rich_text"],
    ["Contacts", "rich_text"], ["Company", "rich_text"], ["Meeting Status", "select"], ["Agreement Evidence Ref", "rich_text"],
    ["Held Evidence Ref", "rich_text"], ["Proposed At", "date"], ["Accepted At", "date"], ["Booked At", "date"],
    ["Held At", "date"], ["Qualified At", "date"], ["Canceled At", "date"], ["Provider Event Refs", "rich_text"],
  ]),
  attributions: T([
    ["Attribution", "title"], ["Reply Attribution Key", "rich_text"], ["Reply Ref", "rich_text"], ["Contact", "rich_text"],
    ["Identity Resolution", "select"], ["Reply At", "date"], ["In Reply To", "rich_text"], ["Prior Touches", "rich_text"],
    ["Attribution Status", "select"], ["Attributed To", "rich_text"], ["Attributed Group", "rich_text"], ["Candidates", "rich_text"],
    ["Disposition", "select"], ["Counts As Reply", "rich_text"], ["Follow Up", "select"], ["Reply Kind", "select"],
    ["Reply Intent", "select"], ["Party", "select"], ["Duplicate Delivery", "rich_text"], ["Objection Context", "rich_text"],
    ["Provider Message Ref", "rich_text"], ["Source Instruction", "rich_text"], ["Provenance Note", "rich_text"],
    ["Counterfactual", "rich_text"], ["Outbound Sent", "rich_text"], ["Takeover Owner", "rich_text"],
  ]),
  coverage: T([["Coverage", "title"], ["Coverage Key", "rich_text"], ["Source", "select"], ["Since", "date"], ["Until", "date"], ["State", "select"], ["Note", "rich_text"]]),
  revisions: T([["Input Revision", "title"], ["Input Revision ID", "rich_text"], ["Reason", "select"], ["Basis Refs", "rich_text"], ["Basis Digest", "rich_text"], ["Supersedes", "rich_text"], ["Runtime ID", "rich_text"], ["Created At", "date"]]),
  snapshots: T([
    ["Snapshot", "title"], ["Snapshot Key", "rich_text"], ["Metric Key", "rich_text"], ["Layer", "select"],
    ["Period Key", "rich_text"], ["Period Start", "date"], ["Period End", "date"], ["Observation Cutoff", "date"],
    ["Scope", "select"], ["Value", "rich_text"], ["Computability", "select"], ["Input Revision", "rich_text"],
    ["Metric Definitions Version", "rich_text"], ["Metric Definitions Digest", "rich_text"],
    ["Coverage Refs", "rich_text"], ["Coverage Digest", "rich_text"], ["Coverage State Reported", "select"],
    ["Evidence Refs", "rich_text"], ["Target Comparison", "rich_text"], ["Numerator Unit", "rich_text"],
    ["Denominator Unit", "rich_text"], ["Compared With Snapshot", "rich_text"], ["Comparison Maturity Note", "rich_text"],
  ]),
};

export interface MetaRegistrationOptions {
  /** Register the GTM measurement resource at all. */
  readonly registered?: boolean;
  /** Pin the candidate policy version on the registration. Without it, a row never adopts the candidate policy. */
  readonly pinned?: boolean;
  readonly status?: string;
  /** Freshness of the index row, compared with the source row by the projection. */
  readonly lastVerified?: string;
  /** Freshness of the indexed source (the registered Sales-inputs resource). Absent means an unreadable source. */
  readonly sourceLastVerified?: string | null;
}

export interface GtmRuntimeWorld extends ResumeWorld {
  /** The candidate contract line discovered from the adapter registry (never spelled in a test). */
  readonly contractVersion: string;
  readonly schemaVersion: string;
  rows(ds: string): Page[];
  setRows(ds: string, rows: Page[]): void;
  setCapabilityProofs(rows: Page[]): void;
  /** Register (or clear) the META GTM measurement resource, with or without the explicit candidate pin. */
  setMetaGtmRegistration(options: MetaRegistrationOptions): void;
}

const rowOf = (id: string, titleProp: string, titleValue: string, fields: Record<string, unknown>, schema: { properties: Record<string, { type: string }> }): Page => {
  const properties: Record<string, unknown> = { [titleProp]: { type: "title", title: rt(titleValue) } };
  for (const [k, v] of Object.entries(fields)) {
    const type = schema.properties[k]?.type ?? "rich_text";
    properties[k] =
      type === "select" ? { type: "select", select: v === null ? null : { name: String(v) } }
        : type === "date" ? { type: "date", date: v === null ? null : { start: String(v) } }
          : { type: "rich_text", rich_text: rt(String(v ?? "")) };
  }
  return { object: "page", id, archived: false, last_edited_time: "2030-01-01T00:00:00.000Z", properties: properties as Page["properties"] };
};

/** A row of a GTM container, built from the container's own schema. */
export const gtmRow = rowOf;

export function capabilityProofRow(o: { capability: string; state?: string; source: string; verifiedAt?: string; evidenceRef?: string; operatingMode?: string; runtimeId?: string; principalKey?: string; id?: string }): Page {
  const verifiedAt = o.verifiedAt ?? "2030-01-02T08:00:00.000Z";
  const mode = o.operatingMode ?? "GTM_OBSERVABILITY";
  const evidenceRef = o.evidenceRef ?? `fixture://${o.source.toLowerCase()}/${o.capability.toLowerCase()}`;
  const runtimeId = o.runtimeId ?? REP_GTM_INSTANCE;
  const principalKey = o.principalKey ?? REP_GTM_KEY;
  const key = capabilityProofKey({ runtimeId, principalKey, capability: o.capability, operatingMode: mode, verifiedAt, evidenceRef });
  return gtmRow(o.id ?? synthetic(`capability-${o.capability}-${verifiedAt}`), "Capability Proof", o.capability, {
    "Capability Proof Key": key, "Capability Key": o.capability, State: o.state ?? "READ_VERIFIED",
    "Runtime ID": runtimeId, "Principal Key": principalKey, "Operating Mode": mode, "Competent Source": o.source,
    "Evidence Ref": evidenceRef, "Verified At": verifiedAt, Scope: `principal:${principalKey};runtime:${runtimeId};mode:${mode}`,
  }, GTM_SCHEMAS.capabilityProofs);
}

export function buildGtmRuntimeWorld(): GtmRuntimeWorld {
  const w = buildResumeWorld();
  const m = w.map;

  // The builtin Sales adapters (the adopted line and the GTM candidate) join the fixture registry; the candidate
  // line is then discovered by capability, so no test ever writes a contract version string.
  registerBuiltinSalesAdapters(w.deps.adapters.salesRuntime);
  const contractVersion = gtmCapableVersions(w.deps.adapters.salesRuntime)[0] as string;
  const adapter = w.deps.adapters.salesRuntime.resolve(contractVersion) as SalesContractAdapter;
  const schemaVersion = adapter.supportedSchemas[0] as string;
  const grammar = adapter.grammar;

  // Root, BOOT and the canonical Manifest of the candidate runtime.
  m.set(`page:${G.root}`, { object: "page", id: G.root, archived: false, properties: { title: { type: "title", title: rt("REP GTM - SALES AGENT OS") } } });
  m.set(`children:${G.root}`, list([
    { id: G.boot, type: "child_page", child_page: { title: grammar.bootTitle } },
    { id: G.cp, type: "child_page", child_page: { title: "03 — CONTROL PLANE" } },
    { id: G.gtmPage, type: "child_page", child_page: { title: "04 — GTM" } },
  ]));
  m.set(`children:${G.boot}`, list([{ id: G.manifestDb, type: "child_database", child_database: { title: grammar.manifestDatabaseTitle } }]));
  m.set(`database:${G.manifestDb}`, { object: "database", id: G.manifestDb, title: rt(grammar.manifestDatabaseTitle), data_sources: [{ id: G.manifestDs, name: grammar.manifestDatabaseTitle }] });
  m.set(`page:${G.contractPage}`, { object: "page", id: G.contractPage, archived: false, properties: { title: { type: "title", title: rt(contractVersion) } } });
  const manifest: Page = {
    object: "page", id: G.manifestRow, archived: false, last_edited_time: "2030-01-01T00:00:00.000Z",
    properties: {
      Name: { type: "title", title: rt(grammar.currentRowTitle) },
      "Root URL": { type: "url", url: `https://example.invalid/p/${G.root}` },
      "Instance ID": { type: "rich_text", rich_text: rt(REP_GTM_INSTANCE) },
      Owner: { type: "rich_text", rich_text: rt("Fixture GTM rep") },
      "Gmail Identity": { type: "email", email: REP_GTM_MAILBOX },
      "Install State": { type: "select", select: { name: "READY" } },
      "Instance Status": { type: "select", select: { name: "ACTIVE" } },
      "Sales Contract Version": { type: "rich_text", rich_text: rt(contractVersion) },
      "Sales Contract URL": { type: "url", url: `https://example.invalid/p/${G.contractPage}` },
      "Schema Version": { type: "rich_text", rich_text: rt(schemaVersion) },
      "Strategy Version": { type: "rich_text", rich_text: [] },
      "Toolkit Version": { type: "rich_text", rich_text: [] },
      "Authority Version": { type: "rich_text", rich_text: [] },
      "Last Run Ref": { type: "rich_text", rich_text: [] },
    },
  };
  setRowsIn(m, G.manifestDs, [manifest]);

  // Control plane (03) and GTM containers (04).
  const db = (id: string, ds: string, title: string) => m.set(`database:${id}`, { object: "database", id, title: rt(title), data_sources: [{ id: ds, name: title }] });
  m.set(`children:${G.cp}`, list([
    { id: G.stateDb, type: "child_database", child_database: { title: "OS State" } },
    { id: G.runsDb, type: "child_database", child_database: { title: "Runs" } },
    { id: G.ledgerDb, type: "child_database", child_database: { title: "Mutation Ledger" } },
    { id: G.extDb, type: "child_database", child_database: { title: "External Actions" } },
    { id: G.capabilityDb, type: "child_database", child_database: { title: "Capability Profile" } },
  ]));
  db(G.stateDb, G.stateDs, "OS State"); db(G.runsDb, G.runsDs, "Runs"); db(G.ledgerDb, G.ledgerDs, "Mutation Ledger"); db(G.extDb, G.extDs, "External Actions"); db(G.capabilityDb, G.capabilityDs, "Capability Profile");
  m.set(`data_source:${G.stateDs}`, SCHEMAS.salesState); m.set(`data_source:${G.runsDs}`, SCHEMAS.salesRuns);
  m.set(`data_source:${G.ledgerDs}`, SCHEMAS.salesLedger); m.set(`data_source:${G.extDs}`, SCHEMAS.salesExt); m.set(`data_source:${G.capabilityDs}`, GTM_SCHEMAS.capabilityProofs);
  setRowsIn(m, G.stateDs, [{ ...salesStatePage({ lastRunId: G.run1, operatingMode: "GTM_OBSERVABILITY" }), id: G.stateRow }]);
  setRowsIn(m, G.runsDs, [runPage({ id: G.run1, label: "SRUN-1", status: "COMPLETED", lane: "SALES", lastEdited: "2030-01-01T12:00:00.000Z", spec: contractVersion, schema: schemaVersion })]);
  setRowsIn(m, G.ledgerDs, []);
  setRowsIn(m, G.extDs, []);
  setRowsIn(m, G.capabilityDs, [
    capabilityProofRow({ capability: "NOTION_RUNTIME_READ", source: "NOTION" }),
    capabilityProofRow({ capability: "GMAIL_READ", source: "GMAIL" }),
    capabilityProofRow({ capability: "CALENDAR_READ", source: "GOOGLE_CALENDAR" }),
    capabilityProofRow({ capability: "MAIL_TRACKER_READ", source: "MAIL_TRACKER", state: "HUMAN_AUTH_PENDING" }),
  ]);

  const containers: Array<[string, string, string, { properties: Record<string, { type: string }> }]> = [
    [G.campaignsDb, G.campaignsDs, "Campaigns", GTM_SCHEMAS.campaigns],
    [G.versionsDb, G.versionsDs, "Approach Versions", GTM_SCHEMAS.approachVersions],
    [G.participationsDb, G.participationsDs, "Participations", GTM_SCHEMAS.participations],
    [G.enrollmentsDb, G.enrollmentsDs, "Enrollments", GTM_SCHEMAS.enrollments],
    [G.exposuresDb, G.exposuresDs, "Exposures", GTM_SCHEMAS.exposures],
    [G.episodesDb, G.episodesDs, "Meeting Episodes", GTM_SCHEMAS.episodes],
    [G.attributionsDb, G.attributionsDs, "Reply Attributions", GTM_SCHEMAS.attributions],
    [G.coverageDb, G.coverageDs, "Coverage Declarations", GTM_SCHEMAS.coverage],
    [G.revisionsDb, G.revisionsDs, "Input Revisions", GTM_SCHEMAS.revisions],
    [G.snapshotsDb, G.snapshotsDs, "Metric Snapshots", GTM_SCHEMAS.snapshots],
  ];
  m.set(`children:${G.gtmPage}`, list(containers.map(([id, , title]) => ({ id, type: "child_database", child_database: { title } }))));
  for (const [id, ds, title, schema] of containers) {
    db(id, ds, title);
    m.set(`data_source:${ds}`, schema);
    setRowsIn(m, ds, []);
  }

  // Durable GTM state a rep already has: one campaign, one approach version, one participation.
  setRowsIn(m, G.campaignsDs, [
    gtmRow(synthetic("gtm-campaign-1"), "Campaign", "CMP-1", {
      "Campaign Key": "CMP-1", "Owner Rep": REP_GTM_KEY, "Runtime ID": REP_GTM_INSTANCE,
      "Configured Offer": "OFFER-STD", "Configured Price": "120000", Status: "ACTIVE",
      "Started At": "2030-01-01T09:00:00.000Z", "List Ref": "LIST-1", "Dedup Ref": "DEDUP-1",
    }, GTM_SCHEMAS.campaigns),
  ]);
  setRowsIn(m, G.versionsDs, [
    gtmRow(synthetic("gtm-version-1"), "Approach Version", "AP-1/v1", {
      "Approach Version Key": "AP-1/v1", "Approach Key": "AP-1", "Version Label": "v1", "Authority Scope": "SALES_OUTBOUND_EMAIL",
    }, GTM_SCHEMAS.approachVersions),
  ]);
  setRowsIn(m, G.participationsDs, [
    gtmRow(synthetic("gtm-participation-1"), "Participation", "PART-1", {
      "Participation Key": "PART-1", "Approach Version": "AP-1/v1", Campaign: "CMP-1",
      "Owner Rep": REP_GTM_KEY, "Runtime ID": REP_GTM_INSTANCE, "Task Ref": "TASK-1",
    }, GTM_SCHEMAS.participations),
  ]);

  // Principals and the registry pointer of the candidate runtime.
  w.setPrincipals([OWNER, REP_B, REP_GTM]);
  const entries: SalesRuntimeEntry[] = [
    ...registryEntries(),
    { rep_identity_key: REP_GTM_KEY, status: "KNOWN", root_ref: G.root, expected_instance_id: REP_GTM_INSTANCE, expected_gmail_identity: REP_GTM_MAILBOX, pointer_generation: "1" },
  ];
  w.setSalesRegistry(entries);

  const world: GtmRuntimeWorld = {
    ...w,
    contractVersion,
    schemaVersion,
    rows(ds) { return ((m.get(`query:${ds}`) as { results?: Page[] } | undefined)?.results ?? []); },
    setRows(ds, rows) { setRowsIn(m, ds, rows); },
    setCapabilityProofs(rows) { setRowsIn(m, G.capabilityDs, rows); },
    setMetaGtmRegistration(options) {
      const rows: Page[] = [];
      const sourceLastVerified = options.sourceLastVerified === undefined ? "2030-01-02T00:00:00.000Z" : options.sourceLastVerified;
      if (sourceLastVerified !== null) {
        rows.push(registryRow({ key: "META_SALES_RUNTIME_INPUTS", status: "RESOLVED", lastVerified: sourceLastVerified }));
      }
      if (options.registered !== false) {
        rows.push(registryRow({
          key: "META_GTM_METRICS",
          status: options.status ?? "RESOLVED",
          scope: "PRIVATE_META",
          schemaVersion: options.pinned === false ? "TEST_GTM_INDEX/1" : CANDIDATE_POLICY_VERSION,
          lastVerified: options.lastVerified ?? "2030-01-02T00:00:00.000Z",
          notes: "candidate GTM measurement resource",
        }));
      }
      w.setMetaRegistry(rows);
    },
  };
  world.setMetaGtmRegistration({ registered: true, pinned: true });
  return world;
}
