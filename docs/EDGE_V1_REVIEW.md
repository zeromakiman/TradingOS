# EDGE V1 — implementation and verification

## Delivered

EDGE is available at http://127.0.0.1:3000/edge. Journal now records actual entry, actual quantity, entry timestamp, full exit, exit timestamp and total round-trip fees. PostgreSQL derives the outcome and realized R. Completed records show both actual fills and the original locked plan. Trade events retain occurrence and recording timestamps.

The dashboard includes all requested core metrics, an R equity curve with accessible point data, entry-model comparison, original strategy/risk version comparisons, session and weekday breakdowns, recorded daily execution order, after-win/loss/break-even analysis, and manual grade/liquidity groupings. Every group shows N and a descriptive sample label. No automatic ranking or significance claim is made.

Filters: account, inclusive exit-date range (fixed UTC−5), instrument, entry model, original strategy version, original risk-plan version, entry session, entry weekday, and outcome. All-time, this month and last 30 completed trades are supported. The same filter function governs the metrics, chart, breakdowns and CSV. The account selection is one account at a time. Nonclosed records contribute only to the matching locked-plan record count, using lock date where no exit date exists.

Journal owns maintenance: actual-entry and closing forms, completed-status filtering, full audit record and optional manual tags. Grade, liquidity context and MSS timeframe revisions are append-only and explicitly USER-REPORTED. Latest manual tags drive their breakdowns; absence stays NO DATA. No chart or AI payload is loaded by EDGE.

## Existing data review

Before implementation, migrations 0001–0005 and the Journal, setup, risk and persistence paths were inspected:

| Existing record | What it supplied | What was missing |
|---|---|---|
| trade_plans | Immutable proposal, original stop/entry/target, nominal risk, locked time, governing versions, account observation, stored risk report | Authoritative actual fill, quantity and final outcome |
| risk_evaluations | Preserved deterministic decisions and calculations, contract sizing and account snapshot references | Executed-position result |
| strategy_versions / risk_plan_versions | Immutable version IDs and written/configured rules | No need to change historical versions |
| trade_events | Append-only event sequence; reserved TRADE_OPENED/TRADE_CLOSED types | No implemented typed closing flow |
| setup_proposals / setup_locks | Prelock plans and linkage to original locked records | No execution ledger |
| setup_human_decisions | Append-only TAKEN/SKIPPED intent, including documented overrides | Intent did not capture an actual fill; no safe way to infer R |
| Journal | Original plan, risk report, notes, setup review history | Closed-status filtering and realized R |
| screenshots / evaluation history | Private evidence, immutable AI attempts, failures and human context | No reliable source of MFE/MAE or actual execution prices |
| trade_reviews | Reserved financial/process JSON schema | No implemented authoritatively validated result writer to aggregate |

No historical fills or outcomes were backfilled from these records. Existing TAKEN decisions without an execution record visibly say “Actual fill missing.” Unlocked proposals stay in the setup journal. Lifecycle statuses are derived around the existing plan identity: LOCKED, TAKEN, CLOSED, SKIPPED and CANCELLED; proposed records already exist separately. Explicit execution/outcome data takes precedence over old human-intent annotations. The conservative original risk reservation/slot policy remains unchanged even after cancellation or close.

## Additive migration

`supabase/migrations/0006_edge_outcomes.sql` is installed in the configured Trading OS Supabase project. It adds:

- Immutable `trade_executions`, `trade_outcomes`, `trade_dispositions`, and `trade_tag_revisions`.
- Four authenticated, owner-scoped write functions with atomic event writes, row locking, validation and retry handling.
- `journal_analytics`, a security-invoker view over persisted records. RLS stays active on all underlying tables.
- Account/time and latest-revision indexes.

The original migrations, prompt, evaluator schema and AI history are unchanged. Migration source MD5 is `fb7561b25228745cb011cc78f5edff2e`; the SQL editor stores CRLF line endings, yielding `e576438e1d70a394dea978e2bb963a55` for the stored text. These are the same source after newline normalization.

