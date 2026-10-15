# Analyze setup — local feature review

Status: **ANALYZE SETUP FEATURE READY**. Verified 2026-09-24 in C:/ChatGPT/Trading, branch feature/account-ai-budget, HEAD 79ab1496bf0cb8e1807f3b83ef3c6ca96cf404bb. All work remains unstaged. Production, production configuration and hosted databases were untouched; AI remains disabled. No live provider requests.

## Purpose and operation

ANALYZE_SETUP objectively organizes and assesses one current proposal; CHALLENGE_BIAS deliberately challenges its thesis. They have distinct prompts and strict output contracts. No automatic request on page load. The legacy SETUP_ANALYSIS evaluator is unchanged and is not reused as this new advisory operation.

Dedicated ANALYZE_SETUP_V1: OpenAI / gpt-6-astra, medium effort, maximum 16,000 input tokens (including prompt, schema and selected evidence), 5,000 output tokens including reasoning, three images, no tools. The existing provider counts the identical input before generation and rejects excess input. Actual generation enforces the output ceiling. The registry is server-controlled; unknown operations are rejected.

The maximum reservation is **€0.594**: (16,000 × $12.50/M conservative input + 5,000 × $50/M output) × fixed 1.20 USD-cost-to-EUR-budget multiplier × 1.10 safety margin. Pricing remains centralized in ASTRA_EUR_2026_09_23, expiring 2026-10-22. This is an application estimate, not a final provider invoice or live FX quote. At maximum reservation a €3/€5/€10 cap covers 5/8/16 operations before reconciliation; settled lower usage releases remaining capacity.

## Exact context allowlist

Reuse the current-proposal allowlist from biasChallengeContext with an ANALYZE_SETUP_FACTS_V1 snapshot version:

- Proposal id and creation timestamp; instrument symbol; direction; entry model; entry, stop, target, requested risk percentage; news flag; contract confirmation.
- User-recorded thesis. Pre-market and liquidity context only where recorded there or present in explicitly selected evidence; otherwise unverified.
- Strategy id/version, structured rules and written definition.
- Saved deterministic evaluation id/time/engine version, trading day, recorded session, strategy/risk-plan version ids and risk-plan label, permission, WARN/BLOCK findings, original calculations including planned RR, and rule results when present.
- Selected image id, role, content hash, MIME type and byte size; only selected private image bytes are downloaded. Ownership, removal state, length and hash are checked.
- Context policy, capture timestamp and allowed source references.

No unrelated proposals, Journal, EDGE, previous AI outputs, account equity/snapshots, storage paths or unselected screenshot bytes are sent. A 64 KB serialized facts limit adds a local bound before dispatch.

## Authority and response

The application displays TRADING OS FACTS and RISK ENGINE STATUS from the immutable snapshot, not from model-generated fields. AI output is strictly separated into SETUP STRUCTURE, ENTRY MODEL ASSESSMENT, CONFLUENCES, WEAKNESSES / MISSING EVIDENCE, INVALIDATION and AI OBSERVATIONS. The original thesis is labeled user-reported and unverified.

Strict parsing rejects unknown fields such as decisions, prices, RR, risk and lock commands, unknown source references, and common direct trading instructions. Evidence availability must match the actual selection. No selected images produces a deterministic visible missing-evidence notice. Prompt instructions restrict model assessment to the supplied OB_FIRST_TOUCH/OTE strategy, prohibit invented ICT rules, market data and liquidity events, and require unknown evidence to be described as missing.

These measures constrain structure and authority; they cannot mathematically prove every natural-language assertion is accurate. Live model quality was not evaluated. Generated content is escaped text and never updates proposal/risk/locking records. Risk Engine, RR, sizing, session rules, trade locking, realized R and EDGE formulas changed: **NO**.

## Gate, accounting and history

The owner-scoped loadSetup authenticates each request. Locked proposals, global OFF, account OFF, missing provider/accounting configuration, exhausted budget or insufficient reservation cannot dispatch. The existing single budget gate owns counting/generation, account-row atomic reservations, reauthorization and actual-usage reconciliation. The request rechecks owned/unlocked proposal and evidence before reservation, dispatch and generation.

0010 is still local/unapplied to hosted databases. Extend its existing bias_challenges / bias_challenge_results tables and start/authorize/finish RPCs instead of adding another migration. Legacy names remain for compatibility. The database accepts only CHALLENGE_BIAS and ANALYZE_SETUP. Existing owner-only SELECT RLS, denied direct writes and immutable triggers remain. RPCs remain service-only. One in-flight action per proposal serializes both operation types. Replaying an id under another operation is rejected. A result's reservation must belong to the same owner/account/request and operation; completion requires reconciled usage.

Each explicit rerun has a new UUID and appends a new request/result. Completed, failed and incomplete attempts remain visible even after opt-out or locking. Panels filter history by operation. Failure after dispatch retains conservative accounting where usage is uncertain; known usage is reconciled even when output validation fails. Persistence failure never triggers an automatic retry. A generation completed after concurrent locking only saves advisory history, never changes the sealed plan.

## UI and browser acceptance

A distinct Analyze setup panel appears before plan locking in the saved New Trade / Analyze workflow, alongside Challenge my bias. It provides reservation disclosure, explicit selected evidence, ON/OFF/UNAVAILABLE/BUDGET REACHED states, locked state, disabled controls, pending feedback, focused errors, completed/failed/incomplete history, pagination, and secondary provider/model/time/estimated-cost details. The advisory/authority label and deterministic BLOCK status remain prominent.

