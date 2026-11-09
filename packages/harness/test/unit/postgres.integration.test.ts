/**
 * PostgreSQL store integration (PV0-009). Runs only when HARNESS_TEST_DATABASE_URL is set; otherwise skipped.
 * Applies every migrations/*.sql, then exercises plans, leases (atomic acquire), receipts and audit events.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PostgresBackend } from "../../src/store/postgres.ts";
import { checkTargetReceipt, createPlan, issueFinalReceipt, issueTargetReceipt, transition } from "../../src/plans/service.ts";
import { loadConfig } from "../../src/config/index.ts";
import type { BindingRecord } from "../../src/binding/store.ts";
import { draftFor } from "./plan-fixtures.ts";

const url = process.env["HARNESS_TEST_DATABASE_URL"];

test("PostgreSQL store: migration, plan insert/read, atomic lease, receipts, events", { skip: !url && "HARNESS_TEST_DATABASE_URL not set" }, async () => {
  const backend = new PostgresBackend(url as string);
  let restarted: PostgresBackend | undefined;
  try {
    assert.ok(await backend.ping());
    const migrationSql = await readFile(new URL("../../migrations/001_init.sql", import.meta.url), "utf8");
    // Every migration, in order, exactly as buildLiveDeps applies them (PV-WRITE-001 / W1.5).
    assert.deepEqual(await backend.migrateAll(new URL("../../migrations/", import.meta.url)), ["001_init.sql", "002_server_writes.sql", "003_guard_approval.sql"]);
    await backend.pool.query("truncate transaction_events, receipts, runtime_leases, plan_operations, plans, bindings, principals cascade");
    // Principals come from the file registry, never from a database row: no principals row is inserted here, so
    // every insert below proves the store accepts a registry-only principal (PV0-020 durable-store defect).
    const store = backend.store();
    const config = loadConfig({ VERTIGO_META_SPEC_ROOT: "https://example.invalid/root", HARNESS_ENV: "fixture", PRINCIPALS_FILE: "x" });
    const now = new Date();
    const binding: BindingRecord = { binding_id: "b-it-1", handle_hash: "h".repeat(64), principal_id: "p-it", project: "VERTIGO", lane: "META", runtime_logical_key: "VERTIGO/META", runtime_id: "rt-it", runtime_generation: "gen-it", binding_mode: "BUSINESS", install_phase: "NOT_APPLICABLE", resolved_manifest_ref: "m-it", governing_versions_snapshot: { spec: "s" }, status: "BOUND", created_at: now, expires_at: new Date(now.getTime() + 3600_000) };
    await store.bindings.insert(binding);
    assert.equal((await store.bindings.findByHandleHash(binding.handle_hash))?.binding_id, "b-it-1");

    const draft = draftFor(binding, ["it-1", "it-2"]);
    const guardMutations = [{ logical_resource_key: "BUSINESS_CONFIGURATION", operation: "UPSERT" as const,
      record_selector: { natural_key: "B0_DISCOVERY:PRIMARY_OUTCOME" }, desired_changes: { Value: "synthetic roundtrip only" } }];
    const a = await createPlan(store, config, { ...draft,
      state_last_write: { ...draft.state_last_write, guard_mutations: guardMutations } }, now);
    assert.equal(a.kind, "CREATED");
    const planId = (a as { plan: { plan_id: string } }).plan.plan_id;
    const read = await store.plans.get(planId);
    assert.equal(read?.operations.length, 2);
    assert.equal(read?.stage1_writes.length, 4);
    assert.deepEqual(read?.state_last_write.guard_mutations, guardMutations, "W7.1 original mutation metadata survives JSON persistence");
    assert.equal((await store.plans.findActive("VERTIGO", "META", "gen-it")).length, 1);

    // Atomic lease: a second plan on the same generation is BUSY; a concurrent burst yields exactly one holder.
    const busy = await createPlan(store, config, draftFor(binding, ["other"]), now);
    assert.equal(busy.kind, "BUSY");
    const burst = await Promise.all(["x1", "x2", "x3"].map((k) => store.leases.acquire({ project: "VERTIGO", lane: "META", runtime_generation: "gen-burst" }, k, now, new Date(now.getTime() + 60_000))));
    assert.equal(burst.filter((b) => b.acquired).length, 1);

    const t = await issueTargetReceipt(store, config, (await store.plans.get(planId))!, { checked: true }, now);
    assert.equal((await store.plans.get(planId))?.plan_state, "TARGET_VERIFIED");
    assert.ok((await checkTargetReceipt(store, (await store.plans.get(planId))!, t.receipt_id, now)).ok);
    await issueFinalReceipt(store, (await store.plans.get(planId))!, t, {}, now);
    assert.equal((await store.plans.get(planId))?.plan_state, "FINAL_VERIFIED");
    assert.equal(await store.leases.current({ project: "VERTIGO", lane: "META", runtime_generation: "gen-it" }, now), undefined, "lease released on terminal state");
    assert.deepEqual(await checkTargetReceipt(store, (await store.plans.get(planId))!, t.receipt_id, now), { ok: false, reason: "CONSUMED" });
    const events = await store.events.list({ plan_id: planId });
    for (const type of ["PLAN_CREATED", "PLAN_TARGET_VERIFIED", "TARGET_RECEIPT_ISSUED", "PLAN_FINAL_VERIFIED", "LEASE_RELEASED", "RECEIPT_REPLAY_REJECTED"]) assert.ok(events.some((e) => e.event_type === type), `event ${type}`);
    assert.deepEqual((await store.events.list({ runtime_id: "rt-it", event_type: "PLAN_FINAL_VERIFIED" })).map(e => e.plan_id), [planId], "scoped automatic-hold lookup does not read unrelated event types");
    assert.equal((await store.events.list({ runtime_id: "another-runtime", event_type: "PLAN_FINAL_VERIFIED" })).length, 0);
    assert.deepEqual(await transition(store, planId, "HOLD", now), { ok: false, reason: "INVALID_TRANSITION", from: "FINAL_VERIFIED" });

    // W6.5b: bounded terminal field lookup, UPDATE and journal-resolved CREATE; no history dump.
    const terminal = (await store.plans.get(planId))!;
    const proofPlan = { ...terminal, plan_id: "b7-field-proof", operations: terminal.operations.map((o, ordinal) => ({ ...o,
      operation_id: `b7-proof-${ordinal}`, physical_target_ref: ordinal === 0 ? "b7-existing" : undefined,
      operation: ordinal === 0 ? "UPDATE" as const : "CREATE" as const,
    })) };
    // exactOptionalPropertyTypes: CREATE carries no physical id until its immutable journal says DONE.
    const operations = proofPlan.operations.map(({ physical_target_ref, ...o }) => physical_target_ref ? { ...o, physical_target_ref } : o);
    await store.plans.insert({ ...proofPlan, operations });
    await store.planWrites.ensure(proofPlan.plan_id, [{ symbol: "TARGET_1", ordinal: 1, phase: "STAGE1", operation: "CREATE", target_ref: "$created:TARGET_1" }]);
    await store.planWrites.transition(proofPlan.plan_id, "TARGET_1", "PENDING", "SENT", { at: now, payload_hash: "proof-only-fixture" });
    await store.planWrites.transition(proofPlan.plan_id, "TARGET_1", "SENT", "DONE", { at: now, created_id: "b7-created" });
    const baseFinal = (await store.receipts.findByPlan(planId, "FINAL"))[0]!;
    await store.receipts.insert({ ...baseFinal, plan_id: proofPlan.plan_id, receipt_id: "b7-field-final" });
    const wanted = [{ page_ref: "b7existing", field: "a" }, { page_ref: "b7created", field: "a" }];
    assert.ok(store.receipts.findFinalByFields);
    const found = await store.receipts.findFinalByFields(terminal, wanted);
    assert.deepEqual(found.map(r => r.page_ref).sort(), ["b7created", "b7existing"]);
    assert.ok(found.every(r => r.receipt.receipt_id === "b7-field-final"));
    assert.deepEqual(await store.receipts.findFinalByFields({ ...terminal, principal_id: "foreign" }, wanted), []);
    assert.deepEqual(await store.receipts.findFinalByFields({ ...terminal, governing_spec_version: "old-pin" }, wanted), []);
    assert.deepEqual(await store.receipts.findFinalByFields({ ...terminal, runtime_generation: "another-generation" }, wanted), []);
    assert.deepEqual(await store.receipts.findFinalByFields(terminal, [{ page_ref: "b7existing", field: "unproved" }]), []);
    await store.plans.insert({ ...proofPlan, operations: [{ ...operations[0]!, operation_id: "b7-newer-operation" }], plan_id: "b7-newer-proof" });
    await store.receipts.insert({ ...baseFinal, plan_id: "b7-newer-proof", receipt_id: "b7-newer-final", observed_at: new Date(now.getTime() + 1_000) });
    assert.equal((await store.receipts.findFinalByFields(terminal, wanted)).find(r => r.page_ref === "b7existing")?.receipt.receipt_id, "b7-newer-final");

    /* ── PV-INST: the provisioning columns, their named constraints and receipt uniqueness ── */

    // INSTALL_ONLY / INSTALL_PENDING survive a real round trip through the durable store.
    const installBinding: BindingRecord = { ...binding, binding_id: "b-it-install", handle_hash: "i".repeat(64), lane: "SALES", runtime_logical_key: "VERTIGO/SALES/rep-it", runtime_generation: "gen-install", binding_mode: "INSTALL_ONLY", install_phase: "INSTALL_PENDING" };
    await store.bindings.insert(installBinding);
    const readBinding = await store.bindings.findByHandleHash(installBinding.handle_hash);
    assert.equal(readBinding?.binding_mode, "INSTALL_ONLY");
    assert.equal(readBinding?.install_phase, "INSTALL_PENDING");

    // plan_kind round trips, and an INSTALL_PROMOTION without its bound proof is rejected by a NAMED constraint.
    const mapping = await createPlan(store, config, { ...draftFor(installBinding, ["map-1"]), plan_kind: "INSTALL_MAPPING" }, now);
    assert.equal(mapping.kind, "CREATED");
    const mappingPlan = (mapping as { plan: { plan_id: string } }).plan;
    assert.equal((await store.plans.get(mappingPlan.plan_id))?.plan_kind, "INSTALL_MAPPING");
    const mappingTarget = await issueTargetReceipt(store, config, (await store.plans.get(mappingPlan.plan_id))!, { install_phase: "CANARY_CREATED_AND_FETCHED" }, now);
    const mappingFinal = await issueFinalReceipt(store, (await store.plans.get(mappingPlan.plan_id))!, mappingTarget, { install_phase: "MAPPING_VERIFIED" }, now);

    await assert.rejects(
      backend.pool.query("insert into plans (plan_id, plan_kind, principal_id, binding_id, project, lane, runtime_logical_key, runtime_id, runtime_generation, governing_spec_version, governing_schema_version, governing_control_version, run_mode, execution_attempt_id, baseline_runtime_revision, stage1_writes, finalization_writes, state_last_write, plan_state, created_at, expires_at) values ('p-bad','INSTALL_PROMOTION','p-it','b-it-install','VERTIGO','SALES','k','rt-it','gen-x','s','s','s','OPEN_NEW','a','r','[]','[]','{}','AWAITING_STAGE1_WRITES',now(),now())"),
      /plans_install_promotion_proof_check/,
      "an INSTALL_PROMOTION without its bound mapping proof was accepted",
    );
    await assert.rejects(
      backend.pool.query("insert into plans (plan_id, plan_kind, principal_id, binding_id, project, lane, runtime_logical_key, runtime_id, runtime_generation, governing_spec_version, governing_schema_version, governing_control_version, run_mode, execution_attempt_id, baseline_runtime_revision, stage1_writes, finalization_writes, state_last_write, plan_state, created_at, expires_at, install_mapping_plan_id, install_mapping_final_receipt_id) values ('p-bad2','BUSINESS','p-it','b-it-install','VERTIGO','SALES','k','rt-it','gen-x','s','s','s','OPEN_NEW','a','r','[]','[]','{}','AWAITING_STAGE1_WRITES',now(),now(),$1,$2)", [mappingPlan.plan_id, mappingFinal.receipt_id]),
      /plans_install_mapping_proof_absent_check/,
      "a BUSINESS plan was allowed to carry an install mapping proof",
    );
    await assert.rejects(
      backend.pool.query("insert into plans (plan_id, plan_kind, principal_id, binding_id, project, lane, runtime_logical_key, runtime_id, runtime_generation, governing_spec_version, governing_schema_version, governing_control_version, run_mode, execution_attempt_id, baseline_runtime_revision, stage1_writes, finalization_writes, state_last_write, plan_state, created_at, expires_at, install_mapping_plan_id, install_mapping_final_receipt_id) values ('p-bad3','INSTALL_PROMOTION','p-it','b-it-install','VERTIGO','SALES','k','rt-it','gen-x','s','s','s','OPEN_NEW','a','r','[]','[]','{}','AWAITING_STAGE1_WRITES',now(),now(),'no-such-plan',$1)", [mappingFinal.receipt_id]),
      /plans_install_mapping_plan_fk/,
      "a promotion could reference a mapping plan that does not exist",
    );

    // A promotion carrying its real bound proof is accepted and round trips.
    const promotion = await createPlan(store, config, { ...draftFor({ ...installBinding, runtime_generation: "gen-promo" }, ["promo-1"]), plan_kind: "INSTALL_PROMOTION", install_mapping_plan_id: mappingPlan.plan_id, install_mapping_final_receipt_id: mappingFinal.receipt_id, install_context_fingerprint: "ctx-promo" }, now);
    assert.equal(promotion.kind, "CREATED");
    const promotionRead = await store.plans.get((promotion as { plan: { plan_id: string } }).plan.plan_id);
    assert.equal(promotionRead?.plan_kind, "INSTALL_PROMOTION");
    assert.equal(promotionRead?.install_mapping_plan_id, mappingPlan.plan_id);
    assert.equal(promotionRead?.install_mapping_final_receipt_id, mappingFinal.receipt_id);
    assert.equal(promotionRead?.install_context_fingerprint, "ctx-promo");

    // Enum guards are named CHECK constraints, not application-only conventions.
    await assert.rejects(backend.pool.query("update bindings set binding_mode = 'SUPERUSER' where binding_id = 'b-it-install'"), /bindings_binding_mode_check/);
    await assert.rejects(backend.pool.query("update bindings set install_phase = 'ACTIVATED' where binding_id = 'b-it-install'"), /bindings_install_phase_check/);
    await assert.rejects(backend.pool.query("update plans set plan_kind = 'ANYTHING' where plan_id = $1", [mappingPlan.plan_id]), /plans_plan_kind_check/);

    // Receipt uniqueness: at most ONE VALID receipt per (plan, phase), enforced by the database itself.
    const concurrentPlan = (await createPlan(store, config, draftFor({ ...installBinding, runtime_generation: "gen-race" }, ["race-1"]), now) as { plan: { plan_id: string } }).plan;
    const fresh = (await store.plans.get(concurrentPlan.plan_id))!;
    const raced = await Promise.all(Array.from({ length: 5 }, () => issueTargetReceipt(store, config, fresh, { race: true }, now)));
    assert.equal(new Set(raced.map((r) => r.receipt_id)).size, 1, "PostgreSQL admitted two live TARGET receipts for one plan");
    assert.equal((await store.receipts.findByPlan(concurrentPlan.plan_id, "TARGET")).filter((r) => r.status === "VALID").length, 1);
    await assert.rejects(
      backend.pool.query("insert into receipts (receipt_id, type, plan_id, principal_id, runtime_id, runtime_generation, observed_at, observations, status) values ('r-dup','TARGET',$1,'p-it','rt-it','gen-race',now(),'{}','VALID')", [concurrentPlan.plan_id]),
      /receipts_one_valid_per_plan_phase_uq/,
      "a second VALID TARGET receipt was inserted directly",
    );

    // Upgrade from the historical no-index schema: reconcile duplicate VALID rows before rebuilding the index.
    await backend.pool.query("drop index receipts_one_valid_per_plan_phase_uq");
    await backend.pool.query(
      "insert into receipts (receipt_id, type, plan_id, principal_id, runtime_id, runtime_generation, observed_at, observations, status) values ('r-historical-duplicate','TARGET',$1,'p-it','rt-it','gen-race',$2,'{}','VALID')",
      [concurrentPlan.plan_id, new Date(now.getTime() + 1_000)],
    );
    assert.equal((await store.receipts.findByPlan(concurrentPlan.plan_id, "TARGET")).filter((r) => r.status === "VALID").length, 2, "upgrade fixture did not contain the historical duplicate");
    await backend.migrate(migrationSql);
    const reconciled = await store.receipts.findByPlan(concurrentPlan.plan_id, "TARGET");
    assert.equal(reconciled.filter((r) => r.status === "VALID").length, 1);
    assert.equal(reconciled.find((r) => r.receipt_id === "r-historical-duplicate")?.status, "INVALID", "migration did not deterministically retain the oldest VALID receipt");

    // PostgreSQL crash/restart recovery: the fresh backend process view must close a legacy consumed-TARGET
    // window atomically, without relying on memory held by the issuer process.
    const restartDraft = draftFor({ ...installBinding, runtime_generation: "gen-restart" }, ["restart-1"]);
    const restartPlan = (await createPlan(store, config, restartDraft, now) as { plan: { plan_id: string } }).plan;
    const restartPlanBefore = (await store.plans.get(restartPlan.plan_id))!;
    const restartTarget = await issueTargetReceipt(store, config, restartPlanBefore, { crash: "after-target-consumed" }, now);
    await backend.pool.query("update receipts set status = 'CONSUMED' where receipt_id = $1", [restartTarget.receipt_id]);

    restarted = new PostgresBackend(url as string);
    assert.ok(await restarted.ping());
    const afterRestart = restarted.store();
    assert.deepEqual((await afterRestart.plans.get(planId))?.state_last_write.guard_mutations, guardMutations,
      "W7.1 a fresh backend connection reads the same immutable guard intent");
    const recoveredPlan = (await afterRestart.plans.get(restartPlan.plan_id))!;
    const consumedTarget = (await afterRestart.receipts.get(restartTarget.receipt_id))!;
    const recoveredFinal = await issueFinalReceipt(afterRestart, recoveredPlan, consumedTarget, { recovered_after_restart: true }, new Date(now.getTime() + 2_000));
    assert.equal((await afterRestart.plans.get(restartPlan.plan_id))?.plan_state, "FINAL_VERIFIED");
    assert.equal((await afterRestart.receipts.get(restartTarget.receipt_id))?.status, "CONSUMED");
    assert.equal((await afterRestart.receipts.findByPlan(restartPlan.plan_id, "FINAL")).length, 1);
    assert.equal((await afterRestart.receipts.findByPlan(restartPlan.plan_id, "FINAL"))[0]?.receipt_id, recoveredFinal.receipt_id);
    assert.equal(await afterRestart.leases.current({ project: "VERTIGO", lane: "SALES", runtime_generation: "gen-restart" }, new Date(now.getTime() + 2_000)), undefined);

    // The other old crash window (FINAL inserted first) converges to that incumbent after the restart too.
    const insertedDraft = draftFor({ ...installBinding, runtime_generation: "gen-final-inserted" }, ["inserted-1"]);
    const insertedPlanId = (await createPlan(afterRestart, config, insertedDraft, now) as { plan: { plan_id: string } }).plan.plan_id;
    const insertedPlan = (await afterRestart.plans.get(insertedPlanId))!;
    const insertedTarget = await issueTargetReceipt(afterRestart, config, insertedPlan, { crash: "after-final-insert" }, now);
    const incumbent: import("../../src/verify/engine.ts").ReceiptRecord = {
      receipt_id: "r-final-before-transition", type: "FINAL", plan_id: insertedPlan.plan_id, principal_id: insertedPlan.principal_id,
      runtime_id: insertedPlan.runtime_id, runtime_generation: insertedPlan.runtime_generation, target_receipt_id: insertedTarget.receipt_id,
      observed_at: now, observations: { incumbent: true }, status: "VALID",
    };
    await afterRestart.receipts.insert(incumbent);
    const converged = await issueFinalReceipt(afterRestart, insertedPlan, insertedTarget, { contender: true }, new Date(now.getTime() + 3_000));
    assert.equal(converged.receipt_id, incumbent.receipt_id);
    assert.equal((await afterRestart.plans.get(insertedPlan.plan_id))?.plan_state, "FINAL_VERIFIED");
    assert.equal((await afterRestart.receipts.findByPlan(insertedPlan.plan_id, "FINAL")).length, 1);
    const terminalEvents = await afterRestart.events.list({ plan_id: insertedPlan.plan_id });
    for (const type of ["PLAN_FINAL_VERIFIED", "FINAL_RECEIPT_ISSUED", "LEASE_RELEASED"]) assert.equal(terminalEvents.filter((e) => e.event_type === type).length, 1, `${type} did not converge once after restart`);

    // Distributed activation recovery: the external SALES registry may already carry the exact proof plan id when
    // the process restarts. Both expiry and a competing cold-recovery SUPERSEDED transition must converge under
    // concurrent retries, with either an expired or already-consumed TARGET.
    const committedScenarios = [
      { suffix: "expired", terminal: "EXPIRED" as const, target: "EXPIRED" as const },
      { suffix: "superseded", terminal: "SUPERSEDED" as const, target: "CONSUMED" as const },
    ];
    for (const scenario of committedScenarios) {
      const committedDraft = {
        ...draftFor({ ...installBinding, runtime_generation: `gen-committed-${scenario.suffix}` }, [`committed-${scenario.suffix}`]),
        plan_kind: "INSTALL_PROMOTION" as const,
        install_mapping_plan_id: mappingPlan.plan_id,
        install_mapping_final_receipt_id: mappingFinal.receipt_id,
        install_context_fingerprint: `ctx-committed-${scenario.suffix}`,
      };
      const committedId = (await createPlan(afterRestart, config, committedDraft, now) as { plan: { plan_id: string } }).plan.plan_id;
      const committedPlan = (await afterRestart.plans.get(committedId))!;
      const committedTarget = await issueTargetReceipt(afterRestart, config, committedPlan, { activation_ready: true }, now);
      await afterRestart.receipts.setStatus(committedTarget.receipt_id, scenario.target);
      await transition(afterRestart, committedPlan.plan_id, scenario.terminal, new Date(now.getTime() + config.planTtlMinutes * 60_000 + 1), { external_commit_pending_reconciliation: true });
      const terminalPlan = (await afterRestart.plans.get(committedId))!;
      const terminalTarget = (await afterRestart.receipts.get(committedTarget.receipt_id))!;
      if (scenario.terminal === "SUPERSEDED") {
        await assert.rejects(
          issueFinalReceipt(afterRestart, terminalPlan, terminalTarget, { must_not_commit: true }, new Date(now.getTime() + config.planTtlMinutes * 60_000 + 2), { committed_install_proof_plan_id: "wrong-plan" }),
          /cannot finalize from SUPERSEDED/,
        );
      }
      const reconciledFinals = await Promise.all(Array.from({ length: 5 }, (_, contender) => issueFinalReceipt(
        afterRestart,
        terminalPlan,
        terminalTarget,
        { recovered_committed_activation: true, contender },
        new Date(now.getTime() + config.planTtlMinutes * 60_000 + 2),
        { committed_install_proof_plan_id: committedId },
      )));
      assert.equal(new Set(reconciledFinals.map((r) => r.receipt_id)).size, 1, scenario.suffix);
      assert.equal((await afterRestart.plans.get(committedId))?.plan_state, "FINAL_VERIFIED", scenario.suffix);
      assert.equal((await afterRestart.receipts.get(committedTarget.receipt_id))?.status, "CONSUMED", scenario.suffix);
      assert.equal((await afterRestart.receipts.findByPlan(committedId, "FINAL")).length, 1, scenario.suffix);
    }
  } finally {
    if (restarted) await restarted.close();
    await backend.close();
  }
});
