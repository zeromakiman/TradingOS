# Trade Review canonical citation fix

Verified 2026-10-13 on feature/account-ai-budget, Node 24.19.0. Local implementation only; nothing staged, committed or deployed in this task.

## Root cause

The previous prompt referred generally to supplied sourceRefs, while its static structured response schema permitted arbitrary strings. The model treated collection/property names events and selectedEvidence as citation IDs. Neither was in the snapshot's allowed IDs. The strict application validator correctly rejected the output after provider usage had already been settled. This was an output-contract defect, not a provider or accounting failure.

## Canonical source manifest

Each new Trade Review snapshot includes sourceManifest {version: REVIEW_TRADE_SOURCES_V1, tradeId, sources: [{id, kind, path, description}]} and a sourceRefs list derived from that manifest.

Existing identifiers are preserved:

| Data | Canonical ID |
| --- | --- |
| Immutable original plan | originalPlan |
| Sealed strategy version | strategy |
| Sealed risk-plan version | riskVersion |
| Authoritative Risk Engine calculations | deterministic |
| Recorded execution/result/realized R | execution |
| Recorded tags | tags |
| Trade event | event:<actual event UUID> |
| Note | event:<actual NOTE_ADDED event UUID> |
| Explicitly selected evidence | evidence:<actual evidence UUID> |

Fixed IDs are scoped to the manifest's tradeId. Notes are existing trade events; no separate invented note-ID format was introduced. Only actually supplied events and selected evidence get IDs. Collection names and array paths are not IDs. A field name may be cited only if explicitly enumerated (for example originalPlan).

## Prompt, schema and validation

The prompt lists exact allowed IDs, forbids collection names/headings/invented references, explains note citations and explains how to discuss absent evidence without inventing a citation.

The request contract is versioned REVIEW_TRADE_CITATIONS_V2. The response shape/version stays compatible with stored REVIEW_TRADE_V1 interpretations. A dynamic JSON Schema enum restricts every sourceRefs item to this request's manifest. A shared observation definition uses $defs/$ref so the maximum 210 source IDs (6 fixed + 200 events + 4 evidence records) occur in one enum rather than being repeated across sections. Enum and reference support are documented at https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses . No schema/provider acceptance claim depends on a new paid call.

The contract is validated before the history write and budget gate. The provider reconstructs that same contract for token counting and generation; the exact contract and manifest are saved with the request. Missing/tampered manifests, mismatched source lists, duplicate IDs and invalid mappings fail closed.

The existing final server source validator is unchanged: any unknown source rejects the entire interpretation. Nothing is dropped or rewritten. The prior failed review is not reclassified or repaired. Unsupported output is still saved as failed raw output with its original accounting reservation link. Settled provider usage remains settled even when application interpretation validation fails. No accounting or deterministic formulas changed.

## Files changed in this task

- src/ai/trade-review-sources.ts (new)
- src/ai/trade-review-context.ts
- src/ai/trade-review-contract.ts
- src/ai/operation-contract.ts
- src/ai/provider.ts
- src/lib/trade-review.ts
- tests/trade-review-sources.test.ts (new)
- tests/trade-review-contract.test.ts (preserved earlier Mini changes)
- tests/trade-review.test.ts
- docs/AI_TRADE_REVIEW_CITATION_FIX.md (this report)

All other pre-existing dirty/untracked work is retained, including Mini pricing, uncertainty-resolution work and staging reports.

## Targeted verification

226 passed, 0 failed, 0 skipped in 9 test files:

- trade-review-sources.test.ts
- trade-review-contract.test.ts
- trade-review.test.ts
- trade-review-data.test.ts
- trade-review-actions.test.ts
- trade-review-database.test.ts
- weekly-review-contract.test.ts
- recent-trades-contract.test.ts
- monthly-review-contract.test.ts

Coverage includes all canonical source classes, both incident property names, invented/foreign-trade references, unselected evidence, full manifest-only output, prompt/count/generation schema equality, the maximum schema envelope, unchanged risk/realized-R facts, settled accounting, failed raw output, append-only history, ownership and affected aggregate-context regressions. Database tests ran locally in PGlite only.

Strict TypeScript: PASS. Lint: PASS (0 errors/warnings; informational style suggestions remain). git diff --check: PASS. Full suite and build not rerun; no live provider calls.

## Existing staging account: read-only eligibility check

At 2026-10-13T14:55:19Z, the existing mini-billing-acceptance synthetic account has:

- AI enabled: true
- Monthly budget: EUR 1.00
- Settled estimated usage: EUR 0.016033
- Held reservations: EUR 0
- Remaining: EUR 0.983967
- Uncertain accounting: false
- Unchanged REVIEW_TRADE Mini maximum reservation: EUR 0.0594
- Next reset: 2026-11-01T05:00:00Z (fixed UTC-5 month boundary)

A READ ONLY staging transaction compared the complete saved review/results and reservation/dispatch/usage rows against the prior local evidence: unchanged. All original deterministic trade records match the earlier baseline. All three earlier UNCERTAIN incidents remain unchanged, with zero uncertainty resolutions. The saved failed raw-output SHA-256 remains 5fdc5ee9ecf288c3ba06c2c37ec59e4f3822ff86ad5e177ceb5e2f204459d0d7. No new account or reservation was created.

The account is budget-eligible for one future attempt, subject to the normal gate recheck at dispatch. The deployed Preview still needs an authorized deployment containing this local fix before retrying. No retry is authorized/executed by this report. Production, production AI configuration and provider keys were untouched; no production migration/deployment occurred.

READY FOR FINAL MINI TRADE REVIEW RETRY
