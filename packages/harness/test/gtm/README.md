# GTM-W03 — controlled fixture package and semantic oracle matrix

Test-only. Deterministic. Synthetic. Nothing here is live, governing, installed or adopted.

This package materializes the GTM semantics admitted in W02 (D01..D07 and D-CAL-01) as a frozen synthetic world
plus pure oracles, so the per-principal read canaries scheduled for the next GTM gate have an exact target to
compare against. **It proves fixture and oracle availability only.** No PT-GTM case is marked PASS by this package,
and the real per-principal read canaries (PT-GTM-011..013) stay deferred.

## What is in here

| file | role |
| --- | --- |
| `catalog.ts` | logical resource catalog, natural keys, field classes, read scopes, candidate version markers |
| `world.ts` | the deterministic synthetic world, its fingerprint, its reset and its pure variants |
| `oracle.ts` | the semantic oracles: eligibility, attribution, horizons, episodes, exposure, aggregation, classification |
| `pack.ts` | the candidate context-pack builder (test-only; the adopted pack is neither imported nor changed) |
| `ledger.ts` | the crash / idempotence substrate and the reset-isolation contract |
| `matrix.ts` | the 68 required fixture branches, each with its frozen TARGET and FINAL compare sets |
| `pt-gtm-*.test.ts` | the executable checks |

Run them with `pnpm --filter @vertigo/harness test` (they are part of the harness test glob) or
`node --test 'test/gtm/*.test.ts'` from `packages/harness`.

## Fixture root, resource catalog and natural keys

Every logical key lives under the single fixture root `GTM_FIX`. `catalog.ts` freezes one entry per resource:

`PRINCIPAL`, `RUNTIME`, `COMPANY`, `CONTACT`, `MESSAGE`, `CAMPAIGN`, `APPROACH_VERSION`, `PARTICIPATION`,
`ENROLLMENT`, `EXPOSURE`, `TRACKER_EVENT`, `PROVIDER_EVENT`, `MEETING_EPISODE`, `COVERAGE`, `METRIC_DEF`,
`REGISTERED_CONTEXT`.

Each entry declares its natural key and every
field is classified `IMMUTABLE`, `VERSIONED`, `MUTABLE` or `PROVENANCE`. Provenance is uniform:
`source_system`, `observed_at`, `evidence_ref`, `non_live`. The coverage test walks the catalog, proves natural-key
uniqueness over the world, proves that no record carries an undeclared field, and compares the record counts to the
frozen `BASELINE_SHAPE`.

**Natural-key invariant.** A runtime-scoped key is minted BY a runtime, so `runtime_key` participates in the
natural key of every `RUNTIME_SCOPED` resource (`RUNTIME` itself is the exception: its natural key *is*
`runtime_key`). Two runtimes minting the same local token — `C01`, `OUT-C01`, `EP-M01` — is lawful, is never a
duplicate, and must never let a lookup resolve the other runtime's row. For the same reason every runtime-scoped
lookup in `oracle.ts` takes the runtime it reads as a required argument, so a caller cannot forget the scope.
`pt-gtm-key-collision.test.ts` checks the invariant over the catalog and then proves it on a world where the second
runtime mints the first runtime's tokens for rows of its own: no spurious duplicate, no cross-runtime resolution,
the first runtime's answers byte-identical, and the second runtime's internal counterpart never counted as a
replied prospect.

## Read scopes and principal isolation

A principal reads its own runtime's rows and nothing else. A profile without a runtime reads nothing at all and
never falls back onto somebody else's runtime: `readRows` answers `REFUSED_NO_RUNTIME`, and naming a foreign runtime
answers `REFUSED_FOREIGN_RUNTIME`. Read-selection symbols confer no mutation authority; handing one to a mutation
catalog fails closed, and the transaction path still rehydrates for itself from durable state.

## The worlds

* **A — replies (runtime `R_TEST`, week `[2026-09-14, 2026-09-21)` Europe/Paris, half-open, observed after W).**
  `weekly_replied_prospects` = 3 (C01, C05, C09) over 5 eligible human reply messages; C01's first reply is
  delivered twice and collapses; technical, opt-out, unknown-kind and permanently-bounced inbound count zero and
  each pins its own consequence; the external outbound entry cohort of W is 7 contacts with 2 repliers, so the
  cohort rate is `2/7` and never `3/7` — C05 replied inside W but entered earlier. Missing mailbox coverage makes
  both the metric and the cohort `NOT_COMPUTABLE`.
* **B — meetings.** One agreed and booked episode (1 historical booking, 1 active, 0 held, 0 qualified), one
  proposal that was never agreed (0 booking), one internal work block (never a prospect meeting). Cancelling keeps
  the historical booking and drops the active one. A held meeting without a pinned qualification definition makes
  `qualified` `NOT_COMPUTABLE`, never zero.
