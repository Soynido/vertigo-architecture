/** W4.1: external identity is provider + authenticated source + event, never a runtime/recipient tuple. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { externalIdentityKey, reconcileManualSends, SnapshotCompetentSource, type CompetentSource, type ExternalEventIdentity, type MailboxMessage } from "../../src/effects/gmail.ts";

const MAILBOX = "owner@example.invalid";
const RECIPIENT = "recipient@example.invalid";
const WINDOW = { since: "2030-01-01T00:00:00.000Z", until: "2030-01-02T00:00:00.000Z" };
const message = (mailbox = MAILBOX, id = "message-1", to = [RECIPIENT]): MailboxMessage => ({
  message_id: id, thread_id: "thread-1", from: mailbox, to, subject: "Manual message",
  date: "2030-01-01T12:00:00.000Z",
});
const identity = { provider: "GMAIL", source_identity: MAILBOX, event_id: "message-1" };
const read = (source: CompetentSource, mailbox = MAILBOX, receipts: ReadonlySet<string> = new Set(), recipient = RECIPIENT) => reconcileManualSends(source, mailbox, recipient, WINDOW, [], receipts);

test("PT-GMAIL-011/a: provider, source and event each own a separate identity, without business values in the key", () => {
  const key = externalIdentityKey(identity)!;
  assert.match(key, /^EXTERNAL_EVENT\/1:[a-f0-9]{64}$/);
  assert.equal(externalIdentityKey({ ...identity }), key);
  for (const changed of [{ ...identity, provider: "CALENDAR" }, { ...identity, source_identity: "other@example.invalid" }, { ...identity, event_id: "message-2" }]) assert.notEqual(externalIdentityKey(changed), key);
  assert.ok(!key.includes(MAILBOX) && !key.includes(identity.event_id));
  // Delimited concatenation could collapse these tuples; JSON tuple encoding cannot.
  assert.notEqual(externalIdentityKey({ provider: "a:b", source_identity: "c", event_id: "d" }), externalIdentityKey({ provider: "a", source_identity: "b:c", event_id: "d" }));
});

test("PT-GMAIL-011/b: runtime/generation, recipient and thread are attribution, not identity", () => {
  const a = { ...identity, runtime_id: "sales-A", runtime_generation: "1", recipient: RECIPIENT, thread_id: "thread-A" };
  const b = { ...identity, runtime_id: "sales-B", runtime_generation: "2", recipient: "another@example.invalid", thread_id: "thread-B" };
  assert.equal(externalIdentityKey(a), externalIdentityKey(b));
});

test("PT-GMAIL-011/c: absent or UNKNOWN tuple components are refused, never synthesized", () => {
  for (const field of ["provider", "source_identity", "event_id"] as const) {
    for (const bad of ["", " ", "UNKNOWN", " unknown ", undefined, null]) assert.equal(externalIdentityKey({ ...identity, [field]: bad } as unknown as ExternalEventIdentity), undefined);
  }
  assert.notEqual(externalIdentityKey({ ...identity, event_id: "MESSAGE-1" }), externalIdentityKey(identity), "opaque event ids retain their case");
});

test("PT-GMAIL-011/d: the actual Gmail decision serves and recognizes the scoped event key", async () => {
  const source = new SnapshotCompetentSource(MAILBOX, [message()]);
  const first = await read(source);
  assert.equal(first.status, "OK");
  assert.equal(first.candidates[0]?.external_identity_key, externalIdentityKey(identity));
  assert.equal(first.candidates[0]?.disposition, "MATERIALIZE_ONCE");
  const replay = await read(source, MAILBOX, new Set([first.candidates[0]!.external_identity_key]));
  assert.equal(replay.candidates[0]?.disposition, "ALREADY_RECONCILED");
});

test("PT-GMAIL-011/e: another mailbox with the same message id is not already reconciled", async () => {
  const key = externalIdentityKey(identity)!;
  const other = "other@example.invalid";
  const result = await read(new SnapshotCompetentSource(other, [message(other)]), other, new Set([key]));
  assert.equal(result.candidates[0]?.disposition, "MATERIALIZE_ONCE");
  assert.notEqual(result.candidates[0]?.external_identity_key, key);
  const providerKey = externalIdentityKey({ ...identity, provider: "CALENDAR" })!;
  assert.equal((await read(new SnapshotCompetentSource(MAILBOX, [message()]), MAILBOX, new Set([providerKey]))).candidates[0]?.disposition, "MATERIALIZE_ONCE");
});

test("PT-GMAIL-011/f: mailbox case is normalized, but another recipient does not reidentify one event", async () => {
  const recipient2 = "second@example.invalid";
  const source = new SnapshotCompetentSource(MAILBOX.toUpperCase(), [message(MAILBOX, "message-1", [RECIPIENT, recipient2])]);
  const key = externalIdentityKey(identity)!;
  const result = await read(source, MAILBOX, new Set([key]), recipient2);
  assert.equal(result.candidates[0]?.external_identity_key, key);
  assert.equal(result.candidates[0]?.disposition, "ALREADY_RECONCILED");
});

test("PT-GMAIL-011/g: legacy/truncated/mixed receipt keys are refused before any mailbox read", async () => {
  let reads = 0;
  const source: CompetentSource = { identity: async () => { reads++; return MAILBOX; }, searchSent: async () => { reads++; return [message()]; }, thread: async () => { reads++; return []; } };
  for (const bad of ["message-1", "EXTERNAL_EVENT/1:abc", "", "UNKNOWN"]) {
    assert.deepEqual(await read(source, MAILBOX, new Set([externalIdentityKey(identity)!, bad])), { status: "UNAVAILABLE", candidates: [] });
  }
  assert.equal(reads, 0, "no fallback or historical id adoption");
});

test("PT-GMAIL-011/h: unknown source/event identity and source mismatch refuse candidates", async () => {
  assert.equal((await read(new SnapshotCompetentSource("UNKNOWN", []))).status, "UNAVAILABLE");
  assert.equal((await read(new SnapshotCompetentSource("", []), "")).status, "UNAVAILABLE");
  assert.equal((await read(new SnapshotCompetentSource("other@example.invalid", []))).status, "IDENTITY_MISMATCH");
  const source: CompetentSource = { identity: async () => MAILBOX, searchSent: async () => [message(), message(MAILBOX, "UNKNOWN")], thread: async () => [] };
  assert.deepEqual(await read(source), { status: "UNAVAILABLE", candidates: [] }, "no partial identity window");
});
