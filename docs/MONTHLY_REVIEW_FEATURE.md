# Monthly Review — local feature review

Status: MONTHLY REVIEW FEATURE READY
Verified: 2026-09-25
Branch: feature/account-ai-budget
Recent-Trades checkpoint: cd172f4847a5516f57a969d9f8db3cfe7e854f6b (Checkpoint verified Recent-Trades Analysis feature).
The checkpoint contained exactly the 22 previously verified files. The working tree was clean immediately afterward. Monthly Review remains unstaged.

## Period and data selection

Default: previous completed calendar month according to the existing fixed UTC−5 strategy clock. Accepted month values: 2000-01 through 2099-12, strict YYYY-MM. Period is the first calendar day at 00:00 inclusive through the next first day at 00:00 exclusive, always 05:00 UTC. DST and browser-local timezone do not alter boundaries. Leap years and December/January are covered.
Only the authenticated account's CLOSED trades with exits inside that interval are selected, ordered by persisted exit ascending then UUID ascending. PostgreSQL retains microsecond precision. A current/future month is refused server-side; the browser max month is also the previous completed month.
Original plans and entries may precede the month if the trade exits inside it. Notes/events/tags must both occur and be recorded inside the selected month. Latest out-of-period tag snapshots are excluded. No unrelated months, open trades, balances, screenshots, Weekly Review text or earlier AI trade-review output are sent. Prior AI output is optional under the request and is deliberately omitted to avoid propagating unsupported interpretation.

## Bounded context strategy

Detailed mode is used for at most 30 completed trades when serialized detail is at most 96,000 bytes. It includes immutable original plans, original strategy/risk versions, entry models, session/weekday, authoritative Risk Engine results, actual executions, persisted realized R/outcome and allowed period events (including notes/tag events). Versions are deduplicated.
Above either detail limit, DETERMINISTIC SUMMARY mode uses the entire selected sample. It retains exact ordered trade IDs, sample size, original version identities, unchanged domain EDGE metrics and existing model/session breakdowns. It explicitly omits individual plan/execution detail, strategy/risk definitions, narrative and event details. Omission counts and the limitation are persisted and shown before dispatch and with saved output. No random subset, AI summarization call or automatic chunking occurs.
This reduced mode cannot establish rule/process/behavioral causes from outcomes; the prompt explicitly requires that limitation. It is a bounded statistical reflection with less process evidence than detailed mode.
Hard limits: 120 trades, 500 period events and 128,000 serialized context bytes. Exceeding a hard limit fails closed without silently truncating the month. Shared provider token enforcement remains authoritative: a request over its token envelope cannot generate even if under the byte guard.

## Operation, gate and cost

MONTHLY_REVIEW / MONTHLY_REVIEW_V1 uses the existing provider-independent registry, adapter and server-side gate. Current profile: openai / gpt-6-astra, medium effort, 32,000 maximum input tokens, 6,000 maximum output tokens, zero images and no tools.
Maximum reservation: 924,000 micro-EUR (€0.924). Existing ASTRA_EUR_2026_09_23 pricing is unchanged: conservative maximum input rate, output bound, fixed USD-cost-to-EUR-budget multiplier 1.20 and 10% reservation margin. This is estimated application budget accounting, not a live FX quote or final provider invoice.
Global enabled + provider configured + authenticated owner + account opted in + sufficient atomic reservation are required. Shared ledger checks apply before token counting and generation. Usage metadata settles estimated cost and releases unused reservation. Uncertain failures keep protected capacity. No automatic AI calls or provider retries occur.

## Output and UI

EDGE has Monthly Review alongside Weekly Review and Recent-Trades Analysis, linking to /edge/monthly. Account-scoped month selector, exact local/UTC boundaries, eligible count, detail/summary mode, reservation disclosure, OFF / ON / UNAVAILABLE / BUDGET REACHED, empty/scope/error/loading states and saved paginated history.
TRADING OS FACTS come from persisted server context. Generated output is clearly AI INTERPRETATION with MONTH SUMMARY, PROCESS QUALITY, RULE ADHERENCE, ENTRY MODEL PATTERNS, SESSION PATTERNS, EXECUTION QUALITY, BEHAVIORAL PATTERNS, RECURRING STRENGTHS, RECURRING MISTAKES, WHAT IMPROVED, WHAT DEGRADED, KEY LESSONS and FOCUS FOR NEXT MONTH. Strict bounded schema and allowed source references are validated. Small-sample limitations are displayed deterministically.
Provider/model/version, UTC generation timestamp and application estimated cost are secondary disclosures. No page-open request.

## Persistence and ownership

