/**
 * PT-UX-004 — the skill ships with the plugin: MCP instructions at initialize, prompt and resource; the candidate server
 * announces the five W3.3 tools. W3.4: what it serves by default is SKILL.candidate.md, never the LIVE six-tool
 * SKILL.md; an explicit HARNESS_SKILL_FILE still overrides it, and a missing file fails closed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../harness/src/index.ts";
import { loadSkill } from "../../harness/src/tools/skill.ts";
import { candidateAppAvailability, candidateResume, COLLABORATOR_VOICE, CANDIDATE_APP_REMINDER, CANDIDATE_INSTALL_SAY, CANDIDATE_UNFINISHED_SAY, withConduct } from "../../harness/src/tools/conduct.ts";
import { APP_REMINDER, withUserSentence } from "../../harness/src/tools/messages.fr.ts";
import { hold } from "../../harness/src/tools/envelope.ts";
import { buildWorld, OWNER } from "../../harness/test/unit/binding-fixtures.ts";

test("PT-UX-004: instructions, prompt and resource carry SKILL.candidate.md verbatim; the candidate server announces exactly five tools", async () => {
  const skill = await readFile(new URL("../SKILL.candidate.md", import.meta.url), "utf8");
  const live = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");
  const w = buildWorld();
  const server = createServer(w.deps, OWNER.principal_id);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "pkg", version: "0" });
  await client.connect(ct);
  try {
    assert.equal(client.getInstructions(), skill, "server instructions = the candidate skill");
    assert.notEqual(client.getInstructions(), live, "the LIVE six-tool canon is never served by default");
    assert.ok(skill.includes("## 2. Voice"));
    assert.ok(skill.includes("native Notion app is not required"));
    assert.ok(skill.includes("If VERTIGO tools are available, use them"));
    assert.ok(!skill.includes("Sélectionnez VERTIGO et Notion"));
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    assert.deepEqual(prompts, ["vertigo_skill"]);
    const p = await client.getPrompt({ name: "vertigo_skill" });
    assert.equal(p.messages[0].content.text, skill);
    const r = await client.readResource({ uri: "vertigo://skill" });
    assert.equal(r.contents[0].text, skill);
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"]);
  } finally { await client.close(); await server.close(); }
});

const FIVE = ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"];
test("W7.1: candidate skill preserves only the server-issued handle across ordinary follow-ups", async () => {
  const skill = await readFile(new URL("../SKILL.candidate.md", import.meta.url), "utf8");
  for (const wording of ["On later messages in the same conversation", "reuse that opaque `binding_handle`", "do not call `os_bind` again", "server-issued capability, not durable state", "invalid, stale, rotated or expired", "Never reconstruct a handle from prose"]) assert.ok(skill.includes(wording), wording);
});
/** What the model reads from a candidate reply: never a retired tool, a native write, or a gate key in `say`. */
function assertCandidateSafe(env, label) {
  const modelFacing = JSON.stringify({ ...env.next, prepare_intent: undefined }) + JSON.stringify([env.say ?? "", env.ask ?? ""]);
  assert.ok(!/\bos_(?:prepare|verify)\b/.test(modelFacing), `${label}: a retired tool is instructed: ${modelFacing}`);
  assert.equal(env.next.native_actions_required, undefined, `${label}: native writes required`);
  assert.ok(!/stage1_actions|finalization_actions|state_last_action|create_pages|update_page|native Notion/i.test(env.next.conduct ?? ""), `${label}: native Notion writes instructed`);
  assert.ok(typeof env.next.conduct === "string" && env.next.conduct.length > 0, `${label}: no conduct`);
  if (env.next.permitted_tool_call !== undefined) assert.ok(FIVE.includes(env.next.permitted_tool_call), `${label}: permitted ${env.next.permitted_tool_call}`);
  if (env.next.permitted_tool_call === "os_commit") assert.ok(env.next.prepare_intent !== undefined, `${label}: os_commit advised without a served intent`);
  const gateKey = env.result?.gate?.gate_key;
  if (typeof gateKey === "string" && gateKey.trim()) assert.ok(!(env.say ?? "").includes(gateKey.trim()), `${label}: say exposes the gate key`);
}

