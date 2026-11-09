import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { untouchedEventDraft, exactUnwrittenPredecessor, fixedStartedEvent, exactPreparedEventRecovery, replayUnchanged,
  checkpointHash, immutablePlanHash, eventProbeMode, partialProbeStop, exactPartialEventCheckpoint, exactPreparedPartialRecovery,
  exactFinalEventCheckpoint, exactPreparedFinalRecovery, exactCutoffEventCheckpoint, exactPreparedCutoffRecovery, cutoffContinuation } from "./probe-w47-event-proof.mjs";

function fixture() {
  const writes = Array.from({ length: 11 }, (_, ordinal) => ({ symbol: `symbol${ordinal}`, ordinal, operation: "CREATE", target_ref: `ds${ordinal}` }));
  const previous = { plan_id: "old", binding_id: "old-binding", plan_state: "SUPERSEDED", plan_kind: "BUSINESS", run_mode: "OPEN_NEW",
    principal_id: "owner", project: "VERTIGO", lane: "SALES", runtime_logical_key: "logical", runtime_id: "canary", runtime_generation: "gen2",
    governing_spec_version: "spec", governing_schema_version: "schema", governing_control_version: "control",
    operations: ["SALES:INTERACTIONS", "SALES:RECEIPTS"].map((logical_resource_key) => ({ logical_resource_key, operation: "CREATE",
      target_data_source_ref: logical_resource_key, natural_key: "fixed-event", natural_key_property: "key", idempotency_key: logical_resource_key,
      expected_values: { Provider: "GMAIL", "Source Identity": "owner@example.invalid", "Event ID": "fixed-event", Contacts: ["test-contact"] } })),
    stage1_writes: writes.slice(0, 7), finalization_writes: writes.slice(7, 10), state_last_write: writes[10] };
  const successor = structuredClone({ ...previous, plan_id: "new", binding_id: "new-binding", plan_state: "AWAITING_STAGE1_WRITES" });
  const journal = writes.map((w) => ({ ...w, plan_id: previous.plan_id, phase: w.ordinal < 7 ? "STAGE1" : w.ordinal < 10 ? "FINALIZATION" : "STATE_LAST", status: "PENDING", attempts: 0 }));
  return { previous, successor, journal };
}

test("exact untouched own capture takeover is admitted without effects", () => {
  const { previous, successor, journal } = fixture();
  assert.equal(untouchedEventDraft(previous, journal), true);
  assert.equal(exactUnwrittenPredecessor(previous, successor, journal), true);
});

test("foreign identity, version, source, capture or ownership never admits takeover", () => {
  for (const field of ["principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation", "governing_spec_version", "governing_schema_version", "governing_control_version"]) {
    const { previous, successor, journal } = fixture(); previous[field] = "foreign";
    assert.equal(exactUnwrittenPredecessor(previous, successor, journal), false, field);
  }
  for (const field of ["logical_resource_key", "operation", "target_data_source_ref", "natural_key", "natural_key_property", "idempotency_key"]) {
    const { previous, successor, journal } = fixture(); previous.operations[0][field] = "foreign";
    assert.equal(exactUnwrittenPredecessor(previous, successor, journal), false, field);
  }
  const { previous, successor, journal } = fixture(); previous.operations[0].expected_values["Event ID"] = "other-event";
  assert.equal(exactUnwrittenPredecessor(previous, successor, journal), false);
});

test("only SUPERSEDED, different binding/plan, no recovery or other authority", () => {
  for (const [field, value] of [["plan_state", "EXPIRED"], ["plan_state", "FINAL_VERIFIED"], ["plan_state", "AWAITING_STAGE1_WRITES"],
    ["binding_id", "new-binding"], ["plan_id", "new"], ["plan_kind", "INSTALL"], ["run_mode", "RECOVER"], ["recovers_plan_id", "parent"], ["plan_origin", "AUTO_RECONCILE"]]) {
    const { previous, successor, journal } = fixture(); previous[field] = value;
    assert.equal(exactUnwrittenPredecessor(previous, successor, journal), false, `${field} ${value}`);
  }
});

test("started/sent/attempted/error journal, missing/duplicate/mismatched symbols all refuse", () => {
  for (const [field, value] of [["status", "SENT"], ["status", "DONE"], ["status", "OBSERVED"], ["attempts", 1], ["sent_at", new Date()],
    ["done_at", new Date()], ["created_id", "page"], ["payload_hash", "hash"], ["stamped_now", new Date()], ["last_error", "error"],
    ["plan_id", "other"], ["ordinal", 99], ["phase", "FINALIZATION"], ["operation", "UPDATE"], ["target_ref", "foreign"]]) {
    const { previous, successor, journal } = fixture(); journal[0][field] = value;
    assert.equal(exactUnwrittenPredecessor(previous, successor, journal), false, field);
  }
  for (const failure of ["missing", "duplicate", "bad-manifest"]) {
    const { previous, successor, journal } = fixture();
    if (failure === "missing") journal.pop();
    if (failure === "duplicate") journal[10] = journal[0];
    if (failure === "bad-manifest") previous.stage1_writes[0].symbol = "wrong";
    assert.equal(exactUnwrittenPredecessor(previous, successor, journal), false, failure);
  }
});

