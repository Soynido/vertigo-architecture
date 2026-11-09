# PLUGIN_SPEC 0.4.0 — CANDIDATE, NOT ADOPTED

> **CANDIDAT HISTORIQUE** — document d'une version candidate antérieure, servie ou non, jamais la cible courante. Cible en construction : `docs/START_HERE.md` (PDEC-018, candidate).

The governing package spec stays PLUGIN_SPEC 0.3.0 (`../manifest.json`). This file and
`manifest.candidate.json` describe a guarded candidate surface exercised first on controlled fixtures, then on an
explicitly assigned pre-production pilot through the remote connector. Registering or deploying a candidate is
not adopting it: adoption happens in Notion, by writing the Plugin Manifest LAST, and nothing in this repository
can make a candidate govern anything.

## What the candidate changes

Nothing that the user can see as a new capability of the plugin itself:

- the six tools are unchanged — `os_bind`, `os_resume`, `os_prepare`, `os_verify`, `os_handoff`,
  `os_control_status`; no tool is added, renamed or removed;
- the harness still performs no Notion write: every physical write is rendered for the native Notion app;
- TARGET and FINAL readback still gate every durable claim;
- the harness has no Gmail send and no Calendar write path. Native Gmail/Calendar reads are competent-source
  checks performed by the installed agent for its own principal; none of the candidate resources is externally effective.

The delta is entirely inside **what a runtime may declare** and **what a record must prove**:

1. **A candidate Sales contract line** (SALES_RUNTIME_CONTRACT 0.6.0 / SALES_SCHEMA 0.6.0) whose control plane
   adds an append-only Capability Profile and the GTM resource catalog: campaigns, approach versions,
   participations, enrollments, exposures, meeting episodes, reply attributions, coverage declarations, input
   revisions and metric snapshots. Capability proofs, exposures, attributions, coverage, revisions and snapshots
   are CREATE-only, so history is append-only. It dispatches only for a runtime whose own canonical Manifest pins
   it as governing; a runtime on the adopted line addresses none of these resources.
2. **Required Capability completeness on every material SALES resume.** Each governing operating mode declares a
   Required Capability Set. `os_resume` fresh-reads the governing contract, mode and append-only competent-source
   proofs scoped to the bound runtime and principal. The runtime is complete only when every `REQUIRED` item is in
   an explicitly accepted verified state. Missing, `UNKNOWN`, `HUMAN_AUTH_PENDING`, `PARTIAL` and `ERROR` return
   `HOLD_REQUIRED_CAPABILITY_INCOMPLETE`, expose one seller-facing next action and block dependent business work.
   `OPTIONAL` never creates this global HOLD. After the seller acts in their own thread, the installed agent reads
   the competent source, appends a versioned proof through the ordinary TARGET/FINAL transaction and resumes the
   exact prior gate without replaying durable setup. Capability onboarding never requires an admin-relayed prompt.
3. **A candidate Contract Pack policy** (CONTRACT_PACK 0.2.0) with two explicit, lane-exclusive needs:
   `META_GTM_ANALYSIS` selects the registered Sales-inputs pointer plus the explicitly registered GTM
   measurement resource; `SALES_GTM_CONTEXT` selects the GTM containers of the bound principal's own runtime.
   Every candidate pointer states its availability: a selected resource that is not registered is
   `UNAVAILABLE_NOT_REGISTERED` and makes the pack `NEEDS_EXPANSION` / `context_not_registered`, never COMPLETE.
   There is no read-all symbol. A binding without the capability keeps the adopted policy, byte for byte — and on
   META the capability requires the registration to PIN the candidate policy version explicitly: a bare registry
   row adopts nothing.
