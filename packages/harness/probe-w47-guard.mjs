/** W4.7 helper: offline check/read-only preview for Codex; approval requires a human terminal. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createInterface } from "node:readline/promises";
import { buildDeps } from "./src/index.ts";
import { resolveRuntimeFor } from "./src/tools/handlers.ts";
import { PostgresBackend } from "./src/store/postgres.ts";
import { approveGuard } from "./src/cli/guard-approve.ts";
import { parseGuardIndex } from "./src/guards/index.ts";
import { canonicalJson } from "./src/guards/canonical.ts";
import { readGuardSnapshot } from "./src/guards/snapshot.ts";

const ROOT = "e033c8a8759159bda69b11cfee1f57b3";
const INDEX = "7b8b066ad3c1542fbe7c5139fb225373";
const CONSTITUTION = "36ffa29bd1aa52e193da3093c8b3b209";
const RUNTIME = "SALES-W47-CANARY-20261005";
const repo = new URL("../../", import.meta.url);
const fields = {
  "SALES:CAPABILITY_PROOFS": ["Capability Proof", "Capability Key", "State", "Runtime ID", "Principal Key", "Operating Mode", "Competent Source", "Evidence Ref", "Verified At", "Scope"],
  "SALES:INTERACTIONS": ["Interaction", "Event Key", "Provider", "Source Identity", "Event ID", "Thread ID", "Occurred At", "Receipt Key", "Accounts", "Contacts"],
  "SALES:RECEIPTS": ["Receipt", "Idempotency Key", "Event Type", "Provider", "Source Identity", "Event ID", "Thread ID", "Occurred At", "Observed At", "Evidence Ref", "Interaction Key", "Intent Ref", "Provenance", "Effect Status", "Verified"],
};
const expected = { schema_version: "SALES_GUARD_INDEX/1", revision: 2, p0_rules: [],
  operation_classes: Object.entries(fields).map(([resource_key, allowed_fields]) =>
    ({ class: "RECONCILE_AS_IS", resource_key, operation: "CREATE", allowed_fields })) };
const empty = { schema_version: "SALES_GUARD_INDEX/1", revision: 1, p0_rules: [], operation_classes: [] };
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const norm = (id) => typeof id === "string" ? id.replaceAll("-", "") : "";

export function assertLimitedIndex(value) {
  assert.equal(parseGuardIndex(value, "SALES_GUARD_INDEX/1").ok, true, "invalid index grammar");
  assert.ok(same(value, expected), "index differs from the three exact owner-accepted classes");
  return value;
}

export function checkedPreview(snapshot) {
  // Validate the very snapshot whose digest is shown, not a separate earlier block read.
  assertLimitedIndex(snapshot.index);
  assert.equal(norm(snapshot.index_page_id), INDEX);
  assert.match(snapshot.digest, /^[a-f0-9]{64}$/);
  // These are Active/P0/HOLD IDs, not all Active/P0 business rules. Canary1/3 are INTERNAL_ACT.
  assert.deepEqual(snapshot.p0_rule_ids, [], "governing P0 HOLD inventory changed");
  assert.equal(snapshot.constraints.size, 0, "new constraints require operator scope review");
  assert.equal(snapshot.refs.size, 0, "unexpected predicate source");
  return { kind: "PREVIEW", digest_sha256: snapshot.digest, index_page_id: INDEX,
    index_revision: snapshot.index.revision, p0_rule_ids: snapshot.p0_rule_ids,
    constraint_ids: [], operation_classes: snapshot.index.operation_classes.length, predicate_sources: 0 };
}

async function proposal() {
  const doc = await readFile(new URL("docs/W4_7_GUARD_OPERATOR_REVIEW.md", repo), "utf8");
  const blocks = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
  const candidates = blocks.filter((b) => b.schema_version === "SALES_GUARD_INDEX/1");
  assert.equal(candidates.length, 1, "ambiguous local proposal");
  return assertLimitedIndex(candidates[0]);
}

export function diagnosticMessage(error) {
  // Assertion first lines name our check; omit actual/expected dumps and arbitrary API/error bodies.
  return error?.name === "AssertionError" ? String(error.message).split("\n")[0] : "read/API/store failure; inspect the failed stage, never retry blindly";
}

export async function operatorMain(args = process.argv.slice(2), reportStage = () => {}) {
  const payload = await proposal();
  if (args.length === 1 && args[0] === "--check") {
    console.log("OFFLINE PASS: three exact constats only; zero API/DB/approval/send.");
    return;
  }
  const previewOnly = args.length === 1 && args[0] === "--preview-readonly";
  assert.ok(previewOnly || (args.length === 2 && args[0] === "--operator" && args[1].trim()),
    "usage: probe-w47-guard.mjs --check | --preview-readonly | --operator <your-operator-identity>");
  if (!previewOnly) assert.ok(process.stdin.isTTY && process.stdout.isTTY,
    "operator path requires a human terminal; piped approval is forbidden");
  const operator = previewOnly ? undefined : args[1].trim();
  reportStage("CREDENTIAL_READ");
  const credential = parseEnv(await readFile(new URL(".env", repo), "utf8"));
  const token = credential.NOTION_TOKEN?.trim() || credential.NOTION_READ_TOKEN?.trim();
  assert.ok(token, "missing existing integration credential");
  assert.ok(!(credential.NOTION_TOKEN && credential.NOTION_READ_TOKEN &&
    credential.NOTION_TOKEN.trim() !== credential.NOTION_READ_TOKEN.trim()), "credential aliases disagree");
  const env = { HARNESS_ENV: "live", HARNESS_TRANSPORT: "stdio", NOTION_TOKEN: token,
    PRINCIPALS_FILE: fileURLToPath(new URL("config/w47.principals.json", repo)),
    SALES_RUNTIME_REGISTRY_FILE: fileURLToPath(new URL("config/w47.sales-runtimes.json", repo)),
    ...(credential.VERTIGO_META_SPEC_ROOT ? { VERTIGO_META_SPEC_ROOT: credential.VERTIGO_META_SPEC_ROOT } : {}) };
  const base = buildDeps(env);
  const backend = previewOnly ? undefined : new PostgresBackend("postgresql://operator@127.0.0.1:5432/vertigo_w47_canary");
  const terminal = previewOnly ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  let provisioned = false;
  try {
    // Existing canary schema only: no migration/buildLiveDeps/default LIVE dependency.
    reportStage("CANARY_RESOLUTION");
    if (backend) await backend.ping();
    const deps = backend ? { ...base, store: backend.store() } : base;
    const principal = await deps.principals.get("p-valentin");
    assert.ok(principal && principal.status === "ACTIVE", "inactive canary principal");
    const resolved = await resolveRuntimeFor(deps, principal, "VERTIGO", "SALES");
    assert.equal(resolved.kind, "RESOLVED", "cannot resolve isolated canary");
    const rt = resolved.runtime;
    assert.equal(rt.root_ref, ROOT); assert.equal(rt.runtime_id, RUNTIME);
    assert.equal(rt.pointer_generation, "2"); assert.equal(rt.access_mode, "BUSINESS");
    assert.equal(rt.manifest_ref, "0a6376c7169d51879723dc271f961fb2");
    assert.equal(rt.manifest_pins.schema, "SALES_SCHEMA/0.5.8-candidate");
    assert.equal(rt.adapter.version, "SALES_RUNTIME_CONTRACT/0.5.13-candidate");
    reportStage("INDEX_READ");
    const page = await deps.notion.retrievePage(INDEX);
    assert.equal(norm(page.parent?.page_id), CONSTITUTION, "wrong index parent");
    const parent = await deps.notion.retrievePage(CONSTITUTION);
    assert.equal(norm(parent.parent?.page_id), ROOT, "index is outside the canary");
    const readIndex = async () => {
      const listed = await deps.notion.retrieveBlockChildren(INDEX);
      assert.equal(listed.has_more, false, "index pagination not complete");
      assert.ok(listed.next_cursor == null, "index cursor unexpectedly present");
      const codes = listed.results.filter((b) => b.type === "code" && b.code.language === "json" && !b.archived && !b.in_trash);
      assert.equal(codes.length, 1, "index must contain exactly one JSON block");
      const block = codes[0];
      return { id: block.id, payload: JSON.parse(block.code.rich_text.map((t) => t.plain_text ?? t.text?.content ?? "").join("")) };
    };
    const old = await readIndex();
    assert.ok(same(old.payload, empty) || same(old.payload, payload), "index changed: refusing overwrite");
    console.log(`Canary ${RUNTIME}, registry generation2, runtime generation ${rt.runtime_generation}. ${previewOnly ? "READ ONLY; no operator approval" : `Operator: ${operator}`}.\nOnly capability read proofs + human-sent mail constats. Production remains BLOCKED.`);
    if (!same(old.payload, payload)) {
      assert.ok(!previewOnly, "index not provisioned; read-only preview will not write it");
      reportStage("PROVISION_CONFIRMATION");
      assert.equal(await terminal.question(`Type PROVISION ${RUNTIME} to install these three classes, or Enter to stop: `), `PROVISION ${RUNTIME}`, "provisioning not confirmed");
      const fresh = await readIndex();
      assert.equal(fresh.id, old.id); assert.ok(same(fresh.payload, old.payload), "index drift before write");
      // Administrative operator write, never a public harness path or os_commit.
      const response = await fetch(`https://api.notion.com/v1/blocks/${old.id}`, {
        method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" },
        body: JSON.stringify({ code: { language: "json", rich_text: [{ type: "text", text: { content: JSON.stringify(payload, null, 2) } }] } }),
        signal: AbortSignal.timeout(30_000),
      });
      assert.ok(response.ok, `index write refused HTTP${response.status}; stop, no retry`);
      provisioned = true;
      reportStage("PROVISION_READBACK");
      assertLimitedIndex((await readIndex()).payload);
    }
    reportStage("SNAPSHOT_READ");
    const spec = rt.adapter.controlPlane.productionGuard;
    assert.ok(spec, "missing guard contract");
    const snapshot = await readGuardSnapshot({ client: deps.notion, runtime: rt, spec, t0: new Date(), indexPageId: INDEX });
    if (!snapshot.ok) console.log(`Guard preview refused: ${snapshot.reason}`);
    assert.ok(snapshot.ok, "guard preview refused; no approval written");
    reportStage("SNAPSHOT_SCOPE_CHECK");
    const preview = checkedPreview(snapshot.snapshot);
    console.log(JSON.stringify(preview, null, 2));
    if (previewOnly) {
      console.log("READ_ONLY_PREVIEW_PASS: zero PATCH, DB connection, approval, migration or send. This is not approval.");
      return;
    }
    reportStage("DIGEST_CONFIRMATION");
    assert.equal(await terminal.question("Paste APPROVE followed by the exact SHA-256 printed above, or Enter to stop: "), `APPROVE ${preview.digest_sha256}`, "exact digest not confirmed");
    reportStage("APPROVAL_FRESH_RECHECK");
    const request = { principal_id: "p-valentin", project: "VERTIGO", operator_id: operator, index_page_id: INDEX };
    const approval = await approveGuard(deps, { ...request, now: new Date(), approve_digest: preview.digest_sha256 });
    if (approval.kind === "REFUSED") console.log(`Guard approval refused: ${approval.reason}`);
    assert.equal(approval.kind, "APPROVED", "snapshot drift/refusal; no approval granted");
    console.log(JSON.stringify(approval, null, 2));
    console.log("Operator approval stored for this canary only. No mail sent; GW4.7 is NOT PASS.");
  } finally {
    if (provisioned) console.log("The canary index revision2 was provisioned; an interruption may leave it unapproved. Production remains blocked.");
    terminal?.close();
    if (backend) await backend.pool.end();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let stage = "ARGUMENT_CHECK";
  operatorMain(undefined, (next) => { stage = next; }).catch((error) => {
    console.error(`STOP W4.7 at ${stage}: ${diagnosticMessage(error)}. No auto-approval, retry, migration or send.`);
    process.exitCode = 1;
  });
}
