# SALES_RUNTIME_CONTRACT/0.5.2-candidate — Calendar read bridge

Status: candidate, not adopted by registration alone.

This line adds Google Calendar read completeness to the existing Personal Sales operating mode without adopting
the 0.6 GTM model.

## Frozen boundaries

- Supported schema: `SALES_SCHEMA/0.5.1-candidate` only.
- Physical Notion grammar: exactly the 0.5.1 candidate grammar. No page, database, property, select option, Registry
  resource or mutable resource is added.
- Capability mode: `SALES_OPERATIONS`.
- GTM capability: false. `NOTION_RUNTIME_READ` and every 0.6 GTM resource remain out of scope.
- Required reads, in order: `GMAIL_READ` from `GMAIL`, then `CALENDAR_READ` from `GOOGLE_CALENDAR`; both accept
  `READ_VERIFIED` only.
- Google Calendar authority: read/list only. The harness and chat may not create, update or delete an event.
- Capability evidence is append-only in the existing `SALES:CAPABILITY_PROOFS` resource.

Gmail retains its externally verified mailbox identity. Calendar has no canonical account-identity field in this
schema; its proof scope is derived backend-side from the signed challenge, authenticated principal, runtime id and
runtime generation. A chat never supplies or guesses the backend principal key.

## Adoption and rollback

Adoption is a normal governed migration: pin the Manifest contract to this candidate and its contract URL while
leaving `Schema Version` on `SALES_SCHEMA/0.5.1-candidate`; write the Manifest last. Registration in code is not
adoption.

Before promotion, prove in a normal chat that Gmail completes first, Calendar is then the sole missing required
read, the Calendar connector performs one read/list action, one proof is appended and TARGET/FINAL verification
returns to the pre-existing Sales gate. The expected final completeness is two required and two verified.

Rollback pins the prior 0.5.1 candidate contract and URL, again with the Manifest last. The Calendar proof remains
valid append-only evidence but is no longer a required input under the prior contract. No schema or data rollback
is needed because this bridge introduces no Notion structure or business data mutation.
