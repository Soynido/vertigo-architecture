# @vertigo/mail-executor — deterministic Mail Executor (PV0-019A)

The **only** path for automated / pre-approved production Gmail sends (PLUGIN_SPEC/0.2.0 §10). No LLM. The
harness never sends; ChatGPT never holds the send credential; the executor accepts an immutable reference set and
decides from fresh canonical reads.

## Invocation surface

```
pnpm --filter @vertigo/mail-executor execute -- --intent-ref <page id> --action-key <key> [--attempt-id <id>]
```

Any other argument (recipient, subject, body, mode, force, skip…) is refused before anything is read. Exit codes:
`0` SENT_AND_OBSERVED / ALREADY_OBSERVED, `3` REFUSED, `4` HOLD or readback pending, `2` invalid invocation or
missing configuration. The full decision (checks, evidence, effect ids) is printed as JSON.

## Deterministic T-0 checks (in order, all fresh)

1. exact eligible durable ExternalActionIntent matching `action_key` (PREPARED/APPROVED, inside its window, complete);
2. harness FINAL verification of the intent transaction (plan FINAL_VERIFIED + FINAL receipt for this action key);
3. effective Authority = strictest of pinned and currently published constraints (action type, max step, pause);
4. HUMAN_APPROVAL valid for this exact content hash and not expired, whenever the effective Authority or the intent requires it;
5. exactly one ACTIVE Enrollment for the Contact, and it is the intent's Enrollment / sequence;
6. Contact + Account DNC / opt-out / bounce / hold (UNKNOWN refuses);
7. ownership on intent, Contact and Enrollment; no coordination lock;
8. competent-source (Gmail) mailbox identity equals the intent's mailbox;
9. exact thread at T-0: no HUMAN / UNKNOWN inbound since the intent was prepared (TECHNICAL auto-replies do not block);
10. no already-observed effect for the action key (OBSERVED ⇒ ALREADY_OBSERVED, no send; AMBIGUOUS ⇒ HOLD);
11. no manual / newer outbound to the recipient since the intent was prepared;
12. content resolves from its durable ref and matches the verified hash.

Any UNKNOWN / HOLD / VIOLATION / ambiguity ⇒ **REFUSE SEND**, transport not called.

## Concurrency / idempotency

`executor_actions` (PostgreSQL, `migrations/001_executor.sql`) holds one row per `action_key`. `acquire` is a single
atomic `INSERT … ON CONFLICT … WHERE`, so two chats / retries cannot both hold the key. States after the transport
was reached (`SENDING`, `SENT_PENDING_READBACK`, `AMBIGUOUS_TRANSPORT`, `OBSERVED`) are never re-acquirable: a later
attempt only reconciles from Gmail and never replays. `REFUSED`, `FAILED` and an expired pre-send `CHECKING` lease are
re-acquirable, and the new attempt re-runs every check.

## Send + readback

Only after every check passes is the protected transport invoked (Gmail REST `users.messages.send`, bearer token
from `MAIL_EXECUTOR_GMAIL_ACCESS_TOKEN`). The effect is complete only when the competent source reads the message
back (`message_id`, `thread_id`, timestamp, recipient, mailbox identity). Transport outcomes: 2xx with ids ⇒ SENT;
4xx ⇒ FAILED; 5xx / network / timeout ⇒ AMBIGUOUS (reconcile before anything else).

## Configuration (deployment environment only)

| Variable | Role |
| --- | --- |
| `NOTION_READ_TOKEN` | read-only Notion integration (same least-privilege credential as the harness) |
| `HARNESS_DATABASE_URL` | harness store (plans / receipts) — read for verification truth |
| `MAIL_EXECUTOR_DATABASE_URL` | executor ledger (may be the same database) |
| `MAIL_EXECUTOR_GMAIL_ACCESS_TOKEN` | protected Gmail credential for the runtime's mailbox — never exposed to the harness or to chat |
| `MAIL_EXECUTOR_SALES_GRAMMAR_FILE` | local JSON mapping the canonical Sales property names (`SalesGrammar`); unmapped ⇒ UNKNOWN ⇒ refuse |

Security: the credential lives only in the executor's environment; the harness package has no dependency on this
package and no Gmail send path (PT-GMAIL-015). Rotate the token on any exposure. Production deployment and the live
golden path (PT-REL-*) are human-gated.
