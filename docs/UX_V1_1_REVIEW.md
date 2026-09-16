# Trading OS — UX / Quality-of-Life V1.1

Implemented and verified locally on 7 September 2026. No deployment or subsequent feature phase started.

## Audit before implementation

Reviewed Today, Analyze/new trade, saved proposal, Journal, trade detail, EDGE/export, Settings, login/logout, preview, shared navigation, loading/error UI, forms, data loaders, and server actions.

The most significant findings were:

- Today showed reservations but omitted actual entries, closed R and a continuation action for active work. Stale account observations and monetary caps were not explained in its status.
- A blocked saved-proposal lock returned vague success wording. The data already distinguished a blocked decision from a persisted plan.
- Locking lacked a concise review of the proposed values. Risk errors exposed machine codes, and numeric validation did not identify the affected controls.
- Trade detail scattered evidence across pages and displayed raw event payloads and long decimal values in the primary record.
- Journal loaded the full compact analytics history before slicing the page; its proposal list also loaded full AI passes, outputs and audit events.
- Journal lacked instrument/ID search, date/outcome/model/version filters and a filtered return link. Wide tables and the long filter form obstructed phone review.
- Mobile navigation hid sign-out and included an unimplemented Review destination.
- Forms lacked unsaved-draft protection, pending field locking, focused errors and recovery of entered values after rejected submissions.
- Settings reused the user's ID as every account-creation request key, preventing a second account from being created normally.
- EDGE exposed all filters, breakdown tables and formula definitions at once, obscuring the primary metrics and sample size.

## Improvements

Today now displays deterministic status and blocking reasons, available slots, nominal reserved risk, actual entries today and today's closed R. Active work has continuation links. The account chooser is compact; actual-entry counts and reservations remain distinct. Readiness is explicitly conditional on a fresh per-plan risk check.

Trade creation retains immediate deterministic preview and a separate persisted server decision. Locking remains an explicit server recheck. A summary shows the instrument, direction, prices, requested risk, planned RR, model and versions. Field feedback explains invalid values. Saved-proposal lock feedback reports whether a plan actually locked and highlights blocking reasons.

Trade detail separates original planned values from actual execution and realized results. Private screenshots are visible in the record, with a link for uploads and full evaluation history. Human-readable event summaries lead each event; the original payload remains expandable. Notes and historical values remain append-only.

Journal now retrieves 50 trade rows per database query page, with one batched projection of planned RR for that page. Proposal lists retrieve only compact metadata in 50-row pages. Full AI payloads and screenshot binaries are not fetched for list rows. Search supports instruments and complete trade IDs. Status, outcome, model, strategy version and fixed UTC−5 lock-date filters are available, with counts, clear filters and return navigation that retains filters. Phone tables become labeled cards.

EDGE formulas are unchanged. The primary metrics and sample size remain visible while filters, breakdowns and definitions are expandable. R formatting is consistent. Navigation has an active-page indication, a skip link and accessible phone sign-out. Shared forms disable duplicate submissions, focus errors, preserve non-password input on rejected submissions, and offer an accessible draft-discard dialog. The native browser unload warning covers refresh/closing for guarded forms.

AI remains intentionally disabled. Screenshot upload and preserved evaluation history remain available. No OpenAI key or billing is required for any verified non-AI workflow.

## Changed files

Application pages and actions:

- `src/app/today/page.tsx`
- `src/app/analyze/[id]/page.tsx`
- `src/app/journal/page.tsx`
- `src/app/journal/[id]/page.tsx`
- `src/app/edge/page.tsx`
- `src/app/settings/page.tsx`
- `src/app/loading.tsx`
- `src/app/globals.css`
- `src/app/setup-actions.ts`
- `src/app/journal-actions.ts`

Shared components:

- `src/components/shell.tsx`
- `src/components/forms.tsx`
- `src/components/unsaved-changes.tsx` (new)
- `src/components/account-setup.tsx`
- `src/components/trade-workspace.tsx`
- `src/components/setup-controls.tsx`
- `src/components/setup-journal.tsx`
- `src/components/journal-outcome.tsx`
- `src/components/trade-screenshots.tsx` (new)
- `src/components/edge-dashboard.tsx`

Data and presentation logic:

- `src/lib/data.ts`
- `src/lib/setup-data.ts`
- `src/lib/journal-data.ts` (new)
- `src/lib/today-data.ts` (new)
- `src/domain/ux.ts` (new; presentation and validation helpers, not new risk formulas)