Existing 0011 requires Monday weeks and WEEKLY_REVIEW; 0012 requires latest-N semantics and RECENT_TRADES_ANALYSIS. Reusing them would weaken their audited operation-specific invariants. Additive 0013_monthly_ai_reviews.sql is therefore necessary.
Tables: monthly_ai_reviews and monthly_ai_review_results. Requests persist selected month, exact period boundaries, ordered trade IDs, sample size, context/hash, operation/contract snapshot, creation time and deadline. Results append with immutable provider accounting linkage. Each rerun uses a new ID; replay never dispatches again.
Service-only start/authorize/finish RPCs check account ownership, completed calendar month, exact SQL-selected trades/order/boundaries, in-flight duplicate protection, deadline, and exact owner/account/request/operation reservation. Completion requires settled usage. Backfilled monthly closes invalidate a stale prepared snapshot rather than silently dropping the new trade.
Owner-read RLS, composite ownership foreign keys, direct-write revocation and immutable triggers protect both tables. No client-submitted cost is trusted. No existing migration, Risk Engine, RR, trade locking, realized R, EDGE formula, session rule, auth/authorization or shared accounting implementation changed.
0013 was applied only inside isolated PGlite tests. No hosted database migration was applied.

## Verification

Node v24.19.0. 286/286 targeted tests pass: 113 new monthly tests plus 173 directly related regression tests. Full suite intentionally not run.
New: boundary/context/contract/gate 54; source 12; service 15; action/history data 14; database 18.
Regression: AI budget 60; budget database 31; AI disabled 15; Weekly Review contract 46; Recent-Trades database 21.
Covers ownership/cross-user/signed-out, exact month boundaries and previous-month default, leap/DST/year cases, only selected-month completed trades, microsecond/tie ordering, no late events/tags, small samples, detailed/summary scope, retained exact IDs, immutable reruns, AI OFF/configuration/budget blocks, accounting association and reconciliation, failure protection and unchanged deterministic values.
Queued 20-request reservation checks enforce €3 / €5 / €10 caps (3 / 5 / 10 accepted maximum-envelope reservations). PGlite serializes requests; this is not a native multi-connection contention test.
Strict TypeScript: pass. Lint: zero errors/warnings. Local production build: pass with OpenAI network guard. OpenAI requests attempted: zero.
Browser: actual React Shell/panel/form/server action with synthetic service boundaries, no production or provider access. Desktop 1440×1000 and mobile 393×852 browser viewport testing, not physical-device testing. Verified previous-month default, July/August selection, native current-month rejection, all disabled/empty/scope states, disabled pending button, two appended detailed reviews, one appended 60-trade summary, failure/incomplete history, all 14 sections, cost/facts disclosures, keyboard focus (2px) and alert focus (3px). No horizontal overflow, including expanded facts; bottom content accessible above navigation. Console errors/warnings: zero. Initial page and selector/state navigation generated zero submissions.
Initial browser attachment and automatic approval usage-limit errors were resolved through the normal approval/connection flow; no bypass used. No application browser defect required a correction.
Secret scan: zero findings in candidate source and built client assets; .env.local, .local, local credentials, dependencies and generated build files remain excluded.

## Remaining staging checks and production

No real provider quality or billed-cost acceptance was attempted. Existing pricing expiry still requires review before activation. Native PostgreSQL multi-connection contention and full hosted Next/Supabase integration remain staging checks.
Production was not changed, accessed for test mutations, deployed or activated. AI_ENABLED=false remains the required state; no provider keys added. Personal records untouched. No merge, rebase, main synchronization or push. New Monthly Review work unstaged.

## Files changed

- docs/MONTHLY_REVIEW_FEATURE.md
- docs/MONTHLY_REVIEW_VERIFICATION.json
- scripts/monthly-review-browser-harness.mjs
- src/ai/monthly-period.ts
- src/ai/monthly-review-context.ts
- src/ai/monthly-review-contract.ts
- src/ai/operation-contract.ts
- src/ai/operations.ts
- src/app/edge/monthly/page.tsx
- src/app/edge/page.tsx
- src/app/monthly-review-actions.ts
- src/components/monthly-review.tsx
- src/lib/monthly-review-data.ts
- src/lib/monthly-review-source.ts
- src/lib/monthly-review.ts
- supabase/migrations/0013_monthly_ai_reviews.sql
- tests/browser/monthly-review-entry.tsx
- tests/fixtures/monthly-review.ts
- tests/monthly-review-actions-data.test.ts
- tests/monthly-review-contract.test.ts
- tests/monthly-review-database.test.ts
- tests/monthly-review-source.test.ts
- tests/monthly-review.test.ts
