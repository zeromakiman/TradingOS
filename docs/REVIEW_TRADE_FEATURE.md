# REVIEW THIS TRADE — local feature review

Status: **REVIEW TRADE FEATURE READY**

Branch: `feature/account-ai-budget`. Local, unstaged implementation only. Production and its environment were not changed. `AI_ENABLED=false` remains in local configuration and production was not activated. No real provider request was made.

## Operation and authoritative gate

The setup operations evaluate proposed setups; their semantics do not match post-trade review. The dedicated `REVIEW_TRADE` operation uses contract/version `REVIEW_TRADE_V1` in the existing central registry:

| Setting | Bound |
| --- | --- |
| Provider / model | Existing OpenAI adapter / `gpt-6-astra` |
| Reasoning | Medium |
| Input | 24,000 tokens, including prompt/schema and selected images |
| Output | 6,000 tokens, including reasoning usage |
| Images | At most four explicitly selected, owner-accessible PNG/JPEG/WebP images |
| Tools | None |
| Pricing | Existing versioned `ASTRA_EUR_2026_09_23` profile |
| Safety margin | 10% |
| Maximum reservation | **€0.792** |

This reuses the existing fixed USD-cost-to-EUR-budget multiplier of 1.20. No pricing rates or accounting policy changed. The amount is an application-side estimate, not a provider invoice. Pricing expiry and configuration checks remain fail-closed.

Flow: authenticate and load the owned closed trade → check account/operation availability → preserve the bounded input snapshot → atomically reserve account budget → authorize dispatch → count the immutable provider input → enforce input limit and reauthorize → bounded generation → account for returned usage → validate interpretation → append result. The adapter selects its prompt/schema from the operation's trusted contract. No automatic invocation occurs on a page visit.

The existing global master switch, opt-in, privileged accounting RPCs, account locks, single-use dispatch permits, usage reconciliation and fail-safe uncertainty policy remain in force. A known-usage response releases unused reservation; missing/uncertain usage retains the full reservation and blocks additional spending under the existing policy. A provider refusal or invalid review can still have a reconciled charge. There is no automatic provider retry.

## Context and advisory boundary

Only the selected trade is loaded: sealed original plan, exact recorded strategy/risk versions, entry model and planned prices, recorded deterministic risk result/session, actual execution, realized R/outcome, current tags, this trade's notes/events and optionally selected evidence. Event payloads are allowlisted. Unrelated trade/account history, account balance/equity snapshots, storage paths and filenames are excluded from the provider context. The context is limited to 200 events and 128 KB of serialized facts, followed by authoritative provider token counting.

Selected images are located through the trade's owner-scoped setup link. Removed/foreign images are rejected. Private storage is downloaded using the authenticated user's client, and byte length/hash must match the stored metadata before dispatch. Unchecked evidence is never downloaded for review.

`FACTS FROM TRADING OS` displays the immutable stored input snapshot. `AI INTERPRETATION` is separately validated structured output covering adherence, execution, model fit, discipline, deviations, possible behavioral mistakes, lessons and limitations. Every observation cites an allowed source from this trade. The model cannot supply authoritative numeric result fields. Output is rendered as escaped text, not HTML.

Risk Engine, RR, sizing, locking, realized R, EDGE formulas, session rules, authentication, authorization and existing screenshot security code: **unchanged**. AI interpretations can be mistaken; they never write back to these systems.

## Persistence and ownership

New migration: `supabase/migrations/0009_trade_ai_reviews.sql`, dependent on local budget migration 0008. Neither was applied to production.

- `trade_ai_reviews`: immutable owner/account/trade binding, input facts/hash, operation and prompt/schema snapshot, timestamps/deadline.
- `trade_ai_review_results`: one immutable completed/failed result per request, validated interpretation, error code/raw output and matching reservation reference.
- `start_trade_ai_review`: service-only, validates owner and recorded closure; locks the plan; rejects concurrent in-flight review starts; replaying a request ID returns without spending again.
- `finish_trade_ai_review`: service-only, verifies owner and exact review/reservation relationship; completion requires settled usage. Duplicate terminal results cannot overwrite history.
- Authenticated users have owner-only SELECT through RLS. Anonymous clients cannot read. Browser roles and service-role direct writes cannot bypass the RPCs. Mutation triggers prevent UPDATE/DELETE.

New runs use new request IDs. Failed and incomplete attempts remain visible; timeouts retain protected accounting and never silently retry. History is paginated in groups of ten. Existing reviews remain readable with AI OFF. Missing AI tables/configuration produces an AI-panel message and leaves the rest of Trade Detail available.

