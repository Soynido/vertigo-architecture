/**
 * GTM-W03 — natural-key correctness for runtime-scoped resources (D06).
 *
 * A runtime-scoped key is minted BY a runtime. Two runtimes minting the same local token is lawful and must be
 * neither a duplicate nor a cross-runtime resolution. This guard machine-checks the catalog invariant and then
 * proves it on a world where the second runtime mints the first runtime's tokens for rows of its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RESOURCE_CATALOG, RESOURCE_KEYS, resourceSpec } from "./catalog.ts";
import { BRANCHES } from "./matrix.ts";
import { buildGtmWorld, COLLECTION_RESOURCE, OBSERVED_AT, R_ALT, R_TEST, WEEK_W, withCollidingRuntimeKeys, type GtmWorld } from "./world.ts";
import {
  companyAggregate, contactOf, dispositionsInPeriod, entryCohort, episodeIdentity, episodeOf, episodeStatuses,
  exposureView, isUnavailable, linkSignals, meetingCounts, messageOf, readRows, weeklyRepliedProspects,
} from "./oracle.ts";

const base = buildGtmWorld();
const collided = withCollidingRuntimeKeys(base);
const scope = (runtime_key: string) => ({ runtime_key, period: WEEK_W, observed_at: OBSERVED_AT });

test("GTM-W03/keys a: every RUNTIME_SCOPED natural key carries runtime_key", () => {
  const offenders = RESOURCE_CATALOG
    .filter((r) => r.read_scope === "RUNTIME_SCOPED" && r.resource_key !== RESOURCE_KEYS.RUNTIME)
    .filter((r) => !r.natural_key.includes("runtime_key"))
    .map((r) => `${r.resource_key} [${r.natural_key.join("+")}]`);
  assert.deepEqual(offenders, [], "a runtime-scoped key that omits the runtime asserts a global uniqueness it does not have");
  assert.deepEqual(resourceSpec(RESOURCE_KEYS.RUNTIME)?.natural_key, ["runtime_key"], "the runtime itself is the one exception");
  for (const r of RESOURCE_CATALOG.filter((x) => x.read_scope === "CATALOG_GLOBAL")) {
    assert.equal(r.natural_key.includes("runtime_key"), false, `${r.resource_key} belongs to no runtime`);
  }
});

test("GTM-W03/keys b: a second runtime minting the same tokens is never a duplicate", () => {
  for (const [collection, resource_key] of Object.entries(COLLECTION_RESOURCE)) {
    const spec = resourceSpec(resource_key);
    assert.ok(spec !== undefined);
    const rows = collided[collection as keyof GtmWorld] as unknown as readonly Record<string, unknown>[];
    const keys = rows.map((row) => spec.natural_key.map((f) => String(row[f])).join("|"));
    const duplicates = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
    assert.deepEqual(duplicates, [], `${collection} natural key ${spec.natural_key.join("+")} collides across runtimes`);
  }
  for (const key of ["C01"]) assert.equal(collided.contacts.filter((c) => c.contact_key === key).length, 2, "both runtimes hold a row under that token");
  for (const key of ["OUT-C01", "IN-C01-1"]) assert.equal(collided.messages.filter((m) => m.message_key === key).length, 2);
  assert.equal(collided.episodes.filter((e) => e.meeting_episode_id === "EP-M01").length, 2);
});

test("GTM-W03/keys c: every runtime-scoped lookup resolves the runtime it was given", () => {
  assert.equal(contactOf(collided, R_TEST, "C01")?.party, "EXTERNAL_PROSPECT");
  assert.equal(contactOf(collided, R_ALT, "C01")?.party, "INTERNAL");
  assert.equal(contactOf(collided, R_TEST, "C01")?.company_key, "CO-01");
  assert.equal(contactOf(collided, R_ALT, "C01")?.company_key, "CO-ALT-INTERNAL");
  assert.equal(messageOf(collided, R_TEST, "OUT-C01")?.campaign_key, "CMP-2");
  assert.equal(messageOf(collided, R_ALT, "OUT-C01")?.campaign_key, "CMP-4");
  assert.equal(episodeOf(collided, R_TEST, "EP-M01")?.booked_at !== null, true);
  assert.equal(episodeOf(collided, R_ALT, "EP-M01")?.booked_at, null);
  assert.deepEqual(episodeStatuses(collided, R_TEST, "EP-M01"), ["PROPOSED", "ACCEPTED", "BOOKED"]);
  assert.deepEqual(episodeStatuses(collided, R_ALT, "EP-M01"), ["PROPOSED"]);
  assert.equal(episodeIdentity(collided, R_TEST, "EP-M01")?.provider_event_keys.length, 3);
  assert.equal(episodeIdentity(collided, R_ALT, "EP-M01")?.provider_event_keys.length, 1);
  assert.equal(exposureView(collided, R_TEST, "EXP-C01")?.communicated_price_cents, 90000);
  assert.equal(exposureView(collided, R_ALT, "EXP-C01")?.communicated_price_cents, 120000);
  assert.deepEqual(linkSignals(collided, R_TEST, "OUT-C01"), { sent: 1, read_events: 0, distinct_reads: 0 });
  assert.deepEqual(linkSignals(collided, R_ALT, "OUT-C01"), { sent: 0, read_events: 1, distinct_reads: 1 });
});

test("GTM-W03/keys d: a collision changes no per-runtime answer", () => {
  const before = {
    metric: weeklyRepliedProspects(base, scope(R_TEST)), cohort: entryCohort(base, scope(R_TEST)),
    companies: companyAggregate(base, scope(R_TEST)), meetings: meetingCounts(base, { ...scope(R_TEST), dataset: "O2" }),
    dispositions: dispositionsInPeriod(base, scope(R_TEST)),
  };
  const after = {
    metric: weeklyRepliedProspects(collided, scope(R_TEST)), cohort: entryCohort(collided, scope(R_TEST)),
    companies: companyAggregate(collided, scope(R_TEST)), meetings: meetingCounts(collided, { ...scope(R_TEST), dataset: "O2" }),
    dispositions: dispositionsInPeriod(collided, scope(R_TEST)),
  };
  assert.deepEqual(after, before, "the first runtime's answers are byte-identical");

  // The second runtime's own C01 is an internal counterpart: it never becomes a replied prospect.
  const alt = weeklyRepliedProspects(collided, scope(R_ALT));
  assert.ok(!isUnavailable(alt));
  assert.deepEqual(alt.contacts, ["C20"], "the colliding token adds no replied prospect to the second runtime");
  assert.equal(alt.value, 1);
  assert.deepEqual(
    dispositionsInPeriod(collided, scope(R_ALT)).map((d) => [d.message_key, d.disposition]),
    [["IN-C01-1", "INTERNAL_COUNTERPART"], ["IN-C20", "ELIGIBLE_HUMAN_REPLY"]],
  );
  const altCompanies = companyAggregate(collided, scope(R_ALT));
  assert.ok(!isUnavailable(altCompanies));
  assert.deepEqual(altCompanies.companies, ["CO-01"], "the company credit stays the second runtime's own");
});

test("GTM-W03/keys d2: an invariant over a runtime-scoped key is asserted per runtime", () => {
  // The second runtime holds an ACTIVE enrollment for its own C01 while the first holds one for its own C01.
  assert.deepEqual(
    collided.enrollments.filter((e) => e.contact_key === "C01" && e.state === "ACTIVE").map((e) => [e.runtime_key, e.campaign_key]),
    [["R_TEST", "CMP-2"], ["R_ALT", "CMP-4"]],
  );
  // The branch's own projection, evaluated on the colliding world: still one ACTIVE enrollment per contact.
  const uniqueness = BRANCHES.find((b) => b.id === "PT-GTM-008/D");
  assert.ok(uniqueness !== undefined);
  assert.deepEqual(uniqueness.final(collided), { max_active_per_contact: 1, contacts_with_two_active: [] });
  const pairs = BRANCHES.find((b) => b.id === "PT-GTM-008/C");
  assert.ok(pairs !== undefined);
  const projected = pairs.target(collided) as { enrollment_rows: number; distinct_pairs: number };
  assert.equal(projected.enrollment_rows, projected.distinct_pairs, "the enrollment natural key stays unique under collision");
});

test("GTM-W03/keys e: principal isolation survives the collision", () => {
  for (const [principal, runtime] of [["CELIA_FIXTURE", R_TEST], ["JULIAN_FIXTURE", R_ALT]] as const) {
    const rows = readRows(collided, principal, RESOURCE_KEYS.MESSAGE);
    assert.equal(rows.status, "OK");
    if (rows.status !== "OK") return;
    assert.deepEqual([...new Set(rows.rows.map((r) => r["runtime_key"]))], [runtime]);
    assert.equal(rows.rows.some((r) => r["message_key"] === "OUT-C01"), true, "each runtime sees its own row under that token");
  }
  assert.deepEqual(readRows(collided, "JULIAN_FIXTURE", RESOURCE_KEYS.MESSAGE, R_TEST), { status: "REFUSED", code: "REFUSED_FOREIGN_RUNTIME" });
  assert.deepEqual(readRows(collided, "VALENTIN_FIXTURE", RESOURCE_KEYS.MESSAGE, R_TEST), { status: "REFUSED", code: "REFUSED_NO_RUNTIME" });
});
