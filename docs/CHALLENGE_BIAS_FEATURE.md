# Challenge my bias — local feature review

Status: **CHALLENGE BIAS FEATURE READY**

Implemented and verified on `feature/account-ai-budget`, HEAD `79ab1496bf0cb8e1807f3b83ef3c6ca96cf404bb`. No staging, commit, push, deployment, production migration, production environment change or live provider request. AI remains disabled. Final workspace check: 2026-09-24.

## Persistence decision

Migration 0009 was inspected first. Its requests require a non-null locked trade and a recorded closed outcome; its operation constraint only permits REVIEW_TRADE. Reusing it for an unlocked proposal would weaken that contract. The older setup evaluation completion RPC also requires an AI approval-style decision, which is deliberately excluded from this feature.

Migration **0010_bias_challenges.sql** therefore adds proposal-linked history while leaving 0008, 0009 and all existing deterministic tables/functions unchanged:

- `bias_challenges`: immutable owner/account/proposal identity, input facts/hash, operation and prompt/schema snapshot, created/deadline timestamps.
- `bias_challenge_results`: append-only completed/failed result, interpretation, raw output/error and reservation reference; one terminal result per request.
- `start_bias_challenge`: service-only; checks owner, serializes on the same account row used by locking, rejects an already locked proposal and overlapping in-flight challenges. Replayed request IDs cannot spend again.
- `authorize_bias_challenge`: service-only; rechecks owner, deadline, unfinished status, absence of a locked plan and selected evidence ownership/hash/removal state.
- `finish_bias_challenge`: service-only; checks owner and exact challenge/operation reservation binding. COMPLETED requires settled usage. Results cannot overwrite earlier attempts.

Both tables have owner-only SELECT RLS; anonymous access and direct writes by browser/service roles are denied. Immutable triggers reject UPDATE/DELETE. Trusted RPCs are the only write path. A challenge remains associated with the saved proposal after the existing setup_locks relationship links that proposal to a trade. Earlier challenges remain visible on its Analyze page.

## Operation and accounting

Dedicated operation/contract: **CHALLENGE_BIAS / CHALLENGE_BIAS_V1**. The existing SETUP_CHALLENGE is an internal deep setup-evaluation pass and has different output semantics.

| Setting | Bound |
| --- | --- |
| Provider / model | Existing OpenAI adapter / gpt-6-astra |
| Reasoning | Medium |
| Input | 16,000 tokens, including instructions/schema/images |
| Output | 4,000 tokens, including reasoning usage |
| Selected images | At most 3; text-only allowed |
| Tools | None |
| Maximum reservation | **€0.528** |
| Pricing profile | Existing ASTRA_EUR_2026_09_23 |

The reservation uses existing centralized pricing, the fixed 1.20 USD-cost-to-EUR-budget multiplier and a 10% safety margin. No rate or FX policy was changed. No new provider integration or credentials were introduced.

The existing global/account/configuration/budget gate authorizes every request. The extra proposal/evidence guard runs before reservation, dispatch and generation. Atomic accounting remains unchanged. Provider token counting enforces the input limit before generation; the actual request enforces the output limit and image/tool envelope. Returned usage reconciles the estimate and releases unused reservation. Unknown usage/failure retains the protected hold and existing uncertainty lockout; there is no automatic retry. A provider failure or invalid output can still incur a reconciled cost.

A lock that happens during an already dispatched generation does not cancel or alter the sealed plan. The earlier input snapshot and eventual result are saved as advisory history. Generation never calls the locking, proposal mutation or risk-calculation functions.

## Exact context supplied

Only the current saved proposal and its explicitly selected evidence are serialized:

- Proposal ID, creation time, instrument symbol, LONG/SHORT bias, OB_FIRST_TOUCH/OTE entry model, entry/stop/target, requested risk percent, news and contract-confirmation status.
- The original narrative as `currentThesis`, explicitly labeled user-reported and unverified.
- Recorded strategy ID/version/rules/written rules.
- The selected latest saved deterministic risk-check ID/timestamps, engine version, trading day/session, strategy/risk-plan version IDs and risk-plan version label, unchanged status, WARN/BLOCK findings, calculations and rule results where present.
- Selected evidence ID, assigned role, checksum, MIME type and byte size; only those images are downloaded from private storage through the authenticated user client and hash/size checked.
- Version, capture timestamp, allowable source references and a context policy explaining that unrecorded pre-market/liquidity information is unverified.

No other proposals, historical trades, Journal, EDGE, old AI output, account observation/balance/equity snapshots, private storage paths, filenames or unselected images enter the provider context. Existing pre-market and liquidity information is used only where recorded in the thesis or selected evidence; no new facts or market data are invented. Serialized facts are capped at 64 KB before the provider's token count.

## Output and UI

The explicit **Challenge my bias** action is on the saved proposal's Analyze page before locking. Opening the page never invokes AI. The panel shows **AI ADVISORY — NOT RISK ENGINE**, the authoritative saved risk permission, maximum reservation, OFF / ON / UNAVAILABLE / BUDGET REACHED states, locked state, insufficient-budget message, unchecked evidence choices, pending disabled controls, focused form errors and preserved history.

Completed output separates:

1. FACTS FROM TRADING OS — server-preserved snapshot and risk status.
2. YOUR CURRENT THESIS — original user narrative, not model-generated facts.
3. COUNTER-ARGUMENT.
4. WHAT COULD INVALIDATE THE SETUP.
5. WHAT EVIDENCE IS MISSING / UNVERIFIED.
6. QUESTIONS TO ANSWER BEFORE LOCKING.

