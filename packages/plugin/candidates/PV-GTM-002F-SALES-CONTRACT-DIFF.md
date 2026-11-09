# PV-GTM-002F — required SALES contract diff (candidate only)

This is the explicit handoff to the SALES/META contract lane. Plugin Engineering did not edit any canonical OS
source in Notion. The governing Plugin spec remains 0.3.0 and the governing Sales 0.5 line is behaviorally
unchanged. The following additive diff is required on the already-candidate Sales 0.6 / schema 0.6 line before a
single pilot may resume.

## SALES 0.6 additions

1. Add `Operating Mode` (rich text) to the `OS State` CURRENT row. Several governing modes are comma- or
   pipe-separated. The 0.6 GTM candidate declares `GTM_OBSERVABILITY` by default.
2. Add `Capability Profile` under `03 — CONTROL PLANE`, append-only, with:

| property | type | rule |
| --- | --- | --- |
| Capability Proof | title | plain evidence label |
| Capability Proof Key | rich text | immutable natural key |
| Capability Key | rich text | key declared by the governing mode |
| State | select | UNKNOWN / HUMAN_AUTH_PENDING / READ_VERIFIED / WRITE_VERIFIED / PARTIAL / ERROR / NOT_APPLICABLE |
| Runtime ID | rich text | exact bound Personal SALES runtime |
| Principal Key | rich text | exact authenticated runtime owner |
| Operating Mode | rich text | mode that requires/permits the capability |
| Competent Source | select | source declared by the governing requirement |
| Evidence Ref | rich text | durable reference returned by the native source read |
| Verified At | date | ISO instant with explicit offset |
| Scope | rich text | must contain `principal:<key>` and `runtime:<id>` plus the verified source scope |

The natural key is directly reproducible:

`CP|<runtime>|<principal>|<capability>|<mode>|<verified-at>|<evidence-ref>`

Rows are CREATE-only. A changed/revoked/reverified state is a later row beside the old row; latest valid
`Verified At` wins. Unorderable, conflicting, malformed, foreign-principal or foreign-runtime evidence is ERROR.

## Governing requirement set for GTM_OBSERVABILITY

| capability | requirement | accepted state | competent source |
| --- | --- | --- | --- |
| NOTION_RUNTIME_READ | REQUIRED | READ_VERIFIED | NOTION |
| GMAIL_READ | REQUIRED | READ_VERIFIED | GMAIL |
| CALENDAR_READ | REQUIRED | READ_VERIFIED | GOOGLE_CALENDAR |
| MAIL_TRACKER_READ | OPTIONAL | READ_VERIFIED | MAIL_TRACKER |

Missing, UNKNOWN, HUMAN_AUTH_PENDING, PARTIAL or ERROR on any REQUIRED item makes the runtime incomplete. OPTIONAL
does not create a global hold. Calendar onboarding is READ-only and never creates, updates or deletes an event or
FocusSession. Gmail onboarding is read/search-only and never sends.

## Migration/readback invariants

- Add in place; preserve runtime/root/database ids, owner, setup, current gate, history, DNC and all prior evidence.
- Pin the candidate contract/schema only through normal change control and write Manifest LAST.
- Install/bind the candidate Plugin in the pilot seller's own ordinary ChatGPT context.
- First material resume derives completeness without an admin prompt. If incomplete, expose one seller-facing
  action, verify from that seller's competent source, append proof through TARGET/FINAL and resume the same gate.
- Do not migrate a second runtime and do not resume W06 until GTM-G2 is independently re-adjudicated.

META physical schema requires no change. Contract Pack 0.2 keeps Capability Profile outside
`SALES_GTM_CONTEXT`; the completeness summary is control state returned by resume, not a business read pointer.