function startedFixture() {
  const { previous: plan, journal } = fixture();
  plan.plan_state = "AWAITING_STAGE1_WRITES";
  plan.stage1_writes[0].symbol = journal[0].symbol = "OPEN_RUN";
  plan.operations.forEach((op, ordinal) => { op.ordinal = ordinal; });
  Object.assign(journal[0], { status: "DONE", attempts: 1, created_id: "actual-run", done_at: new Date(),
    sent_at: new Date(), payload_hash: "hash", stamped_now: new Date() });
  const binding = { ...plan, binding_id: "fresh-binding", governing_versions_snapshot: { spec: "spec", schema: "schema", control: "control" } };
  const expected = plan.operations.map((op) => ({ resource: op.logical_resource_key,
    natural_key_property: op.natural_key_property, values: structuredClone(op.expected_values) }));
  return { plan, journal, binding, expected, key: "fixed-event" };
}

test("started checkpoint accepts old binding/expiry only with exact own OPEN_RUN and pristine rest", () => {
  const { plan, journal, binding, expected, key } = startedFixture();
  assert.equal(fixedStartedEvent(plan, journal, binding, expected, key), true);
  plan.plan_state = "EXPIRED";
  assert.equal(fixedStartedEvent(plan, journal, binding, expected, key), true);
  assert.equal(untouchedEventDraft(plan, journal), false, "not pristine handoff admission");
});

test("started checkpoint refuses changed ownership/pins/capture/lineage", () => {
  for (const field of ["principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation",
    "governing_spec_version", "governing_schema_version", "governing_control_version", "plan_kind", "run_mode", "plan_origin", "recovers_plan_id", "parent_plan_id", "plan_state"]) {
    const { plan, journal, binding, expected, key } = startedFixture(); plan[field] = "foreign";
    assert.equal(fixedStartedEvent(plan, journal, binding, expected, key), false, field);
  }
  for (const field of ["ordinal", "operation", "logical_resource_key", "natural_key", "natural_key_property"]) {
    const { plan, journal, binding, expected, key } = startedFixture(); plan.operations[0][field] = "changed";
    assert.equal(fixedStartedEvent(plan, journal, binding, expected, key), false, field);
  }
  const { plan, journal, binding, expected, key } = startedFixture();
  plan.operations[0].expected_values["Event ID"] = "other";
  assert.equal(fixedStartedEvent(plan, journal, binding, expected, key), false);
});

test("started checkpoint refuses ambiguous or modified journal, never normalizes other rows", () => {
  for (const [row, field, value] of [[0,"status","SENT"],[0,"attempts",2],[0,"created_id",null],[0,"last_error","fail"],
    [0,"plan_id","other"],[0,"target_ref","foreign"],[1,"status","DONE"],[1,"attempts",1],
    [1,"sent_at",new Date()],[1,"payload_hash","hash"],[1,"created_id","other"],[1,"phase","STATE_LAST"]]) {
    const { plan, journal, binding, expected, key } = startedFixture(); journal[row][field] = value;
    assert.equal(fixedStartedEvent(plan, journal, binding, expected, key), false, `${row} ${field}`);
  }
  const { plan, journal, binding, expected, key } = startedFixture(); journal.pop();
  assert.equal(fixedStartedEvent(plan, journal, binding, expected, key), false);
});

test("replay proof requires whole-runtime writes/receipts/plan count unchanged, including non-lineage effects", () => {
  const before = { writes: 25, receipts: 6, plans: 8 };
  assert.equal(replayUnchanged(before, { ...before }), true);
  // A non-lineage write is visible only in whole-runtime counters; unchanged lineage is not proof.
  for (const k of ["writes", "receipts", "plans"]) assert.equal(replayUnchanged(before, { ...before, [k]: before[k] + 1 }), false, k);
  assert.equal(replayUnchanged(before, { ...before, writes: undefined }), false);
  assert.equal(replayUnchanged({ ...before, writes: -1 }, { ...before, writes: -1 }), false);
});

function recoveryFixture() {
  const f = startedFixture();
  f.plan.plan_state = "EXPIRED";
  const child = structuredClone({ ...f.plan, plan_id: "recovery", binding_id: f.binding.binding_id,
    plan_state: "AWAITING_STAGE1_WRITES", run_mode: "RECOVER_EXISTING", plan_origin: "AUTO_RECOVERY",
    parent_plan_id: f.plan.plan_id, recovers_plan_id: f.plan.plan_id, run_ref: "actual-run", expires_at: new Date(2000) });
  Object.assign(child.stage1_writes[0], { symbol: "RESUME_RUN", purpose: "RESUME_RUN", operation: "UPDATE", target_ref: "actual-run" });
  child.operations.forEach((op, i) => { op.operation_id = `fresh-${i}`; });
  const journal = [...child.stage1_writes, ...child.finalization_writes, child.state_last_write].map((w, i) => ({
    ...w, plan_id: child.plan_id, phase: i < 7 ? "STAGE1" : i < 10 ? "FINALIZATION" : "STATE_LAST", status: "PENDING", attempts: 0 }));
  return { ...f, child, childJournal: journal };
}
function validRecovery(f) { return exactPreparedEventRecovery(f.child, f.childJournal, f.plan, f.journal, f.binding, f.expected, f.key, 1000); }

