# Configuration contract

## Candidate first-source identity enrollment (W7.3-R2)

An operator may add `source_identity_enrollment: ["GMAIL"]` to **one** assigned Sales registry entry.
It enables only `SOURCE_IDENTITY_ENROLLMENT/1` for a source declared by that runtime's governing
adapter. Missing/empty opt-in leaves existing instances unchanged. This flag neither connects a native
app nor proves access, consent, ownership or READ_VERIFIED. It must not be set globally from a chat.
The same instance opt-in gates the revised minimal-read capability conduct, including later required
sources; a challenge alone does not change the conduct of a non-opted-in runtime.
The descriptor supplies source, capability, identity format/observation and the exact writable Manifest
field; the common engine has no provider-specific branch. The current candidate declares Gmail only.
Future providers require their own bounded contract/adapter/proof, not a generic write or permission.

Observation uses a native account/profile read in the member's own chat. The first response asks the
member to confirm that exact account and writes nothing to Notion. A second signed, binding-scoped
challenge requires an assistant attestation of an explicit human reply; the backend cannot independently
prove that reply or native OAuth. Its durable attestation is stored in existing plan instruction JSON.
After a fresh resume, only an explicit current reply to the immediately preceding exact account question
may use its still-valid signed CONFIRM token. A fresh OBSERVE does not revoke it or require a second read.
The registry's existing expected identity, if declared, remains binding and cannot be replaced by enrollment.
Only a backend-factory mutation may fill the previously empty field. An exact operator-approved
`RECONCILE_AS_IS` class for `SALES:SOURCE_IDENTITY`, `UPDATE`, `["Gmail Identity"]` is required; no
approval is minted by the chat. TARGET/FINAL, guard freshness, journal recovery and State-last remain.
This observed-and-confirmed first-link extension is not a generic divergent reconciliation privilege.
The field is never replaced by this protocol; linking is not operational-read verification, a business
step, sending permission or a Gmail Verified update. No new Notion field/database/PG migration/tool.
Concurrent different identities stop subsequent bytes and recovery. This is read-before-write detection,
not atomic Notion compare-and-swap: a change between the last read and write remains a residual race.
Revoking opt-in or guard approval during a started link deliberately stops recovery until the operator
restores/reconciles its authority; no automatic approval or identity replacement is attempted.

Conduct travels on live responses to the existing five tools; it can change after a backend release
without a new ZIP. Host tool schemas/permissions/activation and static package updates are separate:
no promise of a silent remote update of everything in ChatGPT. W7.3-R2 is local until a scoped service
authorization and real readback; it does not authorize a global deployment or historical migration.

> **LIVE** — ce document décrit le produit servi aujourd'hui (six outils, écritures Notion par l'application native, harness en lecture seule : PDEC-001/002). La cible en construction (PDEC-018, candidate, non adoptée) est décrite dans `docs/START_HERE.md` et `docs/plans/PV-WRITE-001.md`.

> **Config cutover (W3.5a).** Canonical names are now `NOTION_TOKEN` and `HARNESS_ENV=live`. The former names
> `NOTION_READ_TOKEN` and `live_readonly` remain accepted for one release. The candidate code base contains the
> backend transactional Notion writer (PV-WRITE-001); the new names therefore make no read-only promise. This cutover
> renames configuration only and changes no runtime wiring.

All configuration is read from the environment by `packages/harness/src/config/index.ts`.
Callers (LLM tool arguments) can never override any of it.