The close function locks the plan, requires a recorded entry, rejects past-before-entry/future exits and off-tick prices, computes the result server-side and records exactly one outcome per plan. An identical retry returns the existing ID; conflicting input is rejected. Full close V1 refuses a position with partial-close or position-added events. The initial-risk denominator is stored separately from actual fills so future quantity-weighted partial accounting can retain the same original R basis.

## Exact formulas and display conventions

Let N be completed trades, W positive-R trades, L negative-R trades, B exactly-zero-R trades, G the sum of positive R, and H the absolute sum of negative R.

| Metric | Definition |
|---|---|
| Total records | Matching locked-plan records, including nonclosed statuses; excludes unlocked setup proposals |
| Completed trades | Records with a final persisted close |
| Wins / losses / break-even | W / L / B, based on net realized R after reported fees |
| Win rate / loss rate | W/N and L/N; break-even remains in N |
| Average winner | G/W; missing if W=0 |
| Average loser | −H/L; signed, missing if L=0 |
| Net R | G−H |
| Average realized R | (G−H)/N |
| Expectancy | (W/N × G/W) − (L/N × H/L); absent win/loss terms are zero. Equals average realized R |
| Profit factor | G/H. H=0 with wins: “No losses.” All break-even: “No gains/losses.” Losses without wins: 0. Empty: no performance cards |
| Equity curve | Starts at 0R; cumulative realized R in exit-time order |
| Peak / current drawdown | Peak includes starting 0R; drawdown = running peak − cumulative R |
| Maximum drawdown | Largest peak-to-current decline within the filtered R sequence |
| Best / worst trade | Maximum / minimum completed realized R |
| Current streak | Ending run of positive or negative R; a break-even resets it |
| Maximum consecutive wins/losses | Longest positive/negative run; a break-even resets it |
| Average risk % | Equal-weight mean of each plan’s locked nominal risk / locked account-equity observation × 100 |
| Gross price P&L | (actual exit − actual entry) × direction sign / contract tick size × tick value × actual quantity |
| Net price P&L | Gross price P&L − reported round-trip commissions/financing |
| Realized R | Net price P&L / original locked nominal risk; sign +1 for LONG, −1 for SHORT |

PostgreSQL numeric performs closing calculations. Decimal arithmetic performs aggregation; display values are rounded to two decimals (Journal R to four), while CSV retains stored decimal strings. No division by zero is performed. Empty samples show a useful Journal link; nonexistent subgroup metrics show em dashes and NO DATA. An all-break-even completed sample legitimately has zero net R and zero expectancy.

Timestamp ordering preserves PostgreSQL microseconds and normalizes offsets. Exact exit-time ties use plan ID as a stable chart/streak tiebreak; they do not assert a known real order. After-outcome analysis excludes ambiguous simultaneous predecessors. Curves and drawdowns are rebased to the selected sample; R drawdown is never presented as account percentage drawdown.

Sample labels: N<10 VERY SMALL SAMPLE; 10–29 SMALL SAMPLE; 30–99 DEVELOPING SAMPLE; 100+ LARGER SAMPLE. N=0 is NO DATA. These are descriptive labels only.

## Grouping methodology

Entry sessions and weekdays use the existing tested fixed UTC−5 strategy clock, not the browser timezone. ASIA is displayed as ASIAN_RANGE. An unsupported stored strategy clock maps to OTHER/unknown rather than silently applying the current strategy. Historical entries during DEAD_POOL can be analyzed without removing the Risk Engine’s block on new plans during that window.

Daily sequence ranks recorded execution timestamps per account and strategy day, before filtering and including unclosed executions. Exact entry-time ties make that day’s sequence unknown. This is explicitly the sequence of recorded executions: legacy TAKEN intentions without fills are not invented or ranked.

After-outcome groups use each account’s full chronological completed-trade sequence before filtering, including overnight/session gaps. Exact tied exits and their immediate successor have no reliable predecessor. This is a chronological relationship, not evidence of causation or behavioral skill.