test("prepared recovery handoff accepts only exact direct current-binding child; never OPEN_NEW admission", () => {
  const f = recoveryFixture();
  assert.equal(validRecovery(f), true);
  assert.equal(untouchedEventDraft(f.child, f.childJournal), false);
  assert.equal(fixedStartedEvent(f.child, f.childJournal, f.binding, f.expected, f.key), false);
});

test("prepared recovery handoff rejects scope, pins, lineage, expiry and changed capture", () => {
  for (const [field, value] of [["principal_id","foreign"],["project","foreign"],["lane","META"],
    ["runtime_logical_key","foreign"],["runtime_id","foreign"],["runtime_generation","foreign"],
    ["governing_spec_version","other"],["governing_schema_version","other"],["governing_control_version","other"],
    ["binding_id","old-binding"],["parent_plan_id","wrong"],["recovers_plan_id","wrong"],["run_ref","wrong"],
    ["plan_kind","INSTALL"],["run_mode","OPEN_NEW"],["plan_origin","INTENT"],["plan_state","EXPIRED"],
    ["expires_at",new Date(999)],["expires_at",new Date(NaN)],["plan_id","old"]]) {
    const f = recoveryFixture(); f.child[field] = value; assert.equal(validRecovery(f), false, field);
  }
  const f = recoveryFixture(); f.child.operations[0].expected_values["Event ID"] = "other";
  assert.equal(validRecovery(f), false);
});

test("prepared recovery handoff rejects touched or non-bijective journal and wrong RESUME_RUN", () => {
  for (const [field, value] of [["status","SENT"],["attempts",1],["sent_at",new Date()],
    ["created_id","page"],["payload_hash","hash"],["stamped_now","now"],["last_error","fail"],
    ["plan_id","wrong"],["phase","STATE_LAST"],["ordinal",99],["target_ref","wrong"]]) {
    const f = recoveryFixture(); f.childJournal[0][field] = value; assert.equal(validRecovery(f), false, field);
  }
  for (const [field, value] of [["symbol","OPEN_RUN"],["purpose","OPEN_RUN"],["operation","CREATE"],["target_ref","wrong"]]) {
    const f = recoveryFixture(); f.child.stage1_writes[0][field] = value;
    Object.assign(f.childJournal[0], f.child.stage1_writes[0]);
    assert.equal(validRecovery(f), false, field);
  }
  const f = recoveryFixture(); f.childJournal.pop(); assert.equal(validRecovery(f), false);
  const dup = recoveryFixture(); dup.childJournal[10] = dup.childJournal[0]; assert.equal(validRecovery(dup), false);
  const parent = recoveryFixture(); parent.journal[1].status = "SENT"; assert.equal(validRecovery(parent), false);
});

function partialFixture() {
  const f = recoveryFixture();
  f.plan.expires_at = new Date(500);
  f.child.binding_id = "expired-child-binding"; f.child.expires_at = new Date(700);
  const symbols = ["RESUME_RUN", "LEDGER_0", "TARGET_0", "LEDGER_0_WRITTEN", "LEDGER_1", "TARGET_1", "LEDGER_1_WRITTEN"];
  f.child.stage1_writes.forEach((w, i) => { w.symbol = f.childJournal[i].symbol = symbols[i]; });
  Object.assign(f.child.stage1_writes[0], { fields: { Status: "RUNNING", "Attempt Count": 2, "Next Action": "old action" },
    property_types: { Status: "select", "Attempt Count": "number", "Next Action": "rich_text" } });
  Object.assign(f.child.stage1_writes[5], { fields: { ...f.plan.operations[1].expected_values }, purpose: "WRITE_TARGET",
    property_types: Object.fromEntries(Object.keys(f.plan.operations[1].expected_values).map((k) => [k, "rich_text"])) });
  Object.assign(f.child.stage1_writes[6], { operation: "UPDATE", fields: { Status: "WRITTEN", "Target Ref": "$created:TARGET_1" }, purpose: "LEDGER_WRITTEN", property_types: { Status: "select", "Target Ref": "rich_text" } });
  f.childJournal = [...f.child.stage1_writes, ...f.child.finalization_writes, f.child.state_last_write].map((w, i) => ({
    ...w, plan_id: f.child.plan_id, phase: i < 7 ? "STAGE1" : i < 10 ? "FINALIZATION" : "STATE_LAST",
    status: i < 5 ? "DONE" : "PENDING", attempts: i < 5 ? 1 : 0,
    ...(i < 5 ? { sent_at: new Date(600), done_at: new Date(650), stamped_now: new Date(600), payload_hash: `hash${i}`,
      ...([1,2,4].includes(i) ? { created_id: `actual${i}` } : {}) } : {}) }));
  const pins = { root_id: f.plan.plan_id, child_id: f.child.plan_id, run_ref: "actual-run", ledger1_ref: "actual4", completed: [],
    root_sha: immutablePlanHash(f.plan), root_journal_sha: checkpointHash(f.journal), child_sha: immutablePlanHash(f.child), child_journal_sha: checkpointHash(f.childJournal) };
  const next = structuredClone({ ...f.child, plan_id: "next", binding_id: f.binding.binding_id, expires_at: new Date(2000),
    stage1_writes: [
      { ...f.child.stage1_writes[0], fields: { Status: "RUNNING", "Attempt Count": 3,
        "Next Action": "recovery attempt 3: execute the recovery stage-1 actions (replay of operation(s) 1 permitted by the governing contract), then os_verify(TARGET)" } },
      { ...f.child.stage1_writes[5], ordinal: 1 }, { ...f.child.stage1_writes[6], ordinal: 2, target_ref: pins.ledger1_ref },
    ] });
  const nextJournal = [...next.stage1_writes.map((w) => ({ ...w, phase: "STAGE1" })),
    ...next.finalization_writes.map((w) => ({ ...w, phase: "FINALIZATION" })), { ...next.state_last_write, phase: "STATE_LAST" }]
    .map((w) => ({ ...w, plan_id: next.plan_id, status: "PENDING", attempts: 0 }));
  return { ...f, pins, next, nextJournal };
}
function admittedPartial(f, entries = [{ p: f.plan, journal: f.journal }, { p: f.child, journal: f.childJournal }], lease) {
  return exactPartialEventCheckpoint(entries, f.binding, f.expected, f.key, 1000, lease, f.pins);
}
function handoffPartial(f) { return exactPreparedPartialRecovery(f.next, f.nextJournal, f.plan, f.child, f.binding, 1000, f.pins); }