test("PT-UX-004/c (W3.4): real MCP os_bind → os_resume serves only the five-tool continuation, never a gate key", async () => {
  const w = buildWorld();
  const server = createServer(w.deps, OWNER.principal_id);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "pkg", version: "0" });
  await client.connect(ct);
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    return { text: res.content[0].text, env: JSON.parse(res.content[0].text) };
  };
  try {
    const bound = (await call("os_bind", { lane: "SALES" })).env;
    assert.equal(bound.code, "BOUND", JSON.stringify(bound));
    assert.ok(bound.next.conduct.includes(COLLABORATOR_VOICE), "fresh voice is served on the actual MCP reply, not the cached skill");
    assert.match(bound.next.conduct, /Stay silent/);
    assert.match(bound.next.conduct, /not os_control_status/);
    const { text, env } = await call("os_resume", { binding_handle: bound.result.binding_handle });
    // Default SALES fixture: the step asks its question but the backend serves no intent, so no os_commit is invented.
    assert.equal(env.status, "OK", text);
    assert.equal(env.code, "RESUMED", text);
    assert.ok(env.say.startsWith("Je reprends votre espace là où vous l'avez laissé."));
    assert.ok(env.next.conduct.includes(COLLABORATOR_VOICE));
    assert.ok(typeof env.ask === "string" && env.ask.trim().length > 0, `the fixture asks the step question: ${text}`);
    assert.ok(env.say.endsWith(CANDIDATE_APP_REMINDER), "the real MCP question requires only VERTIGO");
    assert.ok(!env.say.includes(APP_REMINDER), "no inherited Notion app requirement");
    assert.equal(env.next.prepare_intent, undefined, `the fixture serves no intent: ${text}`);
    assert.notEqual(env.next.permitted_tool_call, "os_commit", text);
    assert.match(env.next.conduct, /never build one yourself, never call os_commit for it/);
    assertCandidateSafe(env, "pending without intent");
    assert.ok(!/\bos_(?:prepare|verify)\b/.test(env.say ?? ""), "say names a retired tool");

    // Unsafe branch: a handle this server never issued. Whatever it holds, the reply claims nothing and advises no retired tool.
    const h = bound.result.binding_handle;
    const forged = h.slice(0, -1) + (h.endsWith("A") ? "B" : "A");
    const bogus = (await call("os_resume", { binding_handle: forged })).env;
    assert.notEqual(bogus.status, "OK");
    assert.equal(bogus.next.permitted_tool_call === "os_commit", false, "a refused resume never advises os_commit");
    assertCandidateSafe(bogus, "bogus handle");
    assert.ok(bogus.next.conduct.includes(COLLABORATOR_VOICE), "refusals also carry the fresh presentation rule");
  } finally { await client.close(); await server.close(); }
});

test("PT-UX-004/h (W3.6): candidate app availability changes only voice, never the LIVE envelope or transaction data", () => {
  const live = withConduct("os_bind", withUserSentence("os_bind", hold("HOLD_LANE_REQUIRED", "choose a lane", [], {
    observations: { choices: ["META", "SALES"] },
  })));
  const before = JSON.stringify(live);
  assert.ok(live.say.endsWith(APP_REMINDER));
  assert.match(live.next.conduct, /VERTIGO and Notion selected/);
  const candidate = candidateAppAvailability(live);
  assert.ok(candidate.say.endsWith(CANDIDATE_APP_REMINDER));
  assert.doesNotMatch(candidate.next.conduct, /VERTIGO and Notion selected/);
  assert.equal(candidate.ask, live.ask);
  assert.deepEqual(candidate.observations, live.observations);
  assert.deepEqual(candidate.evidence, live.evidence);
  assert.equal(candidate.code, live.code);
  assert.deepEqual({ ...candidate.next, conduct: undefined }, { ...live.next, conduct: undefined });
  assert.equal(JSON.stringify(live), before, "the historical envelope is not mutated");
  assert.deepEqual(candidateAppAvailability(candidate), candidate, "adaptation is idempotent");
  const clean = { ...live, say: "C'est enregistré et vérifié dans Notion.", next: { ...live.next, conduct: "Read the declared Notion pointer, read-only." } };
  assert.deepEqual(candidateAppAvailability(clean), clean, "Notion as durable truth and explicit reads stay untouched");
});