| Variable | Required | Meaning |
|---|---|---|
| `VERTIGO_META_SPEC_ROOT` | yes | Stable META spec root page URL/ID. The only allowed hardcoded runtime pointer (PDEC-008). |
| `NOTION_TOKEN` | yes (live) | Notion integration token, least privilege. Not guaranteed read-only: the candidate contains the backend transactional writer (PV-WRITE-001); grant write capabilities only when an approved PV-WRITE-001 gate activates it. |
| `NOTION_READ_TOKEN` | deprecated | Former name of `NOTION_TOKEN`, accepted for one release. If both are set and differ, startup fails closed; the loader never chooses between them. |
| `DATABASE_URL` | no | PostgreSQL connection string for the backend transaction store. Empty ⇒ in-memory store (fixture/dev only). |
| `HARNESS_ENV` | yes | `fixture` (tests against fixtures, no live Notion) or `live` (live workspace). `live_readonly` is the deprecated alias of `live`, accepted for one release. |
| `HARNESS_FIXTURE_WORLD_FILE` | no (fixture only) | Serialized map consumed by the network-free fixture Notion client. Rejected when `HARNESS_ENV=live` (or `live_readonly`); never point it at a LIVE runtime export. |
| `SALES_RUNTIME_REGISTRY_FILE` | no | JSON backend registry of Personal SALES runtimes: `runtimes[]` of `{rep_identity_key, status: KNOWN\|INSTALL_PENDING\|NOT_YET_CREATED, root_ref?, expected_instance_id?, expected_gmail_identity?, pointer_generation?, activation_proof_plan_id?, objective_package_ref?, note?}`. Absent ⇒ every SALES lookup is UNKNOWN. Deployment config, never source. **Re-read on every lookup** (no process cache). This is the only file the harness ever writes, and only through the provisioning compare-and-swap below. |
| `PRINCIPALS_FILE` | yes | JSON principal registry: `principal_id`, `status`, `allowed_projects[]`, `allowed_lanes[]`, `rep_identity_key?`, `meta_authority?`, `display_name?`. Deployment config, never source. **Re-read on every lookup**, so a suspension or removal takes effect without restarting the harness. |
| `HARNESS_TRANSPORT` | no | `stdio` (default, local development; principal from `HARNESS_PRINCIPAL_ID`) or `http` (remote MCP endpoint `POST /mcp` for ChatGPT; the bearer token supplies the principal). |
| `HARNESS_HTTP_HOST` / `HARNESS_HTTP_PORT` | no | Bind address of the HTTP endpoint (default `127.0.0.1` / `8787`). Expose only through your own HTTPS reverse proxy. |
| `HARNESS_HTTP_TOKENS_FILE` | yes (http) | JSON `{ "tokens": [{ "token_sha256", "principal_id" }] }` — SHA-256 of each bearer token mapped to a principal. Raw tokens never live on disk. Fresh-read and validated for every request, so an atomic file replacement revokes the old token without restarting. |
| `HARNESS_BUILD_REVISION` | yes (live HTTP) | Exact lowercase 40-hex Git revision of the served checkout. `scripts/serve.sh` derives it; other launchers must supply it. |
| `HARNESS_BUILD_DIRTY` | yes (live HTTP) | `true` or `false`: whether that revision is served with uncommitted/untracked files. It is evidence, not a release verdict. |
| `HARNESS_CONFIG_FINGERPRINT` | yes (live HTTP) | 64-hex SHA-256 of the deployment configuration material. `scripts/serve.sh` hashes the files actually read and exposes only this non-secret digest. |
| `HARNESS_NATIVE_NOTE_PILOT_FILE` | no | Opt-in private owner TEST_ONLY profile, not caller input. Exact transport principal must remain ACTIVE/COMPANY_OWNER. Fixed synthetic page, marker/section/key and runtime generation; private signed journal and receipt secret remain server-side, never in the plugin. Only this owner's MCP surface changes; other principals retain legacy tools/instructions. Single-process journal, not a distributed lock or an atomic Notion transaction. Include profile/overlay hashes in deployment evidence. No original OS writes. |
| `HARNESS_NATIVE_DIRECTION_PILOT_FILE` | no | Additional SYNTHETIC_ONLY direction profile for that same note-pilot owner. Absent, invalid or mismatched profile disables only this addition. Operator fixes two fictional pages, initial approved versions, recipient, method and next synthetic event; callers provide only STATUS/PREPARE/VERIFY and their numerical test intent. Native connector performs writes; independent reads and a signed single-process journal attest exact test records, never real approval, recipient adoption, business-source truth or Notion atomicity. Preserve old note/auth/registry files; include new profile and overlay hashes in evidence and restore previous image/config for rollback. Never distribute this profile or its HMAC secret. |
| `HARNESS_NATIVE_META_PROFILE_FILE` | no | Optional read-only REAL_META_PROFILE/1 for that same private owner, never a seller installation requirement. Fixed real root, Manifest/People pages and data sources, Notion user/person key and META runtime/generation; no caller-supplied identity/target. Exact transport principal must be ACTIVE/COMPANY_OWNER with META project/lane and current Notion owner/manager identity. STATUS re-reads the three pages and selected fields; signed observations attest those declared fields at a moment, not health/readiness, transaction persistence, publication/recipient adoption or Gmail/Calendar truth. No writes/journal changes, no new permissions or credentials; retain the server-only receipt secret and existing registries, preserve note/direction profiles, record profile/overlay hashes and roll back the optional setting plus image. |
| `HARNESS_NATIVE_SALES_PROFILE_FILE` | no | Optional REAL_SALES_NATIVE/1 for one exact existing seller principal, separate from owner laboratory. Fixed principal/project/rep/runtime, expected mailbox, root, CURRENT Manifest/State pages and their data sources, Runs and Receipts data sources. ACTIVE SALES principal and fresh KNOWN registry assignment must match; an optional registry mailbox must not conflict. Current Manifest runtime/root/email and all data-source ancestry are independently read. CONTEXT returns selected declared fields and newest observed Run; VERIFY_RECEIPT queries a unique exact Gmail key and compares event/account fields twice. OBSERVED is unsigned point-in-time Notion presence, not Gmail authentication/truth, user authorization, atomic persistence or global coverage. No writer/journal/auth/registry/OS changes; absent setting preserves the legacy surface. Do not enable until the actual seller plugin source and host compatibility are verified; malformed/owner-colliding profile is disabled, never an owner-to-seller conversion. |
| `HARNESS_NATIVE_SALES_ADDITIONAL_PROFILES_FILE` | no | Deployment-only JSON array of 1–3 additional REAL_SALES_NATIVE/1 profiles, admitted through the same fresh principal/registry/Notion guards. Every principal, rep, runtime, mailbox and Notion target must be distinct from the primary and other additions. Invalid/colliding additions are disabled as a group; the existing primary profile is retained. Owner collisions are rejected. No caller-selected target, OS mutation, permission/adoption or extra principal provisioning is implied by this configuration. |
| `HARNESS_NATIVE_REAL_DIRECTION_PROFILE_FILE` | no | Optional private REAL_DIRECTION_PROFILE/3 with publication.contract=META_ORIENTATION/1.0; /1 is rejected, never migrated or silently served. The VERTIGO private deployment is evidenced by dated R19 receipts, not by this setting alone; whole-product acceptance remains open. Owner META root/runtime/Manifest and each recipient principal/rep/runtime/root/mailbox/Receipts/Manifest must match the configured native profiles. Publication binds actual META Manifest/schema/spec/control versions, Runs/Ledger/Decisions/Definitions and recipient schema/Sales-contract pins. Native connectors execute only returned bounded conditional writes: four native journaled mutations, immutable personal package and pointer last; two complete fresh proof passes before PUBLISHED. No global G11 read/write/confirmation or change of Sales controls. Unknown/concurrent pointer refuses; old versions/rules/history remain. Invalid/absent file disables only direction. Private signed journal/secret stay server-side; no reset or migration of an older journal is implied. Single-host filesystem lock, no automatic abandoned-lock reaping. Owner approval is session attestation, not cryptographic human-click proof. Read-only Sales CONTEXT, separate exact consumption receipt, no business outcome or authority inferred. Closed trace phase/contract/reason and bounded version/acknowledgement metadata only, no payloads/private URLs. Operator authorization/configuration is still required to enable a profile; a diagnostic-only update requires no collaborator reinstall. |
| `EXTERNAL_ACTION_TEST_FROM` / `EXTERNAL_ACTION_TEST_TO` | no | Owner-approved sender / recipient list for `EXTERNAL_ACTION_TEST` native Gmail sends. Absent ⇒ `HOLD_TEST_SCOPE_NOT_APPROVED`. |
| `HARNESS_PRINCIPAL_ID` | stdio only | Local principal for the stdio transport. |
| `BINDING_TTL_HOURS` | no | Default 24. |
| `PLAN_TTL_MINUTES` | no | Default 15. |
| `TARGET_RECEIPT_TTL_MINUTES` | no | Default 10. |

