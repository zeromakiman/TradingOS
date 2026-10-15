# Mini Trade Review hosted acceptance — citation fix

Verified 2026-10-13 on feature/account-ai-budget. Exactly one new REVIEW_TRADE generation was submitted through the hosted Trade Detail UI. No retry, no new account, no other AI operation.

## Preview

- Final Preview: https://trading-qfopqx8jl-maksim61910-7648.vercel.app
- Deployment: dpl_6KoYC9giDULpmrgKZrgMTYudSN8f; READY, Preview target; Node 24.x build succeeded.
- Base commit: 0b13aa566808ca709606f5c15f047719c2be29fa, including the current unstaged feature work.
- Source manifest SHA-256: 307c0787b4a30b42d4146c1e2283e0dbeff3a4e22bcb89251a07ccf884f146cb
- Staging Supabase: rqyehnaeplkgmmlzcnhq; existing migrations 0001–0014 reused, no migrations applied by this task.
- Preview AI_ENABLED=true; server-side existing provider configuration preserved.
- REVIEW_TRADE: gpt-5.4-mini, medium effort, 24,000 input / 6,000 output, at most 4 selected images, no tools. Maximum reservation EUR 0.0594.
- Persisted request proves deployment contains REVIEW_TRADE_SOURCES_V1 and REVIEW_TRADE_CITATIONS_V2. Stored prompt/schema match the canonical manifest contract.

The first Preview exposed an actual display defect: new-review reservation disclosure used default Astra pricing (EUR 0.792). The only application-code correction in this task makes src/lib/trade-review-data.ts select the operation's existing pricing profile. Focused coverage updated tests/trade-review-data.test.ts. The replacement Preview correctly discloses EUR 0.0594. Actual gate reservation, pricing profiles, provider adapter, citation validator and deterministic logic were not altered in this task.

## Provider and citations

- Existing synthetic account reused: mini-billing-acceptance, EUR 1 monthly cap, ON; before request EUR 0.983967 remained with no hold or uncertainty.
- Existing synthetic closed trade: f6619c62-90c8-497b-aec7-49aba6edea7d; no selected screenshots.
- Provider outcome: completed, response model gpt-5.4-mini-2026-03-17; no provider/application error.
- Response ID: resp_022a164ba878d6e9016ace9537ddd087d2b9c72b439c611711
- The adapter accepted a successful HTTP response; it does not retain the exact successful HTTP status or x-request-id header. Response ID and returned usage are preserved.
- Review ID: 492ef8c5-7521-4ce4-a29f-ff500d5edde0
- Reservation ID: 6ad0b93f-6661-42be-b060-c4d654667ce6
- Strict citation validator: PASS. Provider response schema: PASS. Every citation is in this exact trade manifest; neither events nor selectedEvidence appears as a citation. selectedEvidence appears only in free-text limitations describing absent images, which is permitted.
- Nine available canonical sources; eight distinct cited sources. Three event IDs include the recorded note. No invented, foreign-trade or unselected-evidence citations.

## Usage and accounting

| Item | Value |
| --- | ---: |
| Input tokens | 10721 |
| Output tokens | 2007 |
| Reasoning tokens (included in output) | 1134 |
| Cached input tokens | 0 |
| Cache-write tokens | 0 |
| Total tokens | 12728 |
| Maximum reserved | EUR 0.059400 |
| Reconciled estimated cost | EUR 0.020487 |
| Unused reservation released | EUR 0.038913 |
| Remaining monthly budget | EUR 0.963480 |
| Total estimated usage this month | EUR 0.036520 |
| Held after completion | EUR 0 |

Accounting disposition SETTLED; uncertainty false. Cost independently reproduced from provider-returned usage and the stored versioned Mini pricing profile. These amounts are application-side estimates, not a provider invoice. One input-token preflight and one generation are the normal bounded-request flow; there was no second generation or retry.

## Persistence and hosted checks

- Review saved as COMPLETED; raw output and interpretation persisted in immutable append-only history.
- History now contains the original FAILED review and this COMPLETED review. Prior review/result rows compare exactly to the pre-call baseline.
- Hosted fresh page load displays the completed review and canonical sources, preserving separation of facts and AI interpretation.
- Secondary metadata displays openai / gpt-5.4-mini, operation version, generated time, EUR 0.0594 maximum, EUR 0.0205 SETTLED (display rounding).
- Settings displays ON, EUR 1 cap, EUR 0.0365 estimated used, EUR 0 reserved and EUR 0.9635 remaining (display rounding).
- Read-only final count confirms only one new reservation/review/result after navigation; no automatic generation occurred.
- Original plans, risk results, execution/outcomes, events and deterministic records compare exactly to the pre-call baseline. No personal trading records were touched.
- All three historical UNCERTAIN incidents remain byte-equivalent as parsed records; zero uncertainty resolutions.

## Verification scope and preservation

21/21 focused display/pricing tests passed, strict TypeScript passed, focused lint passed, Preview production-mode build passed. The prior 226 citation/context tests remain the completed local verification; the full suite was not rerun.

Production before/after Vercel metadata and environment comparison: unchanged. Production deployment remains dpl_HfA2SWCiyNaZ8CXSFzwqH3KMoiPz, AI_ENABLED=false, no OPENAI_API_KEY. No production migration, Supabase write, deployment, merge, staging or commit occurred. Production migration state was not independently re-queried; this task applied no database migrations anywhere.

Known pre-existing display wording: the older failed review's generic notice mentions accounting uncertainty even though its details correctly show SETTLED. Its stored failure/accounting records were preserved; the new review is COMPLETED and its metadata is correct. No unrelated UI redesign was made.

Private verification artifacts remain ignored under .local/ai-v1-staging; no credentials are included in this report. Hosted screenshot: C:/Users/maksi/.codex/visualizations/2026/09/05/01a0709e-eec5-73c3-8cc7-ea6218d17106/mini-review-completed.png .

MINI TRADE REVIEW ACCEPTANCE PASSED