Verification and documentation:

- `tests/ux.test.ts` (new)
- `scripts/verify-ux-live.mjs` (new)
- `scripts/verify-edge-live.mjs` (existing display assertions updated from four decimal places to signed two-decimal R; outcome assertions retained)
- `docs/UX_V1_1_REVIEW.md`
- `docs/UX_V1_1_LIVE_VERIFICATION.json`
- `docs/UX_V1_1_BROWSER_VERIFICATION.json`

Ignored `.local` files contain temporary edit helpers and the clearly labeled synthetic upload image. They are not application routes or public assets.

## Configuration and data safety

- No new configuration is required. `AI_ENABLED=false` remains in effect.
- The production build and local production server were run with `OPENAI_API_KEY` explicitly empty.
- No migration was added or edited.
- Risk and analytics formulas were not changed.
- No existing account, trade, screenshot, AI schema, evaluator prompt, migration or evaluation history was deleted or rewritten.
- Browser mutations used the existing isolated test user and a new account named **UX V1.1 browser acceptance · SYNTHETIC**. One synthetic trade was closed at +2R; a separate over-risk proposal was blocked and recorded skipped.
- The live disabled-Analyze check verified unchanged evaluation events before and after the request. Screenshot bytes were available when authenticated and denied anonymously.
- The AI provider and its modular activation architecture remain intact. No AI-specific dependency blocks ordinary application use.

## Automated verification

- **298 tests passed in 13 files**: all original 265 tests retained, plus 33 UX tests.
- TypeScript passed.
- Lint passed with no errors or warnings; informational style suggestions remain.
- Production build passed with AI disabled and an empty OpenAI key.
- Nine live acceptance groups passed against the real local server and Supabase: password authentication, Today totals, paginated Journal, database filters, persistent detail, private screenshot access, disabled AI/history preservation, private CSV and sign-out of the test API session.
- The older full EDGE live mutation script was not rerun during this phase; its display assertions were aligned with the new formatting. Its calculation behavior remains covered by the original automated suite and this phase's real +2R browser close.

## Browser acceptance

Actual interactive application checks used the production build and real Supabase records, not static HTML captures.

Passed: authenticated Today; adding an account; empty Journal and EDGE; new proposal; risk preview and saved server decision; canceling draft navigation without losing input; saving a proposal; private screenshot upload; deliberate lock; actual entry/TAKEN; note event; full close; original-versus-actual detail; Journal search and clear filters; EDGE +2R and very-small-sample label; CSV download event; refresh persistence; blocked risk and disabled lock; blocked proposal lock feedback; skipped human decision; phone sign-out; completed sign-in and access to the same account/trade afterward. The credentials were not displayed by the agent.

A rejected negative gross-loss submission was also checked: the error received focus, the field retained `-1`, and controls became available again. No account observation was created by that invalid submission.

Viewport checks: desktop 1440×1000, tablet 820×1100 and phone 390×844. Inspected screenshots and document widths showed no horizontal document overflow on the checked core views. Phone trade closing and Journal navigation were exercised. Viewport overrides were reset afterward.

## Remaining limits

- Full-position manual entry/close only; no partial-position accounting was added.
- Timestamps still require an explicit timezone. Display timestamps use UTC; daily/session rules retain fixed UTC−5.
- Today reflects its latest server load; reload around day/session boundaries. The trade editor independently detects stale risk decisions, and locking always checks current server state.
- Draft protection covers in-app links and native unload warnings. Browser Back/Forward behavior was not exhaustively tested; drafts are not autosaved to browser storage.
- Search covers instrument and complete trade ID; free-text note/tag search was not introduced.
- EDGE still reads the compact account history to compute full-history sequence-dependent metrics. Journal list pagination is bounded; no new caching infrastructure was added.
- Supplemental accessible equity-curve data may scroll within its table. Core phone navigation, records and management do not require horizontal page scrolling.
- This is a focused accessibility pass, not certification with every screen reader/device.

## Local review URLs

- http://127.0.0.1:3000/today
- http://127.0.0.1:3000/analyze
- http://127.0.0.1:3000/journal
- http://127.0.0.1:3000/edge
- http://127.0.0.1:3000/settings
- http://127.0.0.1:3000/login

For the existing isolated test user, the acceptance account is `5106652c-4c37-498b-b9f2-f09862900ed6` and its completed trade is `/journal/85b31f56-7cba-40c9-96c6-72edbae4aff6`. These records remain private to that user.
