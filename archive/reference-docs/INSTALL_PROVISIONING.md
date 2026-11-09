# Personal SALES provisioning — the dedicated INSTALL_ONLY path

> **LIVE** — ce document décrit le produit servi aujourd'hui (six outils, écritures Notion par l'application native, harness en lecture seule : PDEC-001/002). La cible en construction (PDEC-018, candidate, non adoptée) est décrite dans `docs/START_HERE.md` et `docs/plans/PV-WRITE-001.md`.

Status: **candidate behavior** (`packages/plugin/candidates/PLUGIN_SPEC-0.4.0.md` §7). The governing package spec
stays `PLUGIN_SPEC/0.3.0`. Adoption happens in Notion, never in this repository.

Release target: `SALES_TEAM_V1_READY`. This is the bounded collaborator-facing Personal SALES package gate, not
`V0_READY`: it proves the Sales install and operating path without claiming that the future META release tranche is
complete. It may be declared only after the remote ordinary-chat acceptance described below passes.

A provisioner duplicates the MASTER/template Personal SALES space and assigns the clone to a rep. The clone is a
real Notion space with the right shape and entirely the wrong contents: it still carries the MASTER's Registry
rows, Notes, another rep's PII, a `Root URL` pointing at the MASTER, a copied `Sales Contract URL` and a copied
`Last Run Ref`. Until it is verified, it is **not** a business runtime, and no amount of editing inside Notion may
make it one.

## The authority model in one line

> Authorization to bootstrap comes from the **backend registry** (`SALES_RUNTIME_REGISTRY_FILE`) and from nothing
> else. Notion is the durable truth about a runtime's *state*; it is never the truth about a runtime's *authority*.

| Backend `status` | Meaning | What `os_bind` does |
| --- | --- | --- |
| `INSTALL_PENDING` | a provisioner assigned a non-template clone to this rep | binds `INSTALL_ONLY` / `INSTALL_PENDING` — the dedicated installer, nothing else |
| `KNOWN` | a business runtime pointer exists | ordinary business bind; an UNBOUND clone here is refused (`HOLD_RUNTIME_TEMPLATE_NOT_INSTANCE`) |
| `NOT_YET_CREATED` | declared nonexistent | `HOLD_RUNTIME_NOT_YET_CREATED` |
| *(no entry)* | existence unknown, **not** proven absent | `HOLD_RUNTIME_NOT_FOUND`, `existence=UNKNOWN` |

`KNOWN` alone never authorizes bootstrap (PT-INST-001/b). A **MASTER/template root is always refused**, including
under `INSTALL_PENDING` (PT-INST-002/a): a provisioning assignment can never target the template itself.
`INSTALL_PENDING` additionally requires a non-template `expected_instance_id`; without it the clone has no
assigned identity and the bind fails closed (PT-INST-002/b).

## What INSTALL_ONLY may and may not do

`binding_mode` and `install_phase` are **persisted** — in the backend registry, on the binding row and in
PostgreSQL (`bindings.binding_mode`, `bindings.install_phase`, both `CHECK`-constrained). They are not inferred
per call, so a partially installed clone cannot drift into business authority between two calls.

- The clone stays `INSTALL_ONLY` through **every** partial Manifest state, including a Manifest a human has
  hand-written to look completely installed (PT-INST-003/a, /b). **No Notion edit may open BUSINESS.**
- `os_prepare`'s business engine, `rehydrate`, recovery, handoff and control adjudication all refuse an
  `INSTALL_ONLY` binding, and no plan, Run or lease is created (PT-INST-004/a).
- The only addressable resources are `SALES:INSTALL_REGISTRY` and `SALES:INSTALL_MANIFEST`, both marked
  `bootstrapOnly`. They vanish from the permitted surface the moment the binding is BUSINESS (PT-INST-004/c).
- Copied Registry metadata, Runs, Ledger, OS State, `Last Run Ref`, PII and the copied `Required` / `Resource
  Type` / `Notes` values are **quarantined**: never dereferenced, never consumed as truth, never echoed into an
  envelope (PT-INST-011, PT-INST-012).
- Connectors (Gmail, mail tracker) are **separate capabilities**, reported as `UNKNOWN`. A structural install
  never claims a connector (PT-INST-012/c).

## The governing adapter owns the shape