test("PT-UX-004/d (W3.4): six-tool recovery/install/own-plan branches fail closed in the candidate reply", () => {
  const base = { binding: "UNKNOWN", evidence: [], observations: {}, warnings: [] };
  const recovery = candidateResume({ ...base, status: "HOLD", code: "HOLD_RECOVERY_REQUIRED", observations: { open_backend_plan: { plan_id: "plan-old" } }, next: { safe_action: "call os_verify with plan_id plan-old and phase TARGET", permitted_tool_call: "os_verify", conduct: "Call os_verify now" } });
  assertCandidateSafe(recovery, "recovery");
  assert.equal(recovery.say, CANDIDATE_UNFINISHED_SAY);
  assert.equal(recovery.next.permitted_tool_call, undefined);
  assert.ok(!JSON.stringify(recovery.next).includes("plan-old"));
  const install = candidateResume({ ...base, status: "OK", code: "RESUMED", result: { install_only: true, installation: { continuation: { actions: [{ tool: "create_pages" }] } } }, say: "Installation en cours.", next: { safe_action: "continue", permitted_tool_call: "os_prepare", conduct: "legacy" } });
  assertCandidateSafe(install, "install");
  assert.equal(install.say, CANDIDATE_INSTALL_SAY);
  assert.deepEqual(install.result, { install_only: true, installation: { continuation: { actions: [{ tool: "create_pages" }] } } }, "result data is preserved");
  const ownPlan = candidateResume({ ...base, status: "OK", code: "RESUMED", result: { gate: { gate_key: "SALES_G1" }, open_backend_plan: { owned_by_caller: true, same_binding: true, plan_state: "AWAITING_STAGE1_WRITES", plan_id: "p1", stage1_actions: [{}] } }, say: "Reprise faite depuis Notion. Étape en cours : SALES_G1.", ask: "Q ?", next: { safe_action: "x", native_actions_required: { app: "notion", count: 1, source_field: "stage1_actions", then_call: "os_verify" } } });
  assertCandidateSafe(ownPlan, "own plan");
  assert.equal(ownPlan.say, CANDIDATE_UNFINISHED_SAY);
  assert.equal(ownPlan.ask, undefined);
  const gateOnly = candidateResume({ ...base, status: "OK", code: "RESUMED", result: { gate: { gate_key: "SALES_G1" } }, say: "Reprise faite depuis Notion. Étape en cours : SALES_G1. Prochaine action : écrire l'offre", next: { safe_action: "x" } });
  assert.equal(gateOnly.say, "Reprise faite depuis Notion. Prochaine action : écrire l'offre");
  assertCandidateSafe(gateOnly, "gate key");
});

test("PT-UX-004/g (W3.4): an old active plan in result/observations/contract_pack exposes no legacy instruction", () => {
  const diag = { owned_by_caller: true, expired: false, expires_at: "2026-01-01T00:00:00.000Z", holds_mutation_lease: true, recovery_possible: true };
  const written = { ...diag, same_binding: false, plan_id: "plan-old", plan_state: "AWAITING_FINAL_VERIFY", next_safe_action: "continue that plan: execute its finalization writes, then call os_verify with phase=FINAL" };
  const stage1 = { ...diag, same_binding: false, recovery_possible: false, plan_id: "plan-old", plan_state: "AWAITING_STAGE1_WRITES", next_safe_action: "execute the stage1_actions served here with the native Notion app, in order, then call os_verify with phase=TARGET", stage1_actions: [{ tool: "create_pages" }], finalization_actions: [{ tool: "update_page" }] };
  const input = {
    binding: "UNKNOWN", evidence: [], warnings: [], status: "OK", code: "RESUMED",
    observations: { open_backend_plan: stage1, contract_pack: { open_backend_plan: written } },
    result: { gate: { gate_key: "SALES_G1" }, open_backend_plan: written, contract_pack: { completeness: "COMPLETE", selected_pointers: [], open_backend_plan: stage1, safety: { mode: "HOLD", next_safe_action: "re-prepare the same intent, then call os_verify" } } },
    say: "Reprise faite depuis Notion. Étape en cours : SALES_G1.",
    next: { safe_action: "x" },
  };
  const before = JSON.stringify(input);
  const env = candidateResume(input);
  assert.equal(JSON.stringify(input), before, "the dispatched envelope is not mutated");
  assertCandidateSafe(env, "old plan carried");
  const serialized = JSON.stringify(env);
  assert.ok(!/\bos_(?:prepare|verify)\b|re-prepare|prepare again/i.test(serialized), `a retired tool is instructed: ${serialized}`);
  assert.ok(!/stage1_actions|finalization_actions|native Notion|create_pages|update_page|finalization writes/i.test(serialized), `a native Notion write is instructed: ${serialized}`);
  assert.ok(!serialized.includes("next_safe_action"), `a legacy directive remains: ${serialized}`);
  // Non-action diagnostics survive; no plan is invented.
  const { next_safe_action: _w, ...writtenDiag } = written;
  const { next_safe_action: _s, stage1_actions: _a, finalization_actions: _f, ...stage1Diag } = stage1;
  assert.deepEqual(env.result.open_backend_plan, writtenDiag);
  assert.deepEqual(env.observations.open_backend_plan, stage1Diag);
  assert.deepEqual(env.observations.contract_pack.open_backend_plan, writtenDiag);
  assert.deepEqual(env.result.contract_pack.open_backend_plan, stage1Diag);
  assert.deepEqual(env.result.contract_pack.safety, { mode: "HOLD" });
  assert.equal(env.result.contract_pack.completeness, "COMPLETE");
  assert.deepEqual(env.result.gate, { gate_key: "SALES_G1" });
});

