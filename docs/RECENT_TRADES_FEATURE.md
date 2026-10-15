# Recent-Trades Analysis — local feature review

Status: RECENT TRADES ANALYSIS FEATURE READY
Verified: 2026-09-24
Branch: feature/account-ai-budget
Weekly Review checkpoint: b6731c1b0ed63c9c0a99d75dbe7f4b58b4d7a1cb (Checkpoint verified Weekly Review feature).
New feature remains unstaged. No push, merge, rebase, deployment or hosted migration.

## Operation and cost
RECENT_TRADES_ANALYSIS / RECENT_TRADES_V1 uses the existing provider-independent gate and adapter registry. Current configured envelope: openai / gpt-6-astra, medium effort, 32,000 maximum input tokens, 6,000 maximum output tokens, zero images, no tools. Existing provider enforcement and fail-closed token handling are retained.
Maximum reservation: 924,000 micro-EUR (€0.924). Existing versioned ASTRA_EUR_2026_09_23 pricing is unchanged: conservative maximum input rate, output limit, fixed 1.20 USD-cost-to-EUR-budget multiplier, then 10% reservation margin. This is application estimated accounting, not a live exchange rate or provider invoice.
Global switch, provider configuration, authenticated owner, account opt-in and atomic budget checks all apply. Actual provider usage settles estimated cost and releases unused reservation. Uncertain failure retains protected capacity. No automatic calls or retries.

## Selection and context
Default 20; permitted choices 10, 20, 30. Only completed trades with a persisted outcome are eligible, across calendar weeks. Selection uses persisted exit timestamp descending with PostgreSQL microsecond precision, then UUID ascending for exact ties. Capture time is server UTC; entry session/weekday use the existing fixed UTC−5 domain convention. No browser-local selection boundary.
The server refreshes the sample on explicit submission. The start RPC independently verifies exact selected IDs and ordering, failing closed if the sample became stale. A smaller available sample is displayed and saved exactly; zero trades cannot dispatch.
Only selected trades' immutable plans, original strategy/risk versions, entry models, original deterministic decision, execution, persisted realized R/outcome, current manual tags and recorded events/notes are supplied. Versions are deduplicated. The existing domain metrics function supplies sample EDGE values without new formulas. Session and weekday come from the existing domain enrichment function.
No screenshots, open trades, other trades, account balances, full Journal, unrelated periods or prior AI output are included. The eligible total is UI-only. More than 300 selected events or 128,000 serialized context bytes fails closed without truncating evidence.
SAMPLE and TRADING OS FACTS render from server records. Eight separate AI interpretation sections cover strengths, execution mistakes, models, sessions, risk/process discipline, behavior, outliers and next monitoring steps. References must identify supplied sources. Strict output validation rejects extra authority fields; prompts prohibit fabricated facts, signals, changing rules or treating outcome as proof of process. All samples receive explicit limitations.

## Persistence and security
Migration 0011 requires a Monday calendar week and the WEEKLY_REVIEW operation. It cannot safely represent a latest-N sample. Additive migration 0012_recent_trades_analyses.sql therefore follows the existing account-level request/result pattern without altering earlier migrations.
Tables: recent_ai_analyses and recent_ai_analysis_results. Immutable request metadata includes requested/actual sample size, ordered exact trade IDs, captured facts/hash, operation/contract snapshot, creation time and deadline. Results append with provider accounting linkage; reruns get new request IDs. Existing request IDs cannot dispatch twice.
Service-only start/authorize/finish RPCs enforce ownership, exact sample identity, one in-flight analysis per account, reservation association and settled usage before successful completion. Owner-only SELECT RLS, composite ownership foreign keys and mutation-rejection triggers protect history. Direct client/service writes are revoked. No client monetary input is trusted.
Existing budget, auth, ownership, Risk Engine, RR, locking, realized R and EDGE formulas are unchanged.

