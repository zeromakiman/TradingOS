# AI V1 Mini staging acceptance — five remaining operations

Date: 2026-10-14. Branch: feature/account-ai-budget. Result: FAILED / incomplete acceptance. No retries.

## Preview and bounded configuration

Preview: https://trading-du08w6cb3-maksim61910-7648.vercel.app
Deployment: dpl_CbbCowUxWWapjr5pycAGY8UhW789 (READY, Preview only).
Staging Supabase: rqyehnaeplkgmmlzcnhq. Existing migrations reused; no migrations applied by this task.
All five operations use gpt-5.4-mini and the existing versioned Mini profile. Pricing remains USD 0.75 input / 0.075 cached input / 4.50 output per million tokens, multiplied by 1.20 for the EUR budget, with a 10% reservation margin. Medium effort, existing bounds, image/tool permissions and validators retained.

| Operation | Input/output bounds | Images | Maximum EUR |
|---|---:|---:|---:|
| CHALLENGE_BIAS | 16000 / 4000 | 3 | 0.039600 |
| ANALYZE_SETUP | 16000 / 5000 | 3 | 0.045540 |
| WEEKLY_REVIEW | 24000 / 6000 | 0 | 0.059400 |
| RECENT_TRADES_ANALYSIS | 32000 / 6000 | 0 | 0.067320 |
| MONTHLY_REVIEW | 32000 / 6000 | 0 | 0.067320 |

All tools remain disabled. Combined maximum: EUR 0.279180. Pre-call available budget: EUR 0.963480, AI ON, no outstanding hold or uncertainty.

Registry versions updated to CHALLENGE_BIAS_MINI_V1, ANALYZE_SETUP_MINI_V1, WEEKLY_REVIEW_MINI_V1, RECENT_TRADES_MINI_V1 and MONTHLY_REVIEW_MINI_V1. Legacy setup operations remain unchanged. Central reservation calculation now selects the operation pricing profile when no explicit profile is provided, preventing the five UI loaders from defaulting to Astra reservation prices. Actual provider adapter and validation contracts were not changed.

## Exactly one attempt per submitted operation

| Operation | Provider | Input | Output (reasoning included) | Estimated EUR | Released EUR | Persistence / validation |
|---|---|---:|---:|---:|---:|---|
| CHALLENGE_BIAS | Successful generation | 10040 | 1109 (506 reasoning) | 0.015025 | 0.024575 | Immutable FAILED result; INVALID_CHALLENGE_OUTPUT |
| ANALYZE_SETUP | Successful generation | 10158 | 2133 (1344 reasoning) | 0.020661 | 0.024879 | Immutable FAILED result; INVALID_ANALYSIS_OUTPUT |
| WEEKLY_REVIEW | Not attempted | — | — | 0 | — | Stopped after repeated contract defect |
| RECENT_TRADES_ANALYSIS | Not attempted | — | — | 0 | — | Stopped after repeated contract defect |
| MONTHLY_REVIEW | Not attempted | — | — | 0 | — | Stopped after repeated contract defect |

Both response models: gpt-5.4-mini-2026-03-17. Cached tokens: zero. Output totals include reasoning tokens; reasoning is not charged twice.

Challenge response ID: resp_00db95741b90d3cb016acf73d703ac87d2b34909f0bfd55c99.
Analyze response ID: resp_020b5dc319e79564016acf74191b3c87d2aee0e49bd0d7dc49.
The adapter accepted successful HTTP responses. Exact successful HTTP status / x-request-id headers are not retained; provider response IDs and returned usage are preserved.

New estimated cost: EUR 0.035686. Total current-month account usage including prior Trade Review calls: EUR 0.072206. Remaining budget: EUR 0.927794. Held: zero. Uncertainty: false. Both reservations SETTLED and unused amounts released.

## Failure evidence and response quality

Both structured JSON responses conform to their response schemas but cite the collection/property name selectedEvidence. The exact allowed sources in each supplied snapshot were proposal, currentThesis, strategy and deterministic. The server correctly rejected the foreign reference:

- Challenge: Foreign challenge evidence -> INVALID_CHALLENGE_OUTPUT.
- Analyze: Foreign analysis evidence -> INVALID_ANALYSIS_OUTPUT.

This repeated the same citation-contract defect across both pre-trade operations. Further paid calls stopped under the user's systemic-failure rule. No validator was relaxed, no citation was dropped or rewritten, no raw output was edited, and no failed call was retried. A follow-up should constrain citations to the actual manifest while preserving strict rejection, then obtain fresh retry authorization.

Both outputs acknowledged missing chart evidence and the deterministic BLOCK rather than issuing a trade signal. Challenge additionally used two invalidation entries to discuss removal of procedural block reasons instead of evidence undermining the thesis; recorded as a response-quality limitation, not prompt-optimized during acceptance. No successful application response is claimed.

Hosted failure text also incorrectly says accounting uncertainty retains the reservation, despite details showing SETTLED. Actual ledger holds are zero. This misleading existing generic failure copy is documented, not changed during this acceptance.

## Scope, history and safety

Existing synthetic mini-billing-acceptance account reused; no new account. One synthetic September closed trade and one deliberately blocked unlocked proposal were added to that isolated account for acceptance. The preexisting synthetic trade was unchanged. No personal records were touched.

Both actual requests contained only the current proposal, recorded strategy, deterministic risk/session output and thesis; selected evidence was empty. No unrelated trade/Journal/EDGE data or screenshots were sent. Aggregate fixtures were prepared but never sent to a provider.

Read-only verification after each call compared full account-scoped snapshots of plans, executions, outcomes, events, risk evaluations, strategy/risk versions, journal analytics, proposals, risk checks and locks: unchanged. Proposal remained TRADE_BLOCKED; no lock was created. Risk Engine, RR, realized R and EDGE formulas were not changed.

Both attempts and raw responses are preserved in immutable application history with reservations, dispatches, usage and provider response IDs. Previous Trade Review history is byte-for-byte unchanged. The three historical UNCERTAIN incidents remain unchanged; zero operator resolutions.

Private ignored evidence: .local/ai-v1-staging/v1-mini-CHALLENGE_BIAS-attempt.json, v1-mini-ANALYZE_SETUP-attempt.json, corresponding result.json files, v1-mini-final-check.json, source/deployment manifests. No credential values are included in this report.

## Verification and production

331/331 focused tests in 12 files passed; TypeScript and lint passed. Preview build passed. Full suite was not rerun. Focused live checks confirmed registry identity, owner attribution, context scope, exact reservation amounts, returned usage, reconciliation, released capacity, preserved history and deterministic-data equality. Citation validation correctly failed both outputs.

Production deployment remains dpl_HfA2SWCiyNaZ8CXSFzwqH3KMoiPz; production AI_ENABLED=false and provider key absent. No production deployment, migration, environment change, merge or staging of Git changes occurred. Production migration state was not independently re-audited through its database; this task made no production database writes.

AI V1 REAL-PROVIDER ACCEPTANCE FAILED
