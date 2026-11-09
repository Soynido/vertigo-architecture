/**
 * PT-GMAIL-002 / 005 / 010 evidence runner. Reads a JSON snapshot captured from the native Gmail connector
 * ({ identity, messages: MailboxMessage[] }) and an intent description, and prints the harness's deterministic
 * reconciliation. Read-only: this script cannot send anything.
 */
import { readFile } from "node:fs/promises";
import { reconcileIntent, reconcileManualSends, SnapshotCompetentSource, inboundSincePrepared, type IntentView, type MailboxMessage } from "../src/effects/gmail.ts";

const [snapshotPath, intentPath] = process.argv.slice(2);
if (!snapshotPath || !intentPath) { console.error("usage: live-gmail-reconcile.ts <snapshot.json> <intent.json>"); process.exit(2); }
const snap = JSON.parse(await readFile(snapshotPath, "utf8")) as { identity: string; messages: MailboxMessage[]; available?: boolean };
const spec = JSON.parse(await readFile(intentPath, "utf8")) as { intent: IntentView; manual?: { recipient: string; window: { since: string; until: string }; receipts_by_message_id: string[] } };
const source = new SnapshotCompetentSource(snap.identity, snap.messages, snap.available ?? true);
const out: Record<string, unknown> = { ran_at: new Date().toISOString(), identity: snap.identity, message_count: snap.messages.length };
out["reconciliation"] = await reconcileIntent(spec.intent, source);
out["inbound"] = await inboundSincePrepared(spec.intent, source);
if (spec.manual) out["manual"] = await reconcileManualSends(source, spec.intent.mailbox_identity, spec.manual.recipient, spec.manual.window, [spec.intent], new Set(spec.manual.receipts_by_message_id));
console.log(JSON.stringify(out, null, 2));