## Trade Detail UI

Owner-only action for a closed trade, exact maximum reservation before submission, explicit evidence checkboxes (unchecked initially), OFF / ON / UNAVAILABLE / BUDGET REACHED presentation, insufficient-reservation messaging, disabled controls while pending, focused form errors, preserved completion/failure history and secondary provider/model/time/cost details. Form submission keys rotate only after terminal recorded attempts. The page's Server Actions have a 300-second platform execution ceiling; a terminated request remains incomplete with its accounting protected.

The browser test found a mobile layout defect in the shared flex notice styling, which split the reservation amount vertically. The review notice now uses block flow and a nonwrapping amount; the fix was retested at 393×852.

## Verification

Node **24.19.0**. **221/221 targeted tests passed** across eleven files, comprising 53 new review tests and 168 relevant existing tests. The full 519-test baseline suite was **not rerun**.

| File | Passed |
| --- | ---: |
| trade-review.test.ts | 19 |
| trade-review-contract.test.ts | 12 |
| trade-review-database.test.ts | 9 |
| trade-review-actions.test.ts | 7 |
| trade-review-data.test.ts | 6 |
| ai-budget.test.ts | 60 |
| ai-budget-database.test.ts | 31 |
| ai-disabled.test.ts | 15 |
| ai-settings.test.ts | 18 |
| ai.test.ts | 18 |
| setup-ai.test.ts | 26 |

Strict TypeScript: pass. Lint: pass, zero errors/warnings; 30 existing informational diagnostics. Local production build: pass, with AI forced off and provider traffic blocked. OpenAI requests attempted: **0**. Existing tracked tests were not changed.

Local PostgreSQL/PGlite tests applied all migrations in an isolated in-memory database. They verified RLS/cross-user denial, direct-write restrictions, immutable history, replay protection, exact reservation linkage, reconciliation and unchanged original trade/analytics rows. Twelve queued €0.792 reservation attempts under a €5 cap admitted six (€4.752 held) and rejected six; six queued starts on one plan admitted one. These new database tests are queued PGlite tests, not a new native multi-connection stress test. The existing account reservation lock was not changed; its prior native concurrency verification remains documented in AI_BUDGET_REVIEW.md.

Browser acceptance used the actual component, ActionForm, Server Action and stylesheet on a loopback harness, with synthetic service responses. Desktop **1440×1000** and phone **393×852** passed: explicit selected/text-only submissions, pending disabled controls, completion, reruns preserving history, saved failures, OFF/unavailable/insufficient-budget/open-trade blocks, incomplete attempts, expanded facts/cost metadata, keyboard action focus and focused error announcements. No horizontal overflow remained; expanded content was not clipped. This was browser viewport testing, not physical-device or hosted Supabase acceptance. Browser state/history tests were supplemented by the real local SQL/RLS tests above; the browser harness itself does not contact Supabase or any provider.

Secret scan: zero findings in candidate source and fresh build browser assets; `.env.local`, `.local/` and test-user credentials remain excluded. Protected deterministic/auth/storage files and migrations 0001–0007 remain unchanged. Nothing staged or deployed.

## Files added or changed for this feature

- `src/ai/operations.ts`, `src/ai/provider.ts`, `src/ai/operation-contract.ts`
- `src/ai/trade-review-contract.ts`, `src/ai/trade-review-context.ts`
- `src/lib/ai-budget.ts`, `src/lib/trade-review.ts`, `src/lib/trade-review-data.ts`
- `src/app/trade-review-actions.ts`, `src/app/journal/[id]/page.tsx`
- `src/components/trade-ai-review.tsx`
- `supabase/migrations/0009_trade_ai_reviews.sql`
- `tests/trade-review.test.ts`, `tests/trade-review-contract.test.ts`, `tests/trade-review-database.test.ts`, `tests/trade-review-actions.test.ts`, `tests/trade-review-data.test.ts`
- `tests/fixtures/trade-review.ts`, `tests/browser/trade-review-entry.tsx`, `scripts/trade-review-browser-harness.mjs`
- `docs/REVIEW_TRADE_FEATURE.md`, `docs/REVIEW_TRADE_VERIFICATION.json`

The branch also contains the earlier unstaged account-budget work; that prior scope is recorded separately.

## Before any production activation

Independent review and authorized staging remain necessary: apply migrations 0008/0009 only in the approved isolated environment, verify real SSR/RLS/storage wiring there, review the current pricing profile/provider configuration, and perform a separately authorized bounded live-provider acceptance if desired. Model response quality and real provider billing/latency were not tested. Production activation and deployment are not authorized by this implementation task.