## UI
EDGE links to /edge/recent alongside Weekly Review. Account-scoped 10/20/30 selector, eligible/actual counts, €0.924 disclosure, OFF / ON / UNAVAILABLE / BUDGET REACHED, scope/empty states, pending/error/completed results and paginated immutable history. Provider/model/version/UTC timestamps/estimated cost are secondary disclosures.
No provider call occurs on page load. Choosing Show sample only loads records.

## Verification
Node v24.19.0. Focused tests: 272/272 pass (103 new feature tests; 169 relevant regression tests). Full suite intentionally not run.
New tests: contract/context/gate 35; source selection 18; service 15; actions/history data 14; database 21.
Regression tests: budget 60; budget database 31; AI disabled 15; weekly contract 46; weekly database 17.
Initial combined parallel database setup timed out; the same tests passed with one worker, without weakened assertions/timeouts.
Strict TypeScript: pass. Lint: zero errors/warnings. Production build: pass locally with OpenAI network blocking preload. Zero OpenAI requests attempted.
RLS/cross-user, exact sample ordering (including microsecond/tie cases), open/future exclusion, safe defaults, missing configuration, insufficient budget, append-only history, exact reservation association, settlement and failure accounting covered.
Queued 20-reservation tests admit only 3 / 5 / 10 maximum-envelope requests for €3 / €5 / €10 caps (€2.772 / €4.620 / €9.240 reserved). PGlite serializes queued work: this validates SQL/gate safety and is not a multi-connection hosted PostgreSQL load test.
Browser: real React panel, Shell, ActionForm and server-action code with synthetic service boundaries. Desktop 1440×1000 and mobile 393×852 viewport checks passed; no physical-device testing. Verified default/sample choices, fewer sample (7/20), disabled/scope/empty states, pending disabled button, two explicit successful reruns preserving separate IDs, failed/in-progress/incomplete history, metadata, disclosures and error focus. Document scroll width equals client width (1425 desktop; 378 mobile excluding scrollbar), including expanded facts. Keyboard focus outlines 2px, error alert focus 3px. Bottom content remains reachable above navigation; console errors/warnings zero. No automatic submissions on initial load. Three mocked accepted submissions total (two completed and one failed); no provider access.
Browser attachment initially timed out; attaching an existing tab resolved it. No application defect remained.
Secret scan checks configured private values and credential patterns in repository candidates and built client assets. Zero findings. Environment/local credentials, dependencies and generated artifacts remain excluded.

## Limits and staging prerequisites
No real provider quality/cost acceptance was attempted. Existing reviewed pricing expiry still applies. Migration 0012 was tested in isolated PGlite only and remains unapplied to hosted databases. Staging should exercise native PostgreSQL multi-connection contention and full Next/Supabase integration before production activation. This local feature-ready result does not authorize staging, deployment or activation.
Production was not accessed or changed; AI_ENABLED=false remains the required state. Personal records untouched. Main/origin synchronization remains deferred and unchanged.

## File manifest

- docs/RECENT_TRADES_FEATURE.md
- docs/RECENT_TRADES_VERIFICATION.json
- scripts/recent-trades-browser-harness.mjs
- src/ai/operation-contract.ts
- src/ai/operations.ts
- src/ai/recent-trades-context.ts
- src/ai/recent-trades-contract.ts
- src/app/edge/page.tsx
- src/app/edge/recent/page.tsx
- src/app/recent-trades-actions.ts
- src/components/recent-trades.tsx
- src/lib/recent-trades-data.ts
- src/lib/recent-trades-source.ts
- src/lib/recent-trades.ts
- supabase/migrations/0012_recent_trades_analyses.sql
- tests/browser/recent-trades-entry.tsx
- tests/fixtures/recent-trades.ts
- tests/recent-trades-actions-data.test.ts
- tests/recent-trades-contract.test.ts
- tests/recent-trades-database.test.ts
- tests/recent-trades-source.test.ts
- tests/recent-trades.test.ts