test("partial checkpoint is separate from original OPEN_RUN-only and binds entire immutable manifest/journal", () => {
  const f = partialFixture();
  assert.equal(admittedPartial(f), true);
  assert.equal(fixedStartedEvent(f.child, f.childJournal, f.binding, f.expected, f.key), false);
  assert.equal(fixedStartedEvent(f.plan, f.journal, f.binding, f.expected, f.key), true);
  assert.equal(handoffPartial(f), true);
  assert.equal(exactPreparedEventRecovery(f.next, f.nextJournal, f.plan, f.journal, f.binding, f.expected, f.key, 1000), false, "7 rows must not relax old 11-row validator");
});

test("partial checkpoint rejects all changed scope/pins/manifest/capture/linkage/created IDs/timestamps", () => {
  for (const field of ["principal_id", "project", "lane", "runtime_logical_key", "runtime_id", "runtime_generation",
    "governing_spec_version", "governing_schema_version", "governing_control_version", "parent_plan_id", "recovers_plan_id", "run_ref", "plan_origin", "plan_kind", "binding_id"]) {
    const f = partialFixture(); f.child[field] = "foreign"; assert.equal(admittedPartial(f), false, field);
  }
  for (const field of ["status", "attempts", "created_id", "sent_at", "done_at", "payload_hash", "stamped_now", "target_ref", "phase", "ordinal", "last_error"]) {
    const f = partialFixture(); f.childJournal[2][field] = "changed"; assert.equal(admittedPartial(f), false, field);
  }
  for (const mutate of [(f) => f.child.operations[1].expected_values.Verified = true,
    (f) => f.child.stage1_writes[5].target_ref = "other", (f) => f.child.finalization_writes[0].fields = { unsafe: true },
    (f) => f.child.state_last_write.target_ref = "other", (f) => f.childJournal[6].status = "SENT",
    (f) => f.childJournal.pop(), (f) => f.childJournal[10] = f.childJournal[0], (f) => f.journal[0].created_id = "foreign-run"]) {
    const f = partialFixture(); mutate(f); assert.equal(admittedPartial(f), false);
  }
});

test("partial checkpoint rejects ambiguous graphs, even superseded started work, active plan/lease and invalid expiry", () => {
  const f = partialFixture();
  assert.equal(admittedPartial(f, [{ p: f.plan, journal: f.journal }]), false);
  const extra = structuredClone({ p: f.child, journal: f.childJournal }); extra.p.plan_id = "other"; extra.p.plan_state = "SUPERSEDED";
  assert.equal(admittedPartial(f, [{ p: f.plan, journal: f.journal }, { p: f.child, journal: f.childJournal }, extra]), false);
  const virgin = structuredClone(extra); virgin.p.plan_state = "AWAITING_STAGE1_WRITES"; virgin.p.expires_at = new Date(2000);
  virgin.journal.forEach((r) => { r.status = "PENDING"; });
  assert.equal(admittedPartial(f, [{ p: f.plan, journal: f.journal }, { p: f.child, journal: f.childJournal }, virgin]), false);
  assert.equal(admittedPartial(f, undefined, { expires_at: new Date(2000) }), false);
  for (const value of [new Date(2000), new Date(NaN), "expired"] ) {
    const changed = partialFixture(); changed.child.expires_at = value; assert.equal(admittedPartial(changed), false);
  }
});