### Native control diagnostics — scope and evidence

Each native tool call retains its pseudonymous profile, HTTP request/call correlation,
closed action/status/reason, duration and relevant bookkeeping flags. Successful
Sales CONTEXT already logs the nested `direction_status` and `direction_code`.
An applicable `PUBLISHED_DIRECTION` returned by Sales or direction CONTEXT adds
`direction_version` and `direction_ack=DUE|RECORDED|UNKNOWN`.

- `DUE`: the returned context says consumption is still needed.
- `RECORDED`: CONTEXT reports a previously verified journal acknowledgement; this is
  **not a fresh native receipt readback**. Owner STATUS may still find that receipt
  missing or changed and must not trust this diagnostic flag alone.
- `receipt_version` appears only on a direction CONSUME/VERIFY_CONSUMPTION reply
  actually returning CONSUMED. This attests the exact control receipt observed by
  that call, not business execution, adoption, sending permission or a human click.

Versions are integers1–1000000, otherwise UNKNOWN; no string coercion or payload
serialization. No proposal/receipt/page IDs, email addresses, private URLs, bodies
or credentials are added. Supported complete diagnostic lines stay within640chars.
Tool END proves server-side handler completion only. HTTP FINISHED proves server
response completion, not model rendering, reading or reception. Durations are not
human working time. Private native ChatGPT connector calls/refusals and responses
remain outside this server's visibility. Absence of a trace is not absence of work.