Strategy and risk groupings use original immutable IDs, never the currently active version. Manual tags use the latest explicit revision and preserve prior revisions in audit events.

## Verification

- **265 automated tests across 12 files**, including all previous 189 tests. New coverage: 51 calculation/group/filter/CSV tests, 20 database lifecycle/RLS tests, and five route/session/export tests.
- Lint passes with zero errors or warnings and five pre-existing informational style notices.
- Strict TypeScript and production build pass with `AI_ENABLED=false` and an empty OpenAI API key.
- Ten live acceptance checks pass: see `EDGE_LIVE_VERIFICATION.json`. Actual authenticated Journal forms were submitted for entry, full close and manual tagging; their PostgreSQL results were then independently checked.
- A dedicated test user owns all controlled data. Three current-time workflow fixtures produced +2R, −1R and 0R. A separate, prominently SYNTHETIC account contains four explicitly generated historical fixtures, covering Judas/Asia/active/Dead Pool, Tuesday–Friday and two strategy version IDs. They are not claimed as real historical trades. No personal account was seeded or rewritten.
- Historical fixture expected totals: N=4, net 4R, expectancy 1R, win rate 50%, profit factor 5, max drawdown 1R. Live workflow totals: N=3, net 1R, expectancy 1/3R, win rate 1/3, profit factor 2, max drawdown 1R.
- Refresh and sign-out/in persistence, private CSV behavior, direct foreign-user close rejection, all four new table RLS policies, the view and unchanged failed AI evaluations were verified live.
- Desktop layout was visually inspected using a styled capture of the server-rendered synthetic EDGE page. Functional form/export checks used the real authenticated local application; the visual capture itself was static.

## Performance and limitations

V1 calculates from the compact view in deterministic server code, without derived caches or an analytics database. Keyset pages of 500 avoid silently truncating at Supabase’s default row limit. No screenshots, evaluation payloads or prompts enter these queries. Sorting is O(N log N); segment accumulation and predecessor counting use maps. No large-scale live load benchmark was performed.

One actual entry and one final full exit are supported per locked plan. There is no broker reconciliation, partial-close accounting, multi-leg averaging, automatic fee lookup, position-size correction, or outcome amendment flow yet. These are manual records; the user must verify input before saving immutable facts. Timestamps require an explicit timezone and are not guessed from screenshots or browser location. Futures/FX calculations depend on the preserved USD contract specification being correct. Closing records do not rewrite account observations or change the original daily risk-reservation policy.

MFE/MAE require reliable time-aligned market-price paths and position exposure. Account percentage/monetary equity drawdown requires trustworthy account-equity/cash-flow history. Neither is inferred from R curves or screenshots.

No current analytics metric requires AI. Optional future chart classification or automatic grade/liquidity tagging could use AI when separately enabled, but manual structured data can supply these dimensions without AI. AI grades are not silently mixed with manual tags in V1.

`AI_ENABLED=false` remains set. No live OpenAI request was made, no paid API credit was spent, and an OpenAI key is not required for Journal or EDGE. Existing modular Astra code remains untouched by this phase. No next major phase has been started.

## Main changed files

- `src/domain/analytics.ts`, `src/lib/analytics-data.ts`
- `src/app/edge/page.tsx`, `src/app/edge/export/route.ts`
- `src/components/edge-dashboard.tsx`, `src/components/journal-outcome.tsx`
- `src/app/journal-actions.ts`, `src/app/journal/page.tsx`, `src/app/journal/[id]/page.tsx`
- `src/components/shell.tsx`, `src/app/globals.css`, `src/proxy.ts`
- `supabase/migrations/0006_edge_outcomes.sql`
- `tests/analytics.test.ts`, `tests/edge-database.test.ts`, `tests/edge-routes.test.ts`
- `scripts/verify-edge-live.mjs`, `scripts/prepare-edge-fixtures.mjs`
- This report, `docs/EDGE_LIVE_VERIFICATION.json`, README and current implementation status.