`SALES_CONTROL_PLANE_05.installContract` fixes, for every resource: its **exact path** from the assigned root, its
**object kind** (page or database), whether it is required, its **Registry key**, and its **minimum schema**. A
missing, duplicated, wrongly-typed or schema-violating resource blocks the install (PT-INST-014). Every database
must expose exactly one title property and exactly one data source.

The mapping is therefore *derived*, never *read*: the plugin computes what each Registry row must point at, and
refuses any intent that targets something else (PT-INST-013/a). The intent must be the complete contract set —
no key added, dropped, duplicated or pre-resolved (PT-INST-013/b).

## The two plans, and why they are two

```
1  os_bind                     → INSTALL_ONLY / INSTALL_PENDING
2  os_resume                   → the exact contract-derived mapping intent
3  os_prepare (INSTALL_MAPPING)→ Registry rows → HOLD + one plan-bound canary CREATE
4  native Notion writes        → the rendered stage-1 actions, verbatim
5  os_verify TARGET  (fetch 1) → canary read back as MISSING          → issue the EXPECTED update
6  native Notion write         → canary → EXPECTED
7  os_verify TARGET  (fetch 2) → canary read back as EXPECTED         → issue the terminal update
8  native Notion write         → canary → RESOLVED   (terminal phase)
9  os_verify TARGET  (fetch 3) → canary read back as RESOLVED         → TARGET receipt
10 native Notion writes        → every mapped Registry row → RESOLVED
11 os_verify FINAL             → MAPPING_VERIFIED. The Manifest was never touched.
12 os_resume                   → the separate workspace promotion intent
13 os_prepare (INSTALL_PROMOTION) → bound to plan(3) AND to receipt(11)
14 os_verify TARGET            → the mapping is re-proved; OS State finalization + Manifest state-last are rendered
15 native Notion write         → canonical OS State/CURRENT → clean B0 setup baseline
16 native Notion write         → the Manifest SETUP state-last, exactly once and LAST
17 os_verify FINAL             → fresh re-proof of OS State + Manifest, then backend CAS. Generation bumped.
18 os_bind                     → a NEW BUSINESS binding on the new generation; the old handle is STALE
19 os_resume                   → the ordinary business engine, including the REQUIRED capability check
```

Mapping and promotion are **separate plans** because activation must not be reachable from the same proof that
established the structure. Step 11 explicitly does not touch the Manifest (PT-INST-021/d) and does not activate
the backend.

### The terminal canary — a deliberate representation

Two hard constraints from the live product decided this:

1. the live Registry `Status` select only offers `EXPECTED`, `RESOLVED`, `MISSING`, `HOLD`; inventing an
   unversioned option (`INSTALL_PENDING`, `VERIFYING`, `RETIRED`) is forbidden;
2. the native Notion connector **cannot** set `archived: true` through `update_page`, so "delete the canary" is
   not a connector-executable terminal phase.

The terminal phase is therefore an **active, plan-bound row** whose title `Key` is `INSTALL_CANARY:<planId>`,
driven `MISSING → EXPECTED → RESOLVED`, with an independent fetch after each write. This proves the connector can
create, update and read back in this exact data source, which is the whole point of a canary.

It creates **no durable ambiguity and no unsafe pollution**:

- `INSTALL_CANARY:<planId>` is not a contract key, so it can never be mistaken for a contract resource, and the
  "exactly one row per contract key" check cannot collide with it;
- it carries `Required = false` and no business data;
- **no business reader consumes the clone's Registry at all.** Only this installer does. (The `resume` engine's
  resource registry is `META — RESOURCE REGISTRY`, a META-lane database — see
  `ControlPlaneGrammar.resourceRegistryDatabaseTitle`, declared only on the META control plane.)
- it is plan-bound, so **no earlier canary can satisfy a later plan's proof** (PT-INST-021/c).

## Promotion is bound to ONE proof

`plans.install_mapping_plan_id` and `plans.install_mapping_final_receipt_id` durably record which mapping plan and
which FINAL receipt a promotion was prepared against (`plans_install_promotion_proof_check`,
`plans_install_mapping_plan_fk`, `plans_install_mapping_receipt_fk`). "Any final mapping of the same runtime
generation" is explicitly **not** sufficient (PT-INST-022/b), and a proof made under a different binding is not
sufficient either (PT-INST-025).

Immediately before the backend compare-and-swap, `os_verify(FINAL)` re-reads and re-proves, from live sources:

1. the bound mapping plan row (kind, state, principal, binding, generation);
2. the bound FINAL receipt row (type, plan, status, principal, generation);
3. the contract-derived mapping, **recomputed** from the assigned clone, compared field by field against what the
   bound plan actually proved;
4. every mapped Registry row: still pointing at its unique contract-derived target, still `RESOLVED`;
5. the terminal canary: still active, still keyed to the bound mapping plan, still `RESOLVED`, still living in the
   governing Registry data source;
6. its own TARGET receipt through `checkTargetReceipt` (TTL, ownership, consumption);
7. the canonical OS State/CURRENT, field by field, against the server-derived clean B0 setup baseline;
8. the Manifest, field by field, against the server-derived promotion.

**Anything tampered with after TARGET HOLDs here and grants nothing** (PT-INST-023/a–f). The HOLD evidence always
ends with `no backend activation was attempted`.

## Activation durability

The backend `INSTALL_PENDING → KNOWN` transition is a genuine compare-and-swap.

> **Single-writer file deployment invariant.** The file registry is a SINGLE-HOST, LOCAL-FILESYSTEM deployment.
> Every writer atomically creates an exclusive `0700` **directory** named `<registry>.lock`, publishes and
> `fsync`s one unpredictable `0600` owner-token file inside it, re-reads the registry **inside** the lock (that
> read is the *compare*), writes a temporary file, `fsync`s it, `rename`s it into place, then `fsync`s the
> containing directory so the rename itself survives power loss. Release removes only that writer's token and
> `rmdir`s only an empty lock directory; it never recursively deletes a lock and cannot remove a replacement
> owner's lock. A `Promise`-local mutation queue is **not** multi-process atomic and is deliberately not used.
>
> Existing locks are **never age-reaped**. A contender waits only for the bounded acquisition window, then fails
> closed without attempting activation. After a crash, an operator must prove no live writer owns the directory
> and explicitly remove the abandoned lock while activation is quiesced. Exclusive `mkdir` is not a reliable
> mutex over NFS/SMB; a multi-host deployment must move this registry into PostgreSQL instead of sharing the file.

PT-INST-031/a proves this with **eight real child processes** racing one activation: exactly one wins, the
generation is bumped exactly once, and the winner's proof id is recorded. PT-INST-031/b proves no lock directory,
temporary file or widened permission survives the normal race; PT-INST-031/g–h prove no age-reap and owner-safe
release when the public lock path is replaced.

Activation bumps `pointer_generation`, which changes the runtime generation, which **stales the old handle before
any tool body runs**. The installer handle can never act again (PT-INST-024/a). A crash between the swap and the
receipt reconciles on the next bind and grants nothing extra (PT-INST-024/d).

## After activation

The fresh `os_bind` yields a `BUSINESS` binding on the new generation with no installer surface. It enters the
ordinary business engine — including the REQUIRED capability completeness check (see `SKILL.md` §1a and
PT-GTM-015). A freshly installed clone has no business state yet, so business progression stays **fail-closed**
until the runtime is populated and its required capabilities are verified (PT-INST-024/b).

## Acceptance suite

The implemented automated IDs are:

- `PT-INST-001–004`: authorization, persisted INSTALL_ONLY mode and business-surface cloisonnement;
- `PT-INST-011–014`: copied-data quarantine, derived mapping, capability separation and structural/schema refusal;
- `PT-INST-021–025`: plan-bound canary, separate promotion, tamper refusal, activation/rebind/crash and
  cross-binding proof isolation;
- `PT-INST-031–033`: cross-process file CAS, receipt uniqueness/TTL and expired-promotion refusal.

They live under `packages/harness/test/install/` and run with `pnpm --filter @vertigo/harness test`. Their
"native writer" is an in-process fixture that executes the exact renderer output; these tests are **not** evidence
that the production Notion connector accepted those shapes. Connector-level acceptance additionally requires the
remote smoke in `packages/plugin/docs/INSTALL.md`: attested served revision, token rotation (new succeeds / old
401), refreshed remote `@VERTIGO`, and a fresh ordinary ChatGPT chat owned by the seller with native Notion,
Gmail and Google Calendar exposed on the relevant messages and no local MCP. A Work/Codex task or engineering
lane is never acceptance evidence. The same smoke must exercise the real create/update/readback canary lifecycle
on the pilot clone.