test("partial handoff rejects reused target0, ledger CREATE, extra/touched rows or changed executable fields", () => {
  for (const mutate of [(f) => f.next.stage1_writes.push(f.child.stage1_writes[2]),
    (f) => f.next.stage1_writes[2].operation = "CREATE", (f) => f.next.stage1_writes[2].target_ref = "$created:LEDGER_1",
    (f) => f.next.stage1_writes[0].fields["Attempt Count"] = 2, (f) => f.next.stage1_writes[1].fields.Verified = true,
    (f) => f.next.finalization_writes[0].target_ref = "foreign", (f) => f.next.state_last_write.target_ref = "foreign",
    (f) => f.next.parent_plan_id = f.child.plan_id, (f) => f.next.run_ref = "other", (f) => f.next.binding_id = "old",
    (f) => f.next.expires_at = new Date(900), (f) => f.nextJournal[0].status = "SENT",
    (f) => f.nextJournal[0].attempts = 1, (f) => f.nextJournal.pop(), (f) => f.nextJournal[6] = f.nextJournal[0]]) {
    const f = partialFixture(); mutate(f); assert.equal(handoffPartial(f), false);
  }
});

test("partial mode only accepts the exact closed flag and --check exits before credentials/network", () => {
  const script = fileURLToPath(new URL("./probe-w47-event.mjs", import.meta.url));
  const out = spawnSync(process.execPath, [script, "--recover-partial-burst10", "--check"], { encoding: "utf8", timeout: 5000 });
  assert.equal(out.status, 0, out.stderr); assert.match(out.stdout, /no credential\/network access/);
  for (const args of [["--burst10"], ["--recover-partial-burst10", "--plan", "other"], ["--recover-started", "--burst10"],
    ["--recover-partial-burst10", "--recover-partial-burst10"], ["--check", "--recover-partial-burst10"]]) {
    assert.equal(eventProbeMode(args), undefined);
    const invalid = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 5000 });
    assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /closed modes, no authority arguments/);
  }
});

test("partial probe stops INTERRUPTED/429 even with durable progress; never recreates a client", () => {
  assert.equal(partialProbeStop({ kind: "IN_PROGRESS", reason: "BUDGET" }, []), undefined);
  assert.equal(partialProbeStop({ kind: "INTERRUPTED", writes_done: 1 }, []), "REFUSED_OR_INTERRUPTED");
  assert.equal(partialProbeStop({ kind: "IN_PROGRESS", reason: "TRANSIENT", writes_done: 1 }, []), "REFUSED_OR_INTERRUPTED");
  for (const reply of [{ kind: "PERSISTED" }, { kind: "IN_PROGRESS", reason: "BUDGET" }, { kind: "INTERRUPTED" }])
    assert.equal(partialProbeStop(reply, [{ status: 200 }, { status: 429 }]), "HTTP429");
});