* **C — campaigns, versions, participations, enrollments, exposure.** One rep running two approach versions keeps
  them separately measurable; one approach run by two reps keeps owner and runtime on each participation; each
  contact has at most one ACTIVE enrollment and successive campaigns are temporal; an exposure pins what was
  actually communicated (offer, price, override evidence) which differs from what the campaign configures; a link
  sent is not a link read; an exposure pinned earlier never mutates.
* **D — attribution ambiguity and company non-additivity.** A reply with two plausible touchpoints stays
  `UNATTRIBUTED` with every candidate preserved and no implicit last touch; a reply with no prior outbound is
  `UNKNOWN`; two replied contacts inside one company are one company credit; a company-global, overlap-sensitive
  total across runtimes is `NOT_COMPUTABLE` and holds, because the pilot declares no Shared Reality topology.
* **E — four synthetic principal source profiles.** Shapes only, on the reserved `example.invalid` domain: an
  advanced setup, a lighter setup, a HOLD-shaped profile whose mailbox manifest/registry divergence is preserved on
  both sides, and a profile with no runtime that never borrows one.
* **F — D-CAL-01 classification** over purely synthetic provider events: only internal-only events are excluded; a
  VERTIGO participant never excludes; bots and rooms never create an external human; masked or truncated evidence
  is `UNKNOWN`; purpose (`EXTERNAL_COMMERCIAL` / `EXTERNAL_OTHER` / `PURPOSE_UNKNOWN`) is classified separately and
  never inferred from a title; the calendar allowlist is a separate question from classification. **No Calendar
  source is connected**, so real reads stay deferred. Recurring occurrences are distinct episodes while reschedules
  are one; a crashed classification pass resumes from its checkpoint with an identical, duplicate-free result.
* **G — candidate context pack.** Test-only, never adopted: each lane selects only its own admitted, registered,
  owner-bound pointers; a cross-lane need is refused inside the pack; there is no read-all symbol; a changed ref or
  a rotated generation changes the pack identity; a stale pack cannot steer a new Run; missing registered context
  answers `NEEDS_EXPANSION` with a truthful unavailable pointer instead of inventing refs.
* **H — crash, recovery, idempotence.** Replay with the old expected value is safe; the new expected value updates
  the same row without duplicating; a third value holds on conflict; a crash between the durable write and its
  receipt is recovered by exact lookup on the action key; a second concurrent writer coordinates or holds.

## Compare sets

`matrix.ts` freezes, for each of the 68 branches, two compare sets recomputed on every run:

* **TARGET** — the fixture state that must be materialized (keys, evidence, flags, declared coverage, stamps);
* **FINAL** — the semantic outcome the oracle must produce from that state.

A branch also names the admitted decisions it materializes and the catalogued resources it touches. Any silent data
or oracle drift changes one of the two projections and fails the coverage test instead of quietly re-baselining.

Every branch carries `result_semantics = FIXTURE_AND_ORACLE_AVAILABLE`, and the PT-GTM-011..013 branches carry
`real_read_canary = DEFERRED_GTM_G3`.

## Reset and isolation contract

`buildGtmWorld()` returns a deeply frozen clone of pure data: two builds are deep-equal and share one fingerprint,
and every variant (`withCanceledEpisode`, `withCoverageGap`, `withoutMetricHorizon`, …) is a fresh clone that never
touches the baseline. `resetFixtureStore` rebuilds exactly the `GTM_FIX:` namespace and leaves every key outside the
fixture root strictly alone — same reference, same value. The reset is deterministic: the rebuilt world's
fingerprint equals the pristine baseline's.

## Candidate version markers

The candidate semantics of this package are recorded as decomposed `(family, version)` markers with
`role = CANDIDATE_NOT_ADOPTED`, `activation = NEVER_ACTIVATED_IN_PRODUCTION`, `scope = W03_FIXTURE_SEMANTICS_ONLY`:
the plugin spec candidate, the context-pack candidate, and the two SALES candidates. They are decomposed on purpose,
so that no composed, governing-looking version literal exists anywhere in this repository and no candidate can be
resolved, dispatched or compared as governance. The package records only the FAMILY names whose governing selection
it leaves untouched — never their governing versions, which are resolved at run time and never from this repository.

## Safety

`pt-gtm-safety.test.ts` proves statically that this directory contains no URL, no live mailbox host, no identifier
shape that could be a live runtime or page id, no import of a production source module or provider adapter, no
external effect (no filesystem writes, no network, no environment reads outside the static guard itself), and no
tool: the six-tool surface of the plugin manifest is asserted unchanged. Every identity uses the reserved,
unroutable fixture domain and every record carries the `NON_LIVE_SYNTHETIC_FIXTURE` provenance marker.