test("PT-UX-004/e (W3.4): a backend-served prepare intent is kept verbatim and only os_commit is advised", () => {
  const intent = { kind: "STEP_ANSWER", gate_key: "SALES_G1", desired_changes: [{ property: "Offre", value: "$answer" }] };
  const env = candidateResume({
    binding: "UNKNOWN", evidence: [], observations: {}, warnings: [],
    status: "OK", code: "RESUMED",
    result: { gate: { gate_key: "SALES_G1" }, pending_step_input: { gate_key: "SALES_G1", field: "Offre" } },
    say: "Reprise faite depuis Notion. Étape en cours : SALES_G1. Quelle est votre offre ?",
    ask: "Quelle est votre offre ?",
    next: { safe_action: "répondre à la question", permitted_tool_call: "os_prepare", prepare_intent: intent, conduct: "legacy" },
  });
  assertCandidateSafe(env, "served intent");
  assert.equal(env.next.permitted_tool_call, "os_commit");
  assert.deepEqual(env.next.prepare_intent, intent, "the served intent passes unchanged");
  assert.match(env.next.conduct, /call os_commit now with this binding_handle and that intent/);
  assert.equal(env.say, "Reprise faite depuis Notion. Quelle est votre offre ?");
  assert.equal(env.ask, "Quelle est votre offre ?");
});

test("PT-UX-004/f (W3.4): certified server-side installation continues; malformed install state fails closed", () => {
  const GATE = "Installation de l'espace";
  const base = { binding: "UNKNOWN", evidence: [], warnings: [], status: "OK", code: "RESUMED" };
  const cont = (over = {}) => ({
    ...base,
    result: { runtime_state: "UNBOUND", install_only: true, gate: { gate_key: GATE, status: "OPEN" }, installation: { phase: "cartographie en cours", business_progression: "bloquée", continues: true, writes_sent: 3, writes_per_call: 5 } },
    observations: { binding_mode: "INSTALL_ONLY" },
    say: `Je relie et vérifie les éléments de votre espace. Étape en cours : ${GATE}.`,
    next: { safe_action: "reprendre l'installation avec le même accès ; le serveur écrit le lot suivant", permitted_tool_call: "os_resume", conduct: "legacy" },
    ...over,
  });
  const rebind = (over = {}) => ({
    ...base,
    result: { runtime_state: "UNBOUND", install_only: true, gate: { gate_key: GATE, status: "OPEN" }, installation: { phase: "reconnexion requise", business_progression: "bloquée", manifest_promoted: true, final_receipt_id: "r1", writes_sent: 1, writes_per_call: 5 } },
    observations: { binding_mode: "STALE", install_phase: "NOT_APPLICABLE" },
    say: `Se reconnecter. Étape en cours : ${GATE}.`,
    next: { safe_action: "se reconnecter puis reprendre", permitted_tool_call: "os_bind", conduct: "legacy" },
    ...over,
  });

  const c = candidateResume(cont());
  assertCandidateSafe(c, "install continue");
  assert.equal(c.next.permitted_tool_call, "os_resume");
  assert.match(c.next.conduct, /call os_resume again now with the same binding_handle/);
  assert.notEqual(c.say, CANDIDATE_INSTALL_SAY);
  assert.ok(!c.say.includes(GATE), "say never names the gate key");

  const b = candidateResume(rebind());
  assertCandidateSafe(b, "install rebind");
  assert.equal(b.next.permitted_tool_call, "os_bind");
  assert.match(b.next.conduct, /call os_bind with no arguments, then os_resume with the fresh handle/);
  assert.notEqual(b.say, CANDIDATE_INSTALL_SAY);

  const c0 = cont();
  const malformed = {
    "continue advising a retired tool": cont({ next: { ...c0.next, permitted_tool_call: "os_prepare" } }),
    "continue on a non-install binding": cont({ observations: { binding_mode: "BOUND" } }),
    "continue with a six-tool continuation": cont({ result: { ...c0.result, installation: { ...c0.result.installation, continuation: { actions: [{ tool: "create_pages" }] } } } }),
    "continue with a served intent": cont({ next: { ...c0.next, prepare_intent: { kind: "INSTALL" } } }),
    "continue and promoted at once": cont({ result: { ...c0.result, installation: { ...c0.result.installation, manifest_promoted: true } } }),
    "installation missing": cont({ result: { ...c0.result, installation: undefined } }),
    "say still names the gate key": cont({ say: `${GATE} en cours.` }),
    "rebind advising resume": rebind({ next: { ...rebind().next, permitted_tool_call: "os_resume" } }),
    "rebind on a live binding": rebind({ observations: { binding_mode: "INSTALL_ONLY" } }),
  };
  for (const [label, env] of Object.entries(malformed)) {
    const out = candidateResume(env);
    assertCandidateSafe(out, label);
    assert.equal(out.say, CANDIDATE_INSTALL_SAY, `${label}: fails closed`);
    assert.equal(out.next.permitted_tool_call, undefined, `${label}: no continuation advised`);
  }
});

