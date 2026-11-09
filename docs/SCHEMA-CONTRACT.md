> Historical reference, not current deployment instructions. See [architecture](ARCHITECTURE.md).

# Control-plane schema contract (harness linkage)

> **LIVE** — ce document décrit le produit servi aujourd'hui (six outils, écritures Notion par l'application native, harness en lecture seule : PDEC-001/002). La cible en construction (PDEC-018, candidate, non adoptée) est décrite dans `docs/START_HERE.md` et `docs/plans/PV-WRITE-001.md`.

`os_verify` can only bless a mutation it can bind to its own plan and receipt through **structured, filterable**
Notion properties. The contract is derived from the governing adapter grammar (`writeProps` in
`packages/harness/src/versions/adapters/controlPlane.ts`), so property names are version-scoped. For the
current META (`META_SPEC/0.6`) and SALES (`SALES_RUNTIME_CONTRACT/0.5`) grammars:

| Database | Property | Type | Level | Role |
| --- | --- | --- | --- | --- |
| Runs | `Status` | select | required | run status |
| Runs | `Harness Plan ID` | rich_text | required | Run ↔ backend plan linkage |
| Mutation Ledger | `Status` | select | required | ledger status |
| Mutation Ledger | `Run Ref` | rich_text (page mention) | required | ledger ↔ Run linkage |
| Mutation Ledger | `Harness Plan ID` | rich_text | required | ledger ↔ backend plan linkage |
| Mutation Ledger | `Idempotency Key` | rich_text | required | one row per planned operation |
| Mutation Ledger | `Target Receipt ID` | rich_text | required | FINAL proof: the target receipt the harness issued |
| Mutation Ledger | `Target Ref` | rich_text | recommended | physical target reference |
| Mutation Ledger | `Operation` | select | recommended | CREATE / UPDATE |

A `title` property satisfies a `rich_text` requirement and a `status` property satisfies a `select` one.

## Detection

`checkSchemaCompatibility(client, runtime)` (`src/verify/schemaContract.ts`) reads the live data-source
schemas and returns a report with the exact gaps and the migration to apply. It is read-only.

- `os_prepare` reports the result in `observations.control_plane_schema` and warns when incompatible.
- `os_verify(TARGET)` refuses with `HOLD_SCHEMA_MISMATCH` (listing the migration) when the contract is not
  met: a target value alone never receives a receipt.

## Migration

The harness never mutates a live runtime. `migrateFixtureSchema` is a pure helper for fixture schemas only.
Applying the contract to a live META or SALES runtime requires a separately authorized migration
validation ticket executed through the native Notion app.

## Control Check mirrors (os_control_status, read-only)

`os_control_status` consumes — never produces — Control Check mirror rows (00G): a `META — CONTROL CHECKS`
database under the META root with `Control Check ID`, `Control Version`, `Checked At` (date), `Result`
(select: PASS / HOLD / VIOLATION / UNKNOWN), `Scope` (text naming the verified targets), and the optional
`Canonical Artifact Hash` / `Mirror Integrity Status`. Gates may carry `Confirmed By Control Check Ref`.
Property names come from `controlCheckProps` in the governing grammar; a missing database is an incomplete
scope (`HOLD_CONTROL_SCOPE_INCOMPLETE`), never a silent PASS.
