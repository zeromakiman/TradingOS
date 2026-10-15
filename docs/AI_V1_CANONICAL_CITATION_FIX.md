# Shared canonical AI citations and accounting-aware failures

Verified locally 2026-10-14 on feature/account-ai-budget. No provider calls, database writes, migrations, deployments, Git staging or production changes.

## Root cause

The five non-Trade-Review operations supplied sourceRefs but accepted arbitrary strings in their provider JSON schemas. Both live pre-trade responses treated the JSON collection name selectedEvidence as a citation. Server validators correctly rejected those outputs. Provider usage had already settled; generic failure copy incorrectly claimed uncertainty retained funds.

## Architecture

The successful Trade Review pattern is generalized in src/ai/citation-sources.ts for CHALLENGE_BIAS, ANALYZE_SETUP, WEEKLY_REVIEW, RECENT_TRADES_ANALYSIS and MONTHLY_REVIEW.

- Derive a versioned AI_CITATIONS_V1 manifest directly from the current ownership/period-filtered snapshot. Each entry has an exact id, kind, data path and description. Scope identifies the proposal or exact selected trade IDs and period boundaries.
- Never accept a client/caller sourceRefs list as authority. Recompute the expected manifest and reject missing, changed, duplicate or inconsistent IDs, paths, scope or operation.
- Append explicit canonical-citation instructions and the exact allowed IDs to each existing operation prompt. Container names, unrelated JSON paths, headings, invented IDs and absent sources remain forbidden.
- Constrain every structured response sourceRefs item through a shared schema definition containing only the manifest IDs. Large definitions use bounded enum branches under anyOf, preserving the full exact allowlist without free-form fallbacks or dropped IDs.
- Persist the exact dynamic contract (operation-specific *_CITATIONS_V2) and manifest with each new immutable request. The provider adapter builds the same contract from the same snapshot for token count/generation.
- Re-derive allowed IDs from the manifest before running the existing strict server output validator. Unknown citations reject the interpretation; raw outputs are preserved unchanged by the existing finish/history path.

No validator, ownership check, period filter, operation envelope, price, reservation/reconciliation rule or provider adapter was weakened or changed in this fix. Existing Trade Review citation implementation remains intact.

Provider schema compatibility follows the official Structured Outputs guide: https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses . The shared definition avoids multiplying IDs across observations; branches contain at most 250 exact values. Local tests cover a 625-source aggregate definition without broadening its allowed values. Remote acceptance remains pending.

## Canonical source IDs

| Operation | Sources |
|---|---|
| Challenge Bias / Analyze Setup | proposal, currentThesis, strategy, deterministic, evidence:<selected UUID> |
| Weekly Review | period, sample, edge, trade:<included UUID>, event:<included UUID> |
| Recent Trades | sample, edge, trade:<included UUID>, strategy:<supplied version UUID>, risk:<supplied version UUID>, event:<included UUID> |
| Monthly detailed | period, sample, edge, models, sessions, trade:<included UUID>, strategy:<supplied version UUID>, risk:<supplied version UUID>, event:<included UUID> |
| Monthly deterministic summary | period, sample, edge, models, sessions only |

Notes are NOTE_ADDED events and use event:<UUID>, matching the existing Trade Review model. Event entries point to trades[i].events[j]. Evidence entries point only to explicitly selected evidence. Monthly summary mode cannot cite omitted individual trade/event/rule details merely because identifiers were retained. No additional context is fetched or sent. In pre-trade context, risk version identity and authoritative risk calculations remain within the existing deterministic source.

selectedEvidence, events and trades are not valid citation IDs. There is no silent deletion, rewriting or acceptance of bad citations.

## Failure presentation

src/ai/failure-accounting-message.ts is used by all six review/history panels, including Trade Review:

- UNCERTAIN: explicitly warns that the protected reservation is held pending audited resolution.
- SETTLED: says estimated usage is recorded and unused reservation capacity has been released; no uncertainty claim.
- CANCELLED: says the pre-dispatch reservation was released.
- Reservation without a recognized settlement: says accounting is not reconciled and should be checked.
- No reservation: says none is recorded.

This is presentation only. Historical rows, raw provider outputs, dispositions, costs, uncertainty records and operator-resolution behavior are unchanged. Legacy history without a new manifest still renders.

## Verification

Final targeted run: 544 passed, 0 failed, 0 skipped, 17 test files. Includes 36 rendered UI cases across all six panels. No full suite run.

Coverage includes canonical proposal/strategy/deterministic/trade/event/note/evidence IDs; invalid selectedEvidence/events/container/invented/foreign sources; manifest tampering and missing facts; selected-period/sample scope; duplicate sources; monthly omitted-detail restrictions; large enum boundaries; unchanged Risk Engine/realized-R/EDGE values; AI OFF and insufficient-budget blocking; mocked reservation/reconciliation; saved contract identity; immutable rejected raw outputs; history append behavior; settled/uncertain/cancelled/unreconciled/no-reservation UI states.

Strict TypeScript: PASS. Lint: PASS (no errors or warnings). Local optimized production build: PASS, Node v24.19.0, AI_ENABLED=false and OPENAI_API_KEY empty in the build process. Diff formatting check: PASS. Nothing staged. No changes to domain calculations, auth/ownership architecture, migrations or accounting semantics.

Machine-readable test evidence: ignored .local/ai-v1-staging/citation-targeted-tests.json.

## Files changed in this fix

New implementation:
- src/ai/citation-sources.ts
- src/ai/failure-accounting-message.ts

Updated implementation:
- src/ai/operation-contract.ts
- src/ai/bias-challenge-context.ts
- src/ai/analyze-setup-context.ts
- src/ai/weekly-review-context.ts
- src/ai/recent-trades-context.ts
- src/ai/monthly-review-context.ts
- src/lib/bias-challenge.ts
- src/lib/analyze-setup.ts
- src/lib/weekly-review.ts
- src/lib/recent-trades.ts
- src/lib/monthly-review.ts
- src/components/bias-challenge.tsx
- src/components/analyze-setup.tsx
- src/components/weekly-review.tsx
- src/components/recent-trades.tsx
- src/components/monthly-review.tsx
- src/components/trade-ai-review.tsx

Tests:
- tests/ai-citation-contracts.test.ts (new)
- tests/ai-failure-accounting-ui.test.ts (new)
- tests/bias-challenge.test.ts
- tests/analyze-setup.test.ts
- tests/weekly-review.test.ts
- tests/recent-trades.test.ts
- tests/monthly-review.test.ts

All preexisting unstaged work and reports are preserved.

## Preview readiness

The local fix is ready to deploy to a new isolated Preview. No new Preview was deployed in this task; the existing hosted Preview still has the earlier contract. Before another paid acceptance request, deploy this fix, confirm the hosted manifest/schema versions and accounting copy, then obtain explicit call authorization. Production remains unchanged and AI-disabled.

READY FOR FINAL AI PROVIDER ACCEPTANCE