test("PT-UX-004/b: an explicit HARNESS_SKILL_FILE is honoured; a missing one fails closed and never yields the six-tool choreography", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pt-ux-004-"));
  try {
    const file = join(dir, "skill.md");
    await writeFile(file, "override skill\n");
    assert.equal(loadSkill({ HARNESS_SKILL_FILE: file }), "override skill\n");
    assert.throws(() => loadSkill({ HARNESS_SKILL_FILE: join(dir, "absent.md") }), /no fallback/);
    await writeFile(join(dir, "empty.md"), "  \n");
    assert.throws(() => loadSkill({ HARNESS_SKILL_FILE: join(dir, "empty.md") }), /no fallback/);
    const byDefault = loadSkill({});
    assert.equal(byDefault, await readFile(new URL("../SKILL.candidate.md", import.meta.url), "utf8"));
    for (const legacy of ["stage1_actions", "finalization_actions", "TRANSACTION_VERIFIED", "os_verify TARGET", "os_prepare(intent)"]) {
      assert.ok(!byDefault.includes(legacy), `the served default carries the retired choreography: ${legacy}`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("PT-UX-004/deploy: candidate compose instructions and deployment fingerprint name the exact served five-tool skill", async () => {
  const compose = await readFile(new URL("../../../deploy/docker-compose.yml", import.meta.url), "utf8");
  const deploy = await readFile(new URL("../../../deploy/deploy.sh", import.meta.url), "utf8");
  const mounted = compose.match(/^\s+HARNESS_SKILL_FILE:\s+\/app\/(\S+)\s*$/m)?.[1];
  assert.ok(mounted, "the explicit container skill path must resolve inside /app");
  const fingerprinted = deploy.match(/printf 'skill=%s\\n' "\$\(digest ([^ )]+)\)"/)?.[1];
  assert.equal(mounted, "packages/plugin/SKILL.candidate.md", "candidate deployment must not override the loader with historical LIVE instructions");
  assert.equal(fingerprinted, mounted, "the configuration attests the same skill bytes it serves");
  const skillFile = new URL(`../../../${mounted}`, import.meta.url);
  const skill = await readFile(skillFile, "utf8");
  const fingerprintBytes = await readFile(new URL(`../../../${fingerprinted}`, import.meta.url));
  const original = process.env.HARNESS_SKILL_FILE;
  let server, client;
  try {
    process.env.HARNESS_SKILL_FILE = fileURLToPath(skillFile);
    server = createServer(buildWorld().deps, OWNER.principal_id);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "candidate-compose-proof", version: "0" });
    await server.connect(st);
    await client.connect(ct);
    assert.equal(client.getInstructions(), skill);
    assert.equal((await client.getPrompt({ name: "vertigo_skill" })).messages[0].content.text, skill);
    assert.equal((await client.readResource({ uri: "vertigo://skill" })).contents[0].text, skill);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ["os_bind", "os_resume", "os_commit", "os_handoff", "os_control_status"]);
    assert.equal(createHash("sha256").update(client.getInstructions()).digest("hex"), createHash("sha256").update(fingerprintBytes).digest("hex"));
  } finally {
    if (original === undefined) delete process.env.HARNESS_SKILL_FILE;
    else process.env.HARNESS_SKILL_FILE = original;
    await client?.close();
    await server?.close();
  }
});