Browser acceptance used the actual component, ActionForm and server action with an isolated synthetic service on loopback port 3118, external network blocked. Desktop 1440×1000 and requested phone viewport 393×852 passed; browser viewport testing, not a physical device. No horizontal page overflow, including expanded facts. Keyboard focus was visible on checkbox/button; error alert received focus. Explicit selected-evidence submission, text-only rerun and failed run preserved two completed results plus one failure. No console errors/warnings or provider calls. This was not a hosted Supabase/SSR end-to-end acceptance test.

## Tests

**271/271 targeted tests passed**, including 77 new Analyze setup tests. Full suite was not run. The existing bias action-data expectation was extended to require operation filtering; no existing assertions were removed or weakened.

- tests/analyze-setup-actions-data.test.ts: 11/11
- tests/analyze-setup-contract.test.ts: 31/31
- tests/analyze-setup-database.test.ts: 17/17
- tests/analyze-setup.test.ts: 18/18
- tests/bias-challenge-actions-data.test.ts: 11/11
- tests/ai-budget-database.test.ts: 31/31
- tests/ai-budget.test.ts: 60/60
- tests/ai-disabled.test.ts: 15/15
- tests/bias-challenge-contract.test.ts: 22/22
- tests/bias-challenge.test.ts: 18/18
- tests/bias-challenge-database.test.ts: 11/11
- tests/setup-ai.test.ts: 26/26

TypeScript strict: PASS. Lint: PASS, informational style diagnostics only. Local production build: PASS, Node 24.19.0, with OpenAI blocked and zero attempts. Secret scan: no configured private values or credential-shaped findings in candidate source or fresh browser assets; .env.local, .local and test credentials excluded. Protected deterministic/auth/storage/CSV core, package.json and pnpm-lock.yaml unchanged.

Database/RLS tests run fresh migrations only in isolated PGlite. They cover ownership, anon/cross-user access, immutable history, operation replay/mixing, exact accounting linkage, selection ownership, locked-state races and unchanged blocked risk outcomes. Twelve queued €0.594 reservations under a €5 cap admitted eight, holding €4.752; four rejected. Same-proposal starts admit one; mixed operations share this protection. This is not a new native parallel-connection benchmark; the existing account-lock mechanism was unchanged.

## Workspace recovery and Git issue

The user moved the project from OneDrive to C:/ChatGPT/Trading during implementation. Six route files were absent in the new folder. Each was copied only after checking destination absence, then SHA-256 compared with its source; no existing destination was overwritten. Recovered:

- src/app/analyze/[id]/page.tsx — unstaged account-budget/bias integration; subsequently added this feature's panel wiring.
- src/app/journal/[id]/page.tsx — unstaged trade-review integration; matches saved verified-feature hash.
- src/app/api/screenshots/[id]/route.ts — identical to HEAD.
- src/app/api/setups/[id]/analyze/route.ts — identical to HEAD.
- src/app/api/setups/[id]/screenshots/route.ts — identical to HEAD.
- src/app/edge/export/route.ts — identical to HEAD.

The three API routes retained identical timestamps, lengths and hashes in both folders at the second comparison. The other old copies disappeared during the continuing move before a repeat comparison; the immediate copy-time checks had passed. Seven prior modified feature files match the saved verification manifest. Recovery status reported before further work: 8 modified tracked files and 67 untracked files (75 total, including existing work and Analyze setup drafts), 0 deleted, 0 staged. The earlier untracked count mistakenly included the 8 modified files; this documentation-only correction was made during checkpoint review. Dependencies restored through pnpm with frozen existing lockfiles, no application dependency changes.

The stale local main and origin/main references still point to 9d1ef83a80a8a6abb11efaf4220e2458ec2afd9f while feature/account-ai-budget remains at 79ab1496bf0cb8e1807f3b83ef3c6ca96cf404bb. Reconcile against GitHub before staging/release. No refs were changed, and no reset, rebase, re-clone, stage, commit, push or deployment occurred.

## Files for this feature

New: src/ai/analyze-setup-context.ts; src/ai/analyze-setup-contract.ts; src/lib/analyze-setup.ts; src/lib/analyze-setup-data.ts; src/app/analyze-setup-actions.ts; src/components/analyze-setup.tsx; tests/analyze-setup.test.ts; tests/analyze-setup-contract.test.ts; tests/analyze-setup-actions-data.test.ts; tests/analyze-setup-database.test.ts; tests/fixtures/analyze-setup.ts; tests/browser/analyze-setup-entry.tsx; scripts/analyze-setup-browser-harness.mjs; docs/ANALYZE_SETUP_FEATURE.md; docs/ANALYZE_SETUP_VERIFICATION.json.

Updated existing local feature files: src/ai/operations.ts; src/ai/operation-contract.ts; src/lib/bias-challenge-data.ts; src/app/analyze/[id]/page.tsx; supabase/migrations/0010_bias_challenges.sql; tests/bias-challenge-actions-data.test.ts.

## Remaining acceptance before activation

Review this local diff; reconcile Git references; run combined full verification when requested; apply reviewed migrations to an isolated staging database; verify authenticated hosted SSR/RLS with synthetic users; review current provider pricing/configuration and separately authorize any minimal live-provider acceptance. No production activation is authorized by this report.