### H5 private capability: real direction cold owner resume

The real direction owner `STATUS` returns up to five pending proposals per
recipient, the full immutable direction and exact handles, with `pending_coverage`
`COMPLETE` or `PARTIAL`. It never writes or approves. `can_resume` is true only
for an already approved proposal on the current base; a draft still needs exact
human approval, and stale or reassigned proposals cannot be resumed as current.
A cold owner session may use the returned proposal ID with existing `VERIFY` to
recover pending native writes without private chat memory or a new approval.
Several candidates or a partial window do not authorize arbitrary selection.
These are source capabilities; dated deployment and native readback receipts prove
their actual configured service. They do not establish recipient adoption or replace
the deferred ordinary-collaborator acceptance test.

### H4 local candidate: optional META work context (not deployed)

`REAL_META_PROFILE/1` can additionally contain `operating_sources` with the fixed
operator-only keys `decisions_database_id`, `decisions_data_source_id`,
`weekly_reviews_database_id`, `weekly_reviews_data_source_id`, and
`business_decision_page_id`. Never put this profile or its receipt secret in the plugin.
This source change does not update any served profile or grant Notion access.

`STATUS` is unchanged (six successful GETs). `CONTEXT` accepts no extra argument:
authenticated owner admission, fixed root/database/source parent validation, at most
four queried rows per source and three returned, two selected-value passes, then
fresh identity/registry checks. A full successful context uses at most20read requests,
including four POST query requests, never a write. Missing mapping is local
`CONTEXT_NOT_CONFIGURED`; an unavailable/partial source does not deny independent work.
Windows are not exhaustive histories. A signed `META_CONTEXT_RECEIPT/1` attests only
the selected observations/limits: no semantic winner, supersession absence, business
priority, adoption, transaction or Gmail/native-tool-history truth. Old profiles and
note/direction journals are unchanged. Deployment and a real-host result remain due.

## Backend SALES runtime registry: provisioning fields

- `status: INSTALL_PENDING` — a provisioner assigned a non-template clone of the MASTER/template Personal SALES
  space to this rep. It is the **only** authorization to run the dedicated installer; `KNOWN` alone never
  authorizes bootstrap, and a MASTER/template root is refused even under `INSTALL_PENDING`. It additionally
  requires a non-template `expected_instance_id`. Full contract: `docs/INSTALL_PROVISIONING.md`.
- `activation_proof_plan_id` — written by the harness when a verified installation activates the assignment. It
  records WHICH promotion plan was allowed to make this runtime a business instance, and it is what lets a crash
  between the swap and the receipt reconcile on the next bind.
- `objective_package_ref` — optional, **backend-derived only**. It is surfaced as a read-only observation on the
  resolved runtime (`NOT_APPLICABLE` when absent) and is never accepted from chat input, from a tool argument or
  from any copied Notion value. No tool exposes it as a caller-settable argument (PT-CFG-002).

### Registry activation durability (single-writer file invariant)

Compose mounts credential/principal configuration read-only at `/app/config`, but mounts the separate
host `config/runtime-state/` at `/app/runtime-state` read/write. That private directory contains only
`sales-runtimes.local.json`, never tokens, principals or `.env`. The Sales registry path in Compose is
`/app/runtime-state/sales-runtimes.local.json`. Its whole dedicated directory must be writable for the
lock, temporary file and durable rename below; making all of `/app/config` writable is forbidden.
For an existing deployment, preserve a private backup and migrate the old Sales file byte-exact into
this directory, removing the old file from active configuration. `deploy/deploy.sh` refuses dual paths
and fingerprints the new file. This migration changes no assignment or business state by itself.