4. **A prepare-time grammar** for those resources, routed through the shared semantic core: an event period is a
   half-open Europe/Paris CALENDAR week (167, 168 or 169 hours — never an arbitrary seven-day window); maturity
   is decided before coverage; the worst declared coverage state decides whatever the row order; an attribution
   may not promote the last touch and a threading reference that resolves to nothing durably proven is
   UNATTRIBUTED; an exposure may not hide an override, claim a price that was never communicated or a read that
   has no evidence; a variant may not widen Authority; a contact may not hold two ACTIVE enrollments; a booking
   needs an explicit agreement and a held meeting may not be called qualified; a company-global total is refused
   while no Shared Reality topology is declared. Every refusal happens before any plan, Run or lease exists, and
   every message is redacted: no offer, price, contact or body ever appears in an envelope or a log.

5. **Versioned measurement identity**: metric definitions carry a version and a content digest; an input revision
   is derived from its basis; a snapshot key is derived from the definitions, the input revision and the question
   asked. The same question under the same revision is the same snapshot; a backfill or a reclassification creates
   a new revision and a new snapshot beside the old one, and no historical fact is ever overwritten.

6. **Durable-state re-validation at verification**: the constraints that depend on durable state are re-checked at
   `os_verify(TARGET)`, so a native Notion edit between prepare and verify cannot be committed as a stale
   assumption, and no receipt is issued when it happens.

7. **A dedicated, fail-closed INSTALL_ONLY provisioning path** for a backend-assigned, non-template Personal
   SALES clone (`docs/INSTALL_PROVISIONING.md`). A new backend registry status `INSTALL_PENDING` is the ONLY
   authorization to bootstrap: `KNOWN` alone never is, and a MASTER/template root is refused even under
   `INSTALL_PENDING`. The authorization is persisted (`bindings.binding_mode`, `bindings.install_phase`,
   `plans.plan_kind`) and survives every partial Notion state, so **no Notion edit can open BUSINESS**. The
   governing adapter owns the exact paths, object kinds, Registry keys and minimum schemas; copied Registry
   metadata, Runs, Ledger, OS State, `Last Run`, PII and `Required`/`Type`/`Notes` are quarantined and never
   dereferenced. Connectors stay separate, unverified capabilities. No business prepare, rehydrate, recovery,
   handoff or control may run on an INSTALL_ONLY binding. Structure and identity are two separate transactions:
   the first maps the Registry and proves the connector through a plan-bound canary driven
   `MISSING → EXPECTED → RESOLVED` with an independent fetch after each write (a connector-executable terminal
   phase, since `update_page` cannot archive and the live `Status` select has no other options); the second
   promotes the Manifest and is durably bound to that one mapping plan and that one FINAL receipt. Activation
   re-proves the whole bound mapping from live sources immediately before a genuine compare-and-swap on the
   backend registry, bumps the pointer generation, stales the old handle before any tool body runs and requires
   a fresh bind — after which the ordinary REQUIRED capability check (§2) applies.

## Versions

| family | version | role |
| --- | --- | --- |
| PLUGIN_SPEC | 0.4.0 | candidate, not adopted (0.3.0 stays governing) |
| CONTRACT_PACK | 0.2.0 | candidate, applied only to a GTM-capable binding |
| SALES_RUNTIME_CONTRACT | 0.6.0 | candidate contract line, dispatched only by a runtime that pins it |
| SALES_SCHEMA | 0.6.0 | supported schema of that candidate line |
| META_SPEC | 0.6.0 | **unchanged** — the GTM measurement resource is one more registered row of the existing META Resource Registry |
| META_SCHEMA | 0.2.0 | **unchanged** — no new META database, property or control-plane object is required |

## Adoption path (not performed here)

Notion adopts the candidate by pinning the new contract line on a runtime's canonical Manifest and, for the
package, by writing the Plugin Manifest LAST. Until then every runtime keeps resolving its governing versions at
call time, and the candidate behavior is unreachable outside the controlled fixtures.

The pilot migration is additive and in-place: create the Capability Profile, add the governing Operating Mode,
preserve runtime/root/database ids, setup, gate, history, DNC and owner, install the candidate skill/connector in
that seller's ordinary ChatGPT context, then let the seller complete missing native-source authorizations there.
No second runtime is migrated until the single pilot is adjudicated.