test("canary transport wiring shares one explicit client for both directions and has no automatic recreation", async () => {
  const source = await readFile(new URL("./probe-w47-event.mjs", import.meta.url), "utf8");
  assert.equal((source.match(/new HttpNotionClient\(/g) ?? []).length, 1);
  assert.match(source, /partial \? \{ notion: activeNotion, notionWriter: activeNotion \}/);
  assert.match(source, /ratePerSecond: 2\.8, burst, shared429Cooldown: true, abortReadsOn429: cutoff/);
  assert.match(source, /const burst = cutoff \? 1 : 10/);
  assert.match(source, /http\.filter\(\(r\) => r\.at > at - 60_000\)\.length < 178/);
  assert.match(source, /no further tool call or client recreation/);
  assert.match(source, /partialProbeStop\(reply, http\)/);
});

function cutoffFixture() {
  const f = finalFixture();
  f.last.plan_state = "TARGET_VERIFIED"; f.last.expires_at = new Date(900);
  for (let i = 0; i < 4; i++) Object.assign(f.lastJournal[i], { status: i === 3 ? "SENT" : "DONE", attempts: 1,
    sent_at: new Date(810), ...(i < 3 ? { done_at: new Date(850) } : {}), payload_hash: `cutoff${i}`, stamped_now: new Date(810) });
  Object.assign(f.pins, { cutoff_child_id: f.last.plan_id, cutoff_child_sha: immutablePlanHash(f.last), cutoff_child_journal_sha: checkpointHash(f.lastJournal) });
  const successor = structuredClone({ ...f.last, plan_id: "cutoff-successor", plan_state: "AWAITING_STAGE1_WRITES", expires_at: new Date(2000),
    stage1_writes: [{ ...f.last.stage1_writes[0], fields: { Status: "RUNNING", "Attempt Count": 5,
      "Next Action": "recovery attempt 5: execute RESUME_RUN, then os_verify(TARGET), then the finalization actions it returns, state-last LAST, then os_verify(FINAL)" } }] });
  const successorJournal = [...successor.stage1_writes.map((w) => ({ ...w, phase: "STAGE1" })),
    ...successor.finalization_writes.map((w) => ({ ...w, phase: "FINALIZATION" })), { ...successor.state_last_write, phase: "STATE_LAST" }]
    .map((w) => ({ ...w, plan_id: successor.plan_id, status: "PENDING", attempts: 0 }));
  return { ...f, successor, successorJournal };
}
function cutoffEntries(f) { return [{ p: f.plan, journal: f.journal }, { p: f.child, journal: f.childJournal },
  { p: f.next, journal: f.nextJournal }, { p: f.last, journal: f.lastJournal }]; }
function admittedCutoff(f, extra = [], lease) { return exactCutoffEventCheckpoint([...cutoffEntries(f), ...extra], f.binding, f.expected, f.key, 1000, lease, f.pins); }
function handoffCutoff(f) { return exactPreparedCutoffRecovery(f.successor, f.successorJournal, f.plan, f.last, f.binding, 1000, f.pins); }

test("cutoff checkpoint pins four journals including SENT UPDATE, never relaxes old admissions", () => {
  const f = cutoffFixture(); assert.equal(admittedCutoff(f), true);
  assert.equal(exactFinalEventCheckpoint(cutoffEntries(f), f.binding, f.expected, f.key, 1000, undefined, f.pins), false);
  assert.equal(exactPartialEventCheckpoint(cutoffEntries(f), f.binding, f.expected, f.key, 1000, undefined, f.pins), false);
  assert.equal(admittedCutoff(f, [], { expires_at: new Date(1100) }), false);
  assert.equal(admittedCutoff(f, [{ p: { ...f.last, plan_id: "unknown", plan_state: "SUPERSEDED" }, journal: f.lastJournal }]), false);
  for (const mutate of [(x) => x.last.expires_at = new Date(1100), (x) => x.last.expires_at = new Date(NaN),
    (x) => x.last.parent_plan_id = x.next.plan_id, (x) => x.last.principal_id = "foreign",
    (x) => x.lastJournal[3].status = "DONE", (x) => x.lastJournal[3].attempts = 0,
    (x) => x.lastJournal[3].sent_at = new Date(811), (x) => x.lastJournal[3].last_error = "unknown",
    (x) => x.lastJournal[4].status = "SENT", (x) => x.nextJournal[0].attempts = 2]) {
    const changed = cutoffFixture(); mutate(changed); assert.equal(admittedCutoff(changed), false);
  }
});

test("cutoff successor is five pristine UPDATEs matching public FINALIZATION derivation, not SENT replay", async () => {
  const { deriveRecoveryWrites } = await import("./src/recovery/engine.ts");
  const { SALES_CONTROL_PLANE_0513_CANDIDATE: g } = await import("./src/versions/adapters/controlPlane.ts");
  const f = cutoffFixture();
  const assessment = { kind: "RECOVERABLE", phase: "FINALIZATION", run_ref: f.pins.run_ref, run_status: "RUNNING", attempt_count: 4,
    ops: [{ ordinal: 0, kind: "EXPECTED", page_ref: "interaction" }, { ordinal: 1, kind: "EXPECTED", page_ref: "receipt" }],
    ledger: {}, replay: [], journal_repair: [], adopted: [],
    next_safe_action: "execute RESUME_RUN, then os_verify(TARGET), then the finalization actions it returns, state-last LAST, then os_verify(FINAL)" };
  f.successor.stage1_writes = deriveRecoveryWrites(g, f.plan, assessment, { link: f.plan.plan_id, ledger_ds: "unused",
    run_schema: new Map(Object.entries(f.last.stage1_writes[0].property_types)), ledger_schema: new Map(), target_schemas: new Map() });
  assert.equal(handoffCutoff(f), true);
  for (const mutate of [(x) => x.successor.stage1_writes[0].fields["Attempt Count"] = 4,
    (x) => x.successor.stage1_writes[0].operation = "CREATE", (x) => x.successor.stage1_writes.push(x.child.stage1_writes[1]),
    (x) => x.successor.plan_id = x.next.plan_id, (x) => x.successor.binding_id = "stale",
    (x) => x.successor.parent_plan_id = x.last.plan_id, (x) => x.successor.state_last_write.target_ref = "foreign",
    (x) => x.successorJournal[0].status = "SENT", (x) => x.successorJournal[0].attempts = 1,
    (x) => x.successorJournal.pop(), (x) => x.last.stage1_writes[0].target_ref = "foreign"] ) {
    const changed = cutoffFixture(); mutate(changed); assert.equal(handoffCutoff(changed), false);
  }
});

test("cutoff mode is closed, offline and enables conservative burst1 with first429 fail-fast only", async () => {
  assert.deepEqual(eventProbeMode(["--recover-cutoff"]), { mode: "RECOVER_CUTOFF", check: false });
  assert.deepEqual(eventProbeMode(["--recover-cutoff", "--check"]), { mode: "RECOVER_CUTOFF", check: true });
  const script = fileURLToPath(new URL("./probe-w47-event.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--recover-cutoff", "--check"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /no credential\/network access/);
  for (const args of [["--check", "--recover-cutoff"], ["--recover-cutoff", "--plan", "unknown"],
    ["--recover-cutoff", "--burst10"], ["--recover-cutoff", "--recover-cutoff"]]) assert.equal(eventProbeMode(args), undefined);
  const source = await readFile(new URL("./probe-w47-event.mjs", import.meta.url), "utf8");
  assert.match(source, /n <= \(cutoff \? 8 : 6\)/);
  assert.match(source, /cutoff \? exactCutoffEventCheckpoint/);
  assert.match(source, /cutoff \? exactPreparedCutoffRecovery/);
});

test("cutoff loop refuses initial progress/PERSISTED without pristine handoff and any successor switch", async () => {
  const before = { active: [], plans: 18, writes: 14, receipts: 2 }, after = { ...before, active: ["new"], plans: 19 };
  const reply = { kind: "IN_PROGRESS", reason: "BUDGET", phase: "STAGE1", writes_done: 0, plan_id: "new" };
  assert.equal(cutoffContinuation(1, reply, before, after, true), "HANDOFF");
  assert.equal(cutoffContinuation(1, reply, before, after, false), "STOP");
  assert.equal(cutoffContinuation(1, reply, before, { ...after, writes: 15 }, true), "STOP");
  assert.equal(cutoffContinuation(1, { ...reply, kind: "PERSISTED" }, before, after, true), "STOP");
  assert.equal(cutoffContinuation(2, reply, before, after, false, "new"), "CONTINUE");
  assert.equal(cutoffContinuation(2, { ...reply, plan_id: "other", kind: "PERSISTED" }, before, after, true, "new"), "STOP");
  assert.equal(cutoffContinuation(2, reply, before, after, true), "STOP");
  const source = await readFile(new URL("./probe-w47-event.mjs", import.meta.url), "utf8");
  const loop = source.slice(source.indexOf("let successorId;"));
  assert.ok(loop.indexOf("cutoffContinuation(n, reply") < loop.indexOf('if (reply.kind === "PERSISTED")'));
  assert.ok(loop.indexOf("cutoffContinuation(n, reply") < loop.indexOf("after.writes > before.writes"));
});

test("remaining three stage1 writes match actual recovery derivation, without CREATE target0/ledger", async () => {
  const { deriveRecoveryWrites } = await import("./src/recovery/engine.ts");
  const { SALES_CONTROL_PLANE_0513_CANDIDATE: g } = await import("./src/versions/adapters/controlPlane.ts");
  const f = partialFixture();
  const target = f.child.stage1_writes[5];
  target.target_ref = f.plan.operations[1].target_data_source_ref;
  const assessment = { kind: "RECOVERABLE", phase: "STAGE1", run_ref: f.pins.run_ref, run_status: "RUNNING", attempt_count: 2,
    ops: [{ ordinal: 0, kind: "EXPECTED", page_ref: "actual2" }, { ordinal: 1, kind: "MISSING" }],
    ledger: { [f.plan.operations[0].idempotency_key]: { ref: "actual1", status: "WRITTEN", run_ref: f.pins.run_ref, target_ref: "actual2" },
      [f.plan.operations[1].idempotency_key]: { ref: f.pins.ledger1_ref, status: "PREPARED", run_ref: f.pins.run_ref, target_ref: "NONE" } },
    replay: [1], journal_repair: [], adopted: [], next_safe_action: "execute the recovery stage-1 actions (replay of operation(s) 1 permitted by the governing contract), then os_verify(TARGET)" };
  const derived = deriveRecoveryWrites(g, f.plan, assessment, { link: f.plan.plan_id, ledger_ds: "unused",
    run_schema: new Map(Object.entries(f.child.stage1_writes[0].property_types)),
    ledger_schema: new Map(Object.entries(f.child.stage1_writes[6].property_types)),
    target_schemas: new Map([[target.target_ref, new Map(Object.entries(target.property_types))]]) });
  f.next.stage1_writes = derived;
  // Fixture target expected values must be schema-declared, just like the real pinned target.
  assert.deepEqual(derived.map((w) => [w.symbol, w.operation, w.target_ref]), [
    ["RESUME_RUN", "UPDATE", f.pins.run_ref], ["TARGET_1", "CREATE", target.target_ref], ["LEDGER_1_WRITTEN", "UPDATE", f.pins.ledger1_ref],
  ]);
  // Only note prose differs. Refresh pins solely for this offline fixture's corrected physical target.
  f.pins.child_sha = immutablePlanHash(f.child);
  const manifest = [...derived.map((w) => ({ ...w, phase: "STAGE1" })), ...f.next.finalization_writes.map((w) => ({ ...w, phase: "FINALIZATION" })), { ...f.next.state_last_write, phase: "STATE_LAST" }];
  f.nextJournal = manifest.map((w) => ({ ...w, plan_id: f.next.plan_id, status: "PENDING", attempts: 0 }));
  assert.equal(handoffPartial(f), true);
});

function finalFixture() {
  const f = partialFixture();
  f.next.plan_state = "TARGET_VERIFIED"; f.next.expires_at = new Date(800);
  f.nextJournal.forEach((r, i) => { if (i < 5) Object.assign(r, { status: "DONE", attempts: 1,
    sent_at: new Date(720), done_at: new Date(750), payload_hash: `final-hash${i}`, stamped_now: new Date(720) }); });
  Object.assign(f.pins, { final_child_id: f.next.plan_id, final_child_sha: immutablePlanHash(f.next), final_child_journal_sha: checkpointHash(f.nextJournal) });
  const last = structuredClone({ ...f.next, plan_id: "last", plan_state: "AWAITING_STAGE1_WRITES", expires_at: new Date(2000),
    stage1_writes: [{ ...f.next.stage1_writes[0], fields: { Status: "RUNNING", "Attempt Count": 4,
      "Next Action": "recovery attempt 4: execute RESUME_RUN, then os_verify(TARGET), then the finalization actions it returns, state-last LAST, then os_verify(FINAL)" } }] });
  const lastJournal = [...last.stage1_writes.map((w) => ({ ...w, phase: "STAGE1" })),
    ...last.finalization_writes.map((w) => ({ ...w, phase: "FINALIZATION" })), { ...last.state_last_write, phase: "STATE_LAST" }]
    .map((w) => ({ ...w, plan_id: last.plan_id, status: "PENDING", attempts: 0 }));
  return { ...f, last, lastJournal };
}
function admittedFinal(f, extra = [], lease) {
  return exactFinalEventCheckpoint([{ p: f.plan, journal: f.journal }, { p: f.child, journal: f.childJournal },
    { p: f.next, journal: f.nextJournal }, ...extra], f.binding, f.expected, f.key, 1000, lease, f.pins);
}
function handoffFinal(f) { return exactPreparedFinalRecovery(f.last, f.lastJournal, f.plan, f.next, f.binding, 1000, f.pins); }

test("final-tail checkpoint pins all three started plans; old two-plan admission stays closed", () => {
  const f = finalFixture(); assert.equal(admittedFinal(f), true); assert.equal(handoffFinal(f), true);
  assert.equal(admittedPartial(f, [{ p: f.plan, journal: f.journal }, { p: f.child, journal: f.childJournal }, { p: f.next, journal: f.nextJournal }]), false);
  assert.equal(admittedFinal(f, [], { expires_at: new Date(1100) }), false);
  assert.equal(admittedFinal(f, [{ p: { ...f.next, plan_id: "foreign", plan_state: "SUPERSEDED" }, journal: f.nextJournal }]), false);
  for (const mutate of [(x) => x.next.expires_at = new Date(1100), (x) => x.next.expires_at = new Date(NaN),
    (x) => x.next.plan_state = "FINAL_VERIFIED", (x) => x.next.parent_plan_id = x.child.plan_id,
    (x) => x.next.operations[0].expected_values.Provider = "foreign", (x) => x.nextJournal[1].created_id = "foreign",
    (x) => x.nextJournal[5].status = "SENT", (x) => x.childJournal[0].attempts = 2]) {
    const changed = finalFixture(); mutate(changed); assert.equal(admittedFinal(changed), false);
  }
});

test("final-tail five-row handoff rejects replay CREATE, stale bindings, mutations and touched rows", () => {
  for (const mutate of [(x) => x.last.stage1_writes.push(x.next.stage1_writes[1]),
    (x) => x.last.stage1_writes[0].operation = "CREATE", (x) => x.last.stage1_writes[0].fields["Attempt Count"] = 3,
    (x) => x.last.run_ref = "foreign", (x) => x.last.binding_id = "stale", (x) => x.last.parent_plan_id = x.next.plan_id,
    (x) => x.last.state_last_write.target_ref = "foreign", (x) => x.last.finalization_writes[0].target_ref = "foreign",
    (x) => x.lastJournal[0].status = "SENT", (x) => x.lastJournal[0].attempts = 1,
    (x) => x.lastJournal.pop(), (x) => x.lastJournal[4] = x.lastJournal[0]]) {
    const f = finalFixture(); mutate(f); assert.equal(handoffFinal(f), false);
  }
});

test("final-tail mode is closed and offline; sole stage1 matches real recovery derivation", async () => {
  const script = fileURLToPath(new URL("./probe-w47-event.mjs", import.meta.url));
  const check = spawnSync(process.execPath, [script, "--recover-final-burst10", "--check"], { encoding: "utf8", timeout: 5000 });
  assert.equal(check.status, 0, check.stderr); assert.match(check.stdout, /no credential\/network access/);
  for (const args of [["--recover-final-burst10", "--plan", "other"], ["--check", "--recover-final-burst10"], ["--recover-final-burst10", "--recover-started"]])
    assert.equal(eventProbeMode(args), undefined);
  const { deriveRecoveryWrites } = await import("./src/recovery/engine.ts");
  const { SALES_CONTROL_PLANE_0513_CANDIDATE: g } = await import("./src/versions/adapters/controlPlane.ts");
  const f = finalFixture();
  const assessment = { kind: "RECOVERABLE", phase: "FINALIZATION", run_ref: f.pins.run_ref, run_status: "RUNNING", attempt_count: 3,
    ops: [{ ordinal: 0, kind: "EXPECTED", page_ref: "interaction" }, { ordinal: 1, kind: "EXPECTED", page_ref: "receipt" }],
    ledger: {}, replay: [], journal_repair: [], adopted: [],
    next_safe_action: "execute RESUME_RUN, then os_verify(TARGET), then the finalization actions it returns, state-last LAST, then os_verify(FINAL)" };
  f.last.stage1_writes = deriveRecoveryWrites(g, f.plan, assessment, { link: f.plan.plan_id, ledger_ds: "unused",
    run_schema: new Map(Object.entries(f.next.stage1_writes[0].property_types)), ledger_schema: new Map(), target_schemas: new Map() });
  assert.deepEqual(f.last.stage1_writes.map((w) => [w.symbol, w.operation, w.target_ref]), [["RESUME_RUN", "UPDATE", f.pins.run_ref]]);
  assert.equal(handoffFinal(f), true);
});