The `INSTALL_PENDING → KNOWN` transition is a real compare-and-swap, not a read-then-write. Every writer:

1. atomically creates the exclusive **directory** `<registry>.lock` with mode `0700` (`mkdir` is the arbiter on a
   local POSIX filesystem);
2. publishes and `fsync`s one unpredictable owner-token file inside it (`owner-<pid>-<random>`, mode `0600`);
3. re-reads the registry **inside** that lock — that read is the compare;
4. writes a temporary file, `fsync`s it, `rename`s it over the registry, then `fsync`s the containing directory;
5. releases owner-safely: removes only its own token, then removes the lock directory only if it is empty. It never
   recursively deletes a lock and therefore cannot delete a replacement owner's lock.

A `Promise`-local mutation queue only serializes callers within ONE process and is **not** multi-process atomic;
it is deliberately not used. An existing lock is **never age-reaped**: stat-by-age followed by removal can race an
inode replacement and delete a live writer's new lock. Contenders wait for a bounded interval, then fail closed
without attempting activation. If a writer crashed, an operator must first prove no writer owns the directory,
then explicitly remove the abandoned lock while activation is quiesced; there is no automatic stale-lock cleanup.

This is a **single-host, local-filesystem** invariant: exclusive `mkdir` is not a reliable mutex over NFS/SMB, so a
multi-host deployment must move this registry into PostgreSQL rather than share the file. PT-INST-031/a–h proves
the cross-process race, fail-closed abandoned-lock behavior and owner-safe release.

## Runtime artifacts and log hygiene

- The remote MCP endpoint accepts its bearer token in the `Authorization` header or as the path segment
  `/mcp/<token>`. Both are live credentials, so the access log line, the JSON error body and any error text built
  from a request are passed through `src/server/redact.ts`: the `/mcp/<token>` segment, `Bearer …`,
  `Authorization`/`X-Api-Key` headers and credential-bearing query values (`token`, `access_token`, `api_key`,
  `secret`, `signature`, …) are replaced with `<redacted>` (PT-SEC-001, PT-SEC-002).
- `scripts/serve.sh` sets `umask 077` **before** any redirection, creates `.run/` as `0700` and tightens any
  inherited `.run/` to `0700` directories / `0600` files. `.run/tunnel.log` and `.run/public-url` contain the
  public endpoint (and therefore the path-carried token), so they must never be group- or world-readable.
- The token registry is validated before listening and fresh-read on every request. Rotate it by writing a complete
  owner-only replacement file and atomically renaming it over the configured path; never edit the live JSON in
  place. After that rename the new token must initialize successfully and the old token must return 401 without a
  process restart (PT-DEPLOY-004). Refresh the remote app connection immediately; never print either raw token.
- Tightening permissions is safe at any time. A credential rotation is complete only after the connector points at
  the new credential and the old credential has been proved 401.

## Served-build attestation

The governing Notion package remains `PLUGIN_SPEC/0.3.0`. The executable currently under pre-production test is
the guarded `PLUGIN_SPEC/0.4.0-candidate`; deploying repository code does **not** adopt it in Notion.

Every `live` (or legacy `live_readonly`) HTTP process refuses startup unless revision, dirty state and config fingerprint are present.
MCP `initialize.serverInfo.version` then carries all three verbatim as
`0.4.0-candidate+rev.<40-hex>.dirty.<true|false>.cfg.<64-hex>`, and the startup line carries the same values. A
fixture/stdio process reports `0.4.0-candidate+fixture.unattested` and is never valid release evidence
(PT-DEPLOY-001–003). A remote process may expose `dirty.true` for diagnostics, but a pilot/release PASS requires
`dirty.false`; otherwise the revision alone cannot reproduce the served working tree.

Remote smoke evidence is a separate, connector-level check, not implied by the in-process suite:

1. start the public HTTPS endpoint and record the expected Git revision, dirty value and config fingerprint;
2. initialize the **remote** endpoint and compare `serverInfo.version` byte-for-byte with those expected values;
3. atomically rotate the token registry; prove the new token initializes and the old token receives 401;
4. refresh the remote `@VERTIGO` app connection to the new credential/URL;
5. open a new ChatGPT Work cloud conversation with the remote app and native Notion only — no local stdio MCP —
   and run an ordinary `os_bind → os_resume` before any write.

## What must never be configured or hardcoded

