# VERTIGO OS Plugin V0

> **Par où commencer (agent ou humain qui reprend le chantier) :** lire `docs/START_HERE.md`. Le seul plan
> actif est `docs/plans/PV-WRITE-001.md` ; la cible en construction (PDEC-018 — BUILD TARGET, **NOT ADOPTED** :
> cinq outils, écritures Notion exécutées par le serveur) coexiste avec le produit LIVE décrit ci-dessous — six
> outils, écritures par l'application Notion native — jusqu'à son adoption.

## The product

VERTIGO OS Plugin V0 is one installable product for an ordinary ChatGPT account: it turns a normal chat into a safe
cockpit for **VERTIGO META OS** (the company's management runtime) and for one rep's **Personal SALES OS**, while
Notion stays the durable truth and, for SALES, eligible outbound emails execute automatically through a protected
path. In this program, **"the Harness" names this whole installable plugin**, not only its backend. Its components
(`02 — ARCHITECTURE`, `10 — GMAIL EFFECT PLANE`):

- the **VERTIGO OS skill** (`packages/plugin/SKILL.md`): conversation ritual, tool choreography, capability routing;
- the **read-only harness backend** (`packages/harness`, custom MCP server): identity, binding, runtime resolution,
  transaction planning, TARGET/FINAL readback verification, recovery, version-dispatched CONTROL — exactly six tools
  (`os_bind`, `os_resume`, `os_prepare`, `os_verify`, `os_handoff`, `os_control_status`), zero Notion writes, zero email;
- the user's **native Notion app**: every physical Notion write, exactly as rendered by `os_prepare`;
- the user's **native Gmail**: competent source for mailbox/thread/effect reality, plus approved test/manual branches;
- the **deterministic Mail Executor** (`packages/mail-executor`): the only path for automated / pre-approved production
  sends — no LLM, immutable `intent_ref` + `action_key`, fresh T-0 checks, action-key idempotency, Gmail readback.

**How it is installed and used.** `packages/plugin/docs/INSTALL.md`: connect the six-tool backend as a custom MCP
connector, connect native Notion (and native Gmail for SALES), load the skill, then simply talk. ChatGPT exposes apps
per message, so VERTIGO and Notion are selected on every message that must trigger a tool. The user never supplies
runtime URLs, IDs, Runs, gates, versions or verdicts: `os_bind` infers the lane, `os_resume` rebuilds the current step
from Notion, and every reply carries the sentence the user hears (`say`) and at most one question (`ask`).

**What the user observes.** French sentences only — never codes, ids, JSON or tool names; one progress line per native
write; « C'est enregistré et vérifié dans Notion. » only after `os_verify(FINAL)` returns `TRANSACTION_VERIFIED`;
on any HOLD, the blocker, the observed evidence and the exact human action; a fixture runtime is announced as a test
space; a handoff text with a state fingerprint; a CONTROL status under the governing CONTROL version.

**What it guarantees** (`01 — FINAL PRODUCT DEFINITION`, enforced by the test suites): cold bind/resume without chat
history; unauthorized, cross-user and cross-lane use fails; runtime rotation stales bindings; no completion without
TARGET and FINAL readback; a manually written VERIFIED never passes FINAL; interrupted transactions recover
idempotently or HOLD; one mutating plan per runtime; governing versions resolved, candidates never applied; META and
SALES stay separate authority domains; the backend exposes no Notion write; a verified ExternalActionIntent is never
send authority nor proof of a send; automated production sends pass the executor's T-0 checks or are refused; two chats
or retries cannot send twice; the reasoning model has no bypass of the protected send effect.

**Target experience.** META: the operator answers the current step's question, the plugin persists it through
`os_prepare` → native Notion → `os_verify(TARGET)` → finalization + State LAST → `os_verify(FINAL)`, then asks the next
question (`09 — GOLDEN PATH`). SALES: the rep resumes their runtime, an eligible outbound action becomes a verified
ExternalActionIntent (transaction A), the deterministic Mail Executor re-checks safety at T-0 and sends through Gmail,
Gmail is read back, and the effect is persisted exactly once (transaction B) before any completion claim.

**Project canon is Notion, not this README.** Start at the private build project
(`VERTIGO OS PLUGIN V0 — PRIVATE BUILD PROJECT` → `00 — START HERE`), read `PLUGIN — MANIFEST / CURRENT`,
then the first non-PASS gate and its READY tickets. Never infer project state from chat memory.

## Layout

```
packages/harness/   read-only harness backend (MCP server) — the six tools of the plugin
  src/config/       configuration contract (env parsing; SPEC_ROOT is the only bootstrap pointer)
  src/auth/         principal model + registry (authorization)
  src/binding/      opaque binding handles, binding state machine, runtime generation
  src/resolvers/    META resolver (SPEC_ROOT → locator → root → Manifest) and SALES resolver
  src/versions/     GOVERNING / CHANGE_CANDIDATE / HISTORICAL_PIN classification + adapter registry
  src/plans/        canonical transaction plan store + runtime mutation lease
  src/verify/       verification engine (TARGET / FINAL) + receipts
  src/notion/       READ-ONLY Notion client (allowlisted GET / query endpoints only)
  src/store/        storage interface, in-memory store, PostgreSQL store
  src/contractPack/ Contract Pack CONTRACT_PACK/0.1.0: the tiny explicit read-selection catalog for os_resume
  src/tools/        the six-tool surface and response envelope
  migrations/       PostgreSQL schema for the backend transaction store
  test/arch/        architecture validations PT-ARCH-001 / PT-ARCH-002
  test/unit/        unit tests
  test/fixtures/    fixture data (HARNESS_ENV=fixture)
packages/plugin/    plugin package: manifest + skill (six tools, native Notion for writes)
packages/mail-executor/  deterministic Mail Executor (no LLM): the only path for automated / pre-approved
                    production Gmail sends — immutable intent_ref + action_key input, fresh T-0 checks,
                    action-key lock ledger, protected transport, Gmail readback (PV0-019A, PG9)
docs/               configuration contract and layout notes
```

## Commands

```
pnpm install
pnpm typecheck
pnpm test          # unit + architecture validations
pnpm test:arch     # PT-ARCH-001 (no Notion write client), PT-ARCH-002 (no current-state constants)
pnpm dev           # run the harness MCP server on stdio (needs .env)
```

## Invariants enforced by tests

- The custom harness contains no Notion write path (PT-ARCH-001).
- No current META/SALES runtime state is hardcoded; `VERTIGO_META_SPEC_ROOT` is the sole bootstrap pointer (PT-ARCH-002).
- The tool surface is exactly six tools.

## os_prepare: logical resources and write symbols

`os_prepare` accepts only business intent: a lane-namespaced `logical_resource_key` (`META:<resource>` / `SALES:<resource>`), an operation, a `record_selector` (`natural_key`, `logical_record_key` or `existing_object_id`) and `desired_changes`. Everything else (physical root, runtime, current Run, baseline, compared fields, gate, verified state, plan id, TTL) is backend-derived and rejected as an argument.

- The addressable resources of a governing version live in its adapter grammar (`resources` in `src/versions/adapters/controlPlane.ts`). Control-plane records (Runs, Mutation Ledger, Manifest / OS State, Gates status) are never addressable; the backend derives their writes.
- Targets are discovered by exact database title inside the bound runtime only; an `existing_object_id` that belongs to another data source is `HOLD_CROSS_RUNTIME`.
- Stage-1 writes reference objects created earlier with `$created:<symbol>`; finalization uses `$receipt:TARGET`; `$now` is the writer's timestamp. The state-last write is never part of stage 1.

## Conversational determinism for non-technical users (PV0-020B)

Every envelope carries `say` (the French sentence the model repeats verbatim) and, only when a human answer is
needed, `ask` (the single question). Both come from `packages/harness/src/tools/messages.fr.ts`, a versioned glossary
covering every OK / HOLD / ERROR code with no codes, ids or tool vocabulary. `os_bind` infers project and lane from the
authenticated principal when unambiguous (a rep is never asked); the owner gets `HOLD_LANE_REQUIRED` with one
question. Rendered actions carry a `progress` line. The skill's Voice section forbids any technical exposure.

## os_resume: Contract Pack selective context fanout (candidate)

`os_resume` additionally returns a `contract_pack`: a deterministic READ PLAN telling the model which business
assets to open with the native Notion / Gmail apps before answering. The existing resume result stays the single
safety spine — recovery, HOLDs, versions, unresolved effects, the open backend plan and the exact next safe action
are never filtered, and `packages/harness/src/contractPack/` consumes that already-derived state rather than
reclassifying it.

The optional `topic_hint` carries a comma-separated list of four allowlisted tokens (`CURRENT_WORK`,
`META_SETUP_INPUTS`, `SALES_EXTERNAL_ACTION`, `SALES_EMAIL_RECONCILIATION`) mapping to a three-row constant
catalog. An absent hint or legacy free text normalizes to `CURRENT_WORK` (free text adds a warning, never a HOLD);
an unknown uppercase token keeps `RESUMED` and marks the pack `NEEDS_EXPANSION` without widening; a known token
from the other lane is dropped inside the pack (`completeness=HOLD`, reason `cross_lane_rejected`) while every
safety field stays byte-identical to the same resume without it. `omitted_resource_keys` names the authorized
optional keys **not selected for reading** — it never claims data is absent from the payload.

`state_fingerprint` and `pack_id` are content hashes over the bound runtime generation, the governing versions, the
complete derived safety state, the open backend plan and the effect-reconciliation state. They are observability
identities only: `os_prepare` accepts neither and rehydrates independently. No seventh tool, no new input key, no
feature flag and no persistent expansion state is introduced; `PLUGIN_SPEC` is a release-artifact version and is
never resolved or dispatched at run time. Obeying the pack in the native apps is model-instructional and is proven
by preserved fresh-lane transcripts, not by the backend.

## os_control_status: version-dispatched CONTROL adapters

The governing CONTROL version is re-resolved from `SPEC_ROOT` on every call; candidates are reported in
`candidate_control_versions` and never dispatched. The matching adapter (`packages/harness/src/versions/adapters/control.ts`)
declares how that version is satisfied — `INDEPENDENT_PROOF` (a fresh Control Check mirror written by an
independent verifier is consumed and validated; nothing is fabricated) or `OPERATIONAL_RECOMPUTE` (read-only
recomputation of the CONTROL invariants as an integrity check, never an attestation) — plus its
control-confirmed gate list, required sources and invariant set. A governing version without an adapter
answers `HOLD_UNSUPPORTED_CONTROL_VERSION` with no fallback. A Control Check is `FRESH` only when
`checked_at >= last_required_written_at` (Manifest, Runs, Gate); otherwise `HOLD_CONTROL_STALE`. A missing
check is `HOLD_CONTROL_PROOF_MISSING`; an unreadable required source or a check that omits a required
target is `HOLD_CONTROL_SCOPE_INCOMPLETE`; a listed gate marked PASS without independent confirmation is a
`GATE_PROOF` violation (`HOLD_CONTROL_VIOLATION`). Historical Run pins are reported as observed and never
rewritten. A SALES binding has no governing CONTROL version and answers `HOLD_CONTROL_UNKNOWN`.
