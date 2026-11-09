/** W4.2: production classifier over unchanged GTM synthetic captures, not a Gmail live canary. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileManualSends, SnapshotCompetentSource, type IntentView, type MailboxMessage } from "../../src/effects/gmail.ts";
import { buildGtmWorld, fingerprint, R_TEST, R_ALT } from "../gtm/world.ts";
import { NON_LIVE_MARKER } from "../gtm/catalog.ts";

const world = buildGtmWorld();
const mailbox = (runtime: string) => {
  const profile = world.principals.find((p) => p.runtime_key === runtime)!;
  assert.equal(profile.divergence, "NONE");
  assert.equal(profile.gmail_manifest_identity, profile.gmail_registry_identity);
  return profile.gmail_registry_identity!;
};
const contactAddress = (runtime: string, contact: string) => world.contacts.find((c) => c.runtime_key === runtime && c.contact_key === contact)!.canonical_identity;
// The GTM records are semantic fixtures, not raw provider payloads. This test-only projection supplies
// synthetic mailbox fields; it neither invents a send nor claims backend-verified Gmail provenance.
const capture: readonly MailboxMessage[] = Object.freeze(world.messages.map((m) => {
  assert.equal(m.provenance.non_live, NON_LIVE_MARKER);
  const owner = mailbox(m.runtime_key);
  const counterpart = contactAddress(m.runtime_key, m.contact_key);
  return Object.freeze({
    message_id: m.provider_message_id, thread_id: `THREAD-${m.contact_key}`,
    from: m.direction === "OUTBOUND" ? owner : counterpart,
    to: Object.freeze([m.direction === "OUTBOUND" ? counterpart : owner]),
    subject: m.message_key, date: m.occurred_at,
  });
}));
const WINDOW = { since: "2026-08-01T00:00:00+02:00", until: "2026-09-28T09:00:00+02:00" };
const source = (runtime = R_TEST, available = true) => new SnapshotCompetentSource(mailbox(runtime), capture, available);
const read = (contact: string, receipts: ReadonlySet<string> = new Set(), intents: readonly IntentView[] = [], runtime = R_TEST) =>
  reconcileManualSends(source(runtime), mailbox(runtime), contactAddress(runtime, contact), WINDOW, intents, receipts);

test("PT-GMAIL-016/a: every captured manual outbound is MATERIALIZE_ONCE, with no inferred OS intent", async () => {
  const found: string[] = [];
  for (const contact of world.contacts.filter((c) => c.runtime_key === R_TEST)) {
    const result = await read(contact.contact_key);
    assert.equal(result.status, "OK");
    for (const candidate of result.candidates) {
      assert.equal(candidate.disposition, "MATERIALIZE_ONCE");
      assert.equal(candidate.intent_action_key, undefined);
      assert.match(candidate.external_identity_key, /^EXTERNAL_EVENT\/1:[0-9a-f]{64}$/);
      found.push(candidate.message.message_id);
    }
  }
  assert.deepEqual(found.sort(), ["PM-OUT-C01", "PM-OUT-C01-LEGACY", "PM-OUT-C02", "PM-OUT-C03", "PM-OUT-C05", "PM-OUT-C06", "PM-OUT-C07", "PM-OUT-C08", "PM-OUT-C09", "PM-OUT-C10", "PM-OUT-C12-A", "PM-OUT-C12-B", "PM-OUT-C13"].sort());
});

test("PT-GMAIL-016/b: only the exact served receipt key suppresses materialization on replay", async () => {
  const first = await read("C01");
  assert.equal(first.candidates.length, 2);
  const current = first.candidates.find((c) => c.message.message_id === "PM-OUT-C01")!;
  const replay = await read("C01", new Set([current.external_identity_key]));
  assert.deepEqual(replay.candidates.map((c) => [c.message.message_id, c.disposition]).sort(), [
    ["PM-OUT-C01", "ALREADY_RECONCILED"], ["PM-OUT-C01-LEGACY", "MATERIALIZE_ONCE"],
  ]);
  assert.equal(replay.candidates.find((c) => c.message.message_id === current.message.message_id)?.external_identity_key, current.external_identity_key);
});

test("PT-GMAIL-016/c: a captured outbound explained by an explicit intent is not a manual send", async () => {
  const intent: IntentView = {
    intent_ref: "GTM_FIX:INTENT:OUT-C01", action_key: "OUT-C01-LEGACY", mailbox_identity: mailbox(R_TEST),
    recipient: contactAddress(R_TEST, "C01"), prepared_at: WINDOW.since, window_end: WINDOW.until, effect_status: "PREPARED",
  };
  const result = await read("C01", new Set(), [intent]);
  assert.deepEqual(result.candidates.map((c) => [c.message.message_id, c.disposition, c.intent_action_key]).sort(), [
    ["PM-OUT-C01", "MATERIALIZE_ONCE", undefined], ["PM-OUT-C01-LEGACY", "MATCHES_INTENT", intent.action_key],
  ]);
});

test("PT-GMAIL-016/d: the requested recipient/window exclude other contacts, old touches and all inbound kinds", async () => {
  const result = await reconcileManualSends(source(), mailbox(R_TEST), contactAddress(R_TEST, "C01"), {
    since: "2026-09-14T00:00:00+02:00", until: "2026-09-21T00:00:00+02:00",
  }, [], new Set());
  assert.deepEqual(result.candidates.map((c) => c.message.message_id), ["PM-OUT-C01"]);
  // C04 has an inbound with no prior outbound; technical/unknown/human inbound never become sends.
  assert.equal((await read("C04")).candidates.length, 0);
  assert.ok(capture.some((m) => m.message_id === "PM-IN-C01-1"));
  assert.ok(world.messages.some((m) => m.direction === "INBOUND" && m.kind === "TECHNICAL"));
  assert.ok(world.messages.some((m) => m.direction === "INBOUND" && m.kind === "UNKNOWN"));
});

test("PT-GMAIL-016/e: the other principal's captured outbound remains isolated by mailbox", async () => {
  assert.deepEqual((await read("C20", new Set(), [], R_ALT)).candidates.map((c) => [c.message.message_id, c.disposition]), [["PM-OUT-C20", "MATERIALIZE_ONCE"]]);
  const otherRecipient = await reconcileManualSends(source(), mailbox(R_TEST), contactAddress(R_ALT, "C20"), WINDOW, [], new Set());
  assert.deepEqual(otherRecipient, { status: "OK", candidates: [] });
  assert.deepEqual(await reconcileManualSends(source(R_ALT), mailbox(R_TEST), contactAddress(R_TEST, "C01"), WINDOW, [], new Set()), { status: "IDENTITY_MISMATCH", candidates: [] });
});

test("PT-GMAIL-016/f: unreadable or unknown source yields no partial manual-send candidate", async () => {
  for (const unavailable of [source(R_TEST, false), new SnapshotCompetentSource("UNKNOWN", capture)]) {
    assert.deepEqual(await reconcileManualSends(unavailable, mailbox(R_TEST), contactAddress(R_TEST, "C01"), WINDOW, [], new Set()), { status: "UNAVAILABLE", candidates: [] });
  }
});

test("PT-GMAIL-016/g: classification and receipt readback leave captures and GTM world unchanged", async () => {
  const before = fingerprint(world);
  const beforeCapture = JSON.stringify(capture);
  const first = await read("C12");
  assert.equal(first.candidates.length, 2, "two real fixture outbounds stay distinct; reply attribution ambiguity is not send identity");
  const replay = await read("C12", new Set(first.candidates.map((c) => c.external_identity_key)));
  assert.ok(replay.candidates.every((c) => c.disposition === "ALREADY_RECONCILED"));
  assert.equal(fingerprint(world), before);
  assert.deepEqual(world, buildGtmWorld());
  assert.equal(JSON.stringify(capture), beforeCapture);
  assert.ok(Object.isFrozen(world) && Object.isFrozen(world.messages[0]) && Object.isFrozen(capture[0]));
});