Current META root, Manifest URL, runtime ID, MRUN numbers, current gate/blocker, current CONTROL
version, change candidates, next action, or any rep's SALES root. All of these are discovered from
durable Notion state at call time (07 — VERSION RESOLUTION & CONTROL). `test/arch/pt-arch-002` fails
the build if such constants appear in source, config templates or tests.

## Environment separation

`HARNESS_ENV=fixture` forbids network calls to Notion. It uses an empty fixture world by default or the
serialized world named by `HARNESS_FIXTURE_WORLD_FILE`; controlled generators may build that file from
synthetic test fixtures under the ignored `.run/` directory.
`HARNESS_ENV=live` (legacy alias `live_readonly`, one release) allows the Notion client against live runtimes
with `NOTION_TOKEN`. The environment name alone does not make a process read-only: what it may do in Notion is
decided by its runtime wiring and by the integration's capabilities. Supplying `HARNESS_FIXTURE_WORLD_FILE` in this
mode is a configuration error, not an ignored option.

## Identity and lane scoping (PV0-002)

- Every tool call is resolved to a `principal_id` by the transport layer (never by tool arguments).
  The V0 stdio server reads `HARNESS_PRINCIPAL_ID` from the environment for local development; a
  production transport must supply the authenticated principal itself.
- Authorization uses `principal_id`, `allowed_projects` and `allowed_lanes` from the principal
  registry. Display names are presentation only and never authorize anything.
- Every binding, plan and receipt lookup validates ownership: a foreign handle yields
  `ERROR_PRINCIPAL_MISMATCH` without revealing the binding's state; an unauthorized lane at bind time
  yields `HOLD_UNAUTHORIZED_LANE` and creates no binding.
- Logical resource keys are lane-namespaced (`META:<resource>`, `SALES:<resource>`). The lane of every
  later call comes from the binding; an intent referencing another lane's resources is refused with
  `HOLD_CROSS_LANE`, and a key without a lane namespace with `HOLD_RESOURCE_UNKNOWN`.

## SALES runtime discovery and ownership (PV0-004)

- The authenticated principal's `rep_identity_key` selects a backend registry entry. The caller never
  supplies a rep, runtime id or root.
- Existence is explicit: `NOT_YET_CREATED` (declared in the registry) ⇒ `HOLD_RUNTIME_NOT_YET_CREATED`;
  no entry, or a dangling/archived root ⇒ `HOLD_RUNTIME_NOT_FOUND` with `existence=UNKNOWN` or
  `existence=NOT_FOUND` in the evidence; the two are never conflated.
- The canonical Manifest is resolved `ROOT → BOOT page → Manifest database → CURRENT row`, never by
  global title search; a template (`Instance ID` template marker, template root title, or ownerless
  `UNBOUND` Manifest) is refused with `HOLD_RUNTIME_TEMPLATE_NOT_INSTANCE`. The single exception is a clone the
  backend explicitly marks `INSTALL_PENDING`, which binds `INSTALL_ONLY` into the dedicated installer and can
  never reach business authority through a Notion edge (`docs/INSTALL_PROVISIONING.md`).
- Ownership is verified only against registry-declared identity claims (`expected_instance_id`,
  `expected_gmail_identity`) matched to the Manifest. Display names never authorize. No claim ⇒
  `HOLD_UNKNOWN_REQUIRED_FACT`; a failed claim ⇒ `HOLD_RUNTIME_MANIFEST_MISMATCH`.
- The Manifest's `Root URL` must point back at the registry root, and the Manifest's pinned Sales
  contract/schema selects the adapter (unsupported ⇒ `HOLD_UNSUPPORTED_GOVERNING_VERSION`).

### Physically isolated META orientations

The optional `REAL_DIRECTION_PROFILE/3` binds `journal_root_id` to a new direct
child page of the existing private META root, plus four new audit data sources.
`protected_source_ids` must include existing global Runs/Ledger/Definitions/
Decisions/Gates, the META Manifest and every configured operating source. IDs
must be disjoint: renaming or reparenting an existing global source is not a
migration. One exact JSON code marker binds contract, META identity and those
four new source IDs. Missing, partial or ambiguous binding refuses this lane.
Do not register them as global source roles or add filtering exemptions to an
existing consumer. Old profiles and signed journals are retained, not reset or
silently migrated. See the H5 real-direction operations procedure for backup and
image/config-only rollback. No reinstall or new native connection is required.