A strict schema permits only advisory text/source references for the last four sections. Unknown sources, extra decision/permission/price/proposal/lock fields and explicit take/enter/execute-the-trade directives are rejected. Prompt instructions require uncertainty, scrutiny of confirmation bias and contradictions, and no replacement risk/sizing/prices. Natural-language quality is not proven by schema validation; the model cannot change permission or stored values regardless of its text. Output is escaped React text.

Secondary details show provider/model/version/time, reservation and application-side estimated cost, explicitly not a provider invoice. New runs append; failures and incomplete requests survive. History is paginated in groups of ten. Disabling AI or locking a proposal preserves read access to history. Missing AI tables/configuration disables only the optional panel.

## Verification

Node **24.19.0**. **234/234 targeted tests passed**, including **62 new tests**. No full suite rerun.

| Test file | Passed |
| --- | ---: |
| bias-challenge.test.ts | 18 |
| bias-challenge-contract.test.ts | 22 |
| bias-challenge-database.test.ts | 11 |
| bias-challenge-actions-data.test.ts | 11 |
| ai-budget.test.ts | 60 |
| ai-budget-database.test.ts | 31 |
| ai-disabled.test.ts | 15 |
| setup-ai.test.ts | 26 |
| trade-review-contract.test.ts | 12 |
| trade-review-database.test.ts | 9 |
| trade-review.test.ts | 19 |

Coverage includes owner/signed-out denial, account/global OFF, missing provider configuration, insufficient budget before dispatch, current-context isolation, selected evidence, pre-lock reauthorization, rejected AI mutation/decision fields, unchanged blocked risk status and failed deterministic lock after a challenge, immutable append-only history, replay protection, accounting linkage and reconciliation.

Local PGlite/PostgreSQL tests applied all migrations in an isolated in-memory database. Twelve queued €0.528 reservations under a €5 cap admitted nine (€4.752 held), rejecting the rest. Six queued starts for one proposal admitted one. These are queued database tests, not a new native multi-connection stress test; the previously tested account locking/accounting implementation is unchanged.

Strict TypeScript: pass. Lint: pass, zero errors/warnings and 30 existing informational messages. Local default Turbopack production build: pass after removing its corrupted generated cache. Build preload forced AI off and recorded **0 OpenAI requests attempted**. Existing tracked tests remain unchanged.

Browser acceptance: actual component, ActionForm, Server Action and stylesheet on a loopback harness; synthetic service responses only. **1440×1000 desktop** and **393×852 phone** passed. Verified explicit selected/text-only submissions, loading/disabled controls, exact one-line reservation amount, preserved BLOCKED permission, all six response sections, metadata, OFF/unavailable/budget/locked states, preserved reruns/failures/incomplete attempts, expanded facts, no horizontal overflow or clipped text, visible keyboard focus and focus on announced form errors. No browser errors/warnings were captured. This is viewport testing, not a physical device or hosted Supabase acceptance test.

Secret scan of candidate source and fresh browser build assets: zero findings. Private environment/local credential files remain excluded. Protected Risk Engine, RR, position sizing, risk, trade locking, realized R, EDGE, strategy/session rules, authentication, authorization and existing screenshot security: **unchanged**.

## Files added or changed for this feature

- `src/ai/operations.ts`, `src/ai/operation-contract.ts`
- `src/ai/bias-challenge-context.ts`, `src/ai/bias-challenge-contract.ts`
- `src/lib/bias-challenge.ts`, `src/lib/bias-challenge-data.ts`
- `src/app/bias-challenge-actions.ts`, `src/app/analyze/[id]/page.tsx`
- `src/components/bias-challenge.tsx`
- `supabase/migrations/0010_bias_challenges.sql`
- `tests/bias-challenge.test.ts`, `tests/bias-challenge-contract.test.ts`, `tests/bias-challenge-database.test.ts`, `tests/bias-challenge-actions-data.test.ts`
- `tests/fixtures/bias-challenge.ts`, `tests/browser/bias-challenge-entry.tsx`, `scripts/bias-challenge-browser-harness.mjs`
- `docs/CHALLENGE_BIAS_FEATURE.md`, `docs/CHALLENGE_BIAS_VERIFICATION.json`

## Local sync recovery and remaining release limits

During implementation, external sync reverted eight prior feature files and the Git checkout, leaving their verified contents in `-Max` conflict copies. Both variants were preserved in ignored `.local/sync-recovery-bias/`; the verified account-budget/review versions were restored without refactoring. The requested feature branch was restored with a normal Git switch. The two files that blocked checkout matched its tracked blobs exactly and were backed up first. An identical duplicate test was archived. Generated Turbopack cache corruption was cleared; no source or trading data was deleted. Final branch/source integrity was rechecked on 2026-09-24.

Local `main`/`origin/main` refs were also reverted by sync, with newer `-Max` refs left behind. They were not rewritten or pushed by this task. Reconcile them against GitHub and prevent further folder sync conflicts before any later staging/release. No conclusion about remote ref changes was inferred from those local refs.

All migrations remain local. No production changes or AI activation occurred. Hosted staging/SSR/storage acceptance and real-provider response quality, latency and billed cost have not been tested; they require separate authorization. Review the pricing validity and account opt-in/budget before any future activation.
