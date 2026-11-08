# Trading OS V2: final report

| | |
|---|---|
| Branch | `ui/claude-v2` |
| Base (V1 production release) | `bc5441c09caf215de8e77d9e6f670af7266cca56` |
| Final commit | ⟦FINAL: commit⟧pending⟦/FINAL⟧ |
| Design of record | [V2_ARCHITECTURE.md](V2_ARCHITECTURE.md), cited as **ARCH §n** |
| Known gaps with designs | [V2_1_GAPS.md](V2_1_GAPS.md), cited as **GAPS §n** |
| Deployment runbook | [DEPLOYMENT.md](DEPLOYMENT.md), cited as **DEPLOY** |
| Risk Engine | [RISK_ENGINE.md](RISK_ENGINE.md) |
| Requirements | Trading OS V2 master specification (V3), cited as **spec §n**; §66 lists the 47 deliverables below, in order |
| Deployment state | Not deployed. No hosted database has the V2 migrations. No paid AI call was made. |

**Reading this report.** Paths are relative to the repository root; test files live in `tests/`. Values that come
from verification are the results of the final verification of 2026-11-08 (browser acceptance run
20261108-202941-7c51f8), recorded machine-readably in
[V2_VERIFICATION.json](V2_VERIFICATION.json). The step outputs themselves stay on the build machine; the browser
acceptance output is in the git-ignored `.local/acceptance/<run-id>/` (`results.json`, `summary.md`), and its pass
matrix is reproduced in [v2-screens/README.md](v2-screens/README.md).

---

## 1. Executive summary

**What V2 is.** Trading OS V2 rebuilds the product around the **Trade and its decision history** (ARCH §0, §2). A
trade (`public.trades`, `supabase/migrations/0015_canonical_trades.sql`) is an immutable identity with an origin
(Planned, Live-first, Imported); everything else hangs off it in append-only records: draft revisions, free
deterministic risk checks, the locked plan, the entry, a timestamped live journal, screenshots, the close, tags, the
review and AI analyses. Its lifecycle (Draft → Locked → Live → Closed → Reviewed, plus Skipped, Cancelled, Discarded)
is derived, never stored as a mutable status (view `public.trade_ledger`; mirror `deriveTradeState` in
`src/domain/trade-state.ts`). Both workflows are first-class: plan first, or record a live position first and explain
it while live or after the close, with the difference kept honest ("No pre-trade plan was recorded before execution.").
Trading Accounts are first-class records and All Accounts is an aggregation context. Journal, EDGE, the performance
calendar and account dashboards drill down to trades and evidence. AI is advisory, concise by default and budgeted per
account. Users can export their data and delete their Trading OS account.

**What V1 got right is preserved (spec §58).**

| Invariant | How V2 keeps it | Where it is enforced | Evidence |
|---|---|---|---|
| Immutable locked plans | Drafts change only by new revisions before the lock; after the lock nothing in the plan changes and later decisions are journal entries | V1 immutability triggers (`private.reject_mutation`, 0001) on `trade_plans`; `revise_trade_draft` / `discard_trade_draft` refuse a trade with a plan (`DRAFT_NOT_EDITABLE`, 0015); deferred `plan_requires_trade` rolls back any plan without a trade (`PLAN_WITHOUT_TRADE`) | `v2-trades-database.test.ts`; acceptance step `locked-immutable` |
| Strict AI citation validation | Every operation's output is validated against the sources supplied with its facts, and unknown sources or trading directives are rejected; the timeline review adds a hindsight guard | `src/ai/validate.ts`, `src/ai/citation-sources.ts`, per-operation `src/ai/*-contract.ts`, `src/ai/trade-timeline-review-contract.ts` (`HINDSIGHT_CITATION`) | `ai-citation-contracts.test.ts`, `v2-ai-timeline-contract.test.ts` |
| Facts vs interpretation | The Risk Engine line leads pre-trade AI cards, apart from "AI interpretation · advisory"; sample sizes, net R and change caveats come from Trading OS, never from the model | ARCH §11.1; `src/components/ai/ai-card.tsx`; `CHANGE_EVIDENCE_NOTE` in `src/domain/ai-summary.ts`; "FACTS VERSUS INTERPRETATION" rule in `src/ai/trade-timeline-review-contract.ts` | `v2-ui-ai-components.test.ts`, `v2-ai-periodic-caveat.test.ts` |
| Deterministic risk authority | The SQL engine decides on every check and again under the account lock at every lock; the TypeScript mirror only previews; AI never overrides BLOCKED | `private.risk_report_v12` (0016); `evaluateRisk` (`src/domain/risk.ts`) | `v2-risk-engine-parity.test.ts`, `v2-risk-engine-boundaries.test.ts` |
| Account ownership and security | Every new table: owner-only SELECT policy, no client DML, writes only through `security definer` functions with `auth.uid()` checks | ARCH §0.5, §10.1; migrations 0015–0019 | `v2-schema-catalog.test.ts` |
| Audit history | Append-only records with immutability triggers and TRUNCATE guards; removals and relabels are new rows; the only delete path is the owner's own erasure | ARCH §0.2–0.3, §10.4; `0019_account_erasure.sql` | `v2-schema-catalog.test.ts`, `v2-erasure-database.test.ts` |
| AI cost controls | Per-account budgets and reservations unchanged; local pre-flight size estimate before any reservation; zero-cost release only when nothing reached the provider; requests refused once pricing expires | `src/ai/request-gate.ts` (`budgetedAiRequest`), `src/ai/request-estimate.ts`, `ai_request_generations` (0018), `src/ai/pricing.ts` | `ai-budget-database.test.ts`, `v2-ai-request-gate.test.ts`, `v2-ai-release-database.test.ts`, `ai-mini-pricing.test.ts` |
| Provider abstraction | Adapters own wire format and usage normalization; the gate owns permission, reservation and reconciliation | `src/ai/provider-contract.ts`, `src/ai/providers.ts` | `v2-ai-request-gate.test.ts`, `ai-budget.test.ts`, `v2-mock-openai.test.ts`; `tests/no-live-ai.ts` blocks OpenAI hosts for the whole suite (`vitest.config.ts`) |
| Process quality separate from P&L | Review completion is the trader's decision, independent of the result; R uses the risk fixed at the lock (or recorded while open), never a moved stop or a risk typed after the close; periodic reviews rate process apart from results | `complete_trade_review` / `reopen_trade_review` (0015, ARCH §2.2); RISK_ENGINE.md "Calculations"; `complete_live_entry` refuses a closed trade (`ALREADY_CLOSED`); "PROCESS QUALITY" sections in `src/ai/weekly-review-contract.ts` and `src/ai/monthly-review-contract.ts` | `v2-trades-database.test.ts`, `v2-domain-close.test.ts`; GAPS §2.3 item 4 |

**Verification summary** (details in items 38–42).

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`) | PASS, exit 0, no diagnostics |
| Lint (Biome, then `scripts/check-unused-exports.mjs`) | PASS: 715 files, 0 errors, 0 warnings, 63 infos; "Unused exports: none" |
| Vitest, full suite | 158 files, 4,392 tests passed, 0 failed |
| Production build (`next build`) | PASS, exit 0 |
| Migrations from a fresh database (local PostgreSQL 17) | reset 19/19 applied, no public table granted to `anon`, verify 10/10 |
| Catalog of the working database vs a fresh one | identical: the live database and a fresh apply of 0001–0019 give byte-identical catalog dumps (8,186 lines: columns, constraints, policies, triggers, indexes, views, grants and every function's definition) |
| Upgrade from a representative V1 database | PASS (item 27; source: round-2 verification replay) |
| Secret scan (client and server build output, working tree) | 0 secret or personal hits (client build 0 hits; working tree only the 5 documented test fixtures) |
| Browser acceptance, 7 flows × 2 viewports | PASS, no failed step, no browser console errors, failed requests or dev-overlay issues (item 41) |
| Objective UX criteria (spec §60) | 20 of 20 PASS (item 42) |
| Paid AI calls | None: tests use mocks and fixtures; browser acceptance used the local mock provider (`scripts/local-stack/mock-openai.mjs`) |

**Known-limitation headline** (item 43).
- No Vercel Preview URL exists (item 47); with the missing URL the deliverable set is incomplete.
- The daily limits do not yet see platform executions that are held, unlinked, or whose close was not recorded on a
  trade (GAPS §1.2). No effect in V2, which accepts only the MOCK provider; it must be closed before any real provider.
- Very large histories: the Journal takes 7.9–8.7 s at about 45,000 trades (GAPS §4.1), and EDGE across three accounts
  of 15,000 trades 8.2–8.4 s (item 43), above the 5 s budget. The account dashboard at 19,900 trades loads in 4.6–5.2 s.
- The final browser run was inside Dead Pool, so Analyze Setup on a ready draft, locking a new plan and Challenge My
  Bias were not exercised in the browser by it (item 41); earlier runs on 2026-11-08 passed them.
- Two hosted-project checks are open before release: the recovery `amr` claim and PostgREST 11 or later (DEPLOY).
- AI requests are refused from 2026-11-12T00:00:00Z until the pricing profile is re-verified (`src/ai/pricing.ts`).

---

## 2. New information architecture

**Navigation** (ARCH §1.1, §13.3): `Today · Journal · Accounts · EDGE · Review · Settings`. The header always shows the
**Trading Account** selector, the strategy clock (fixed UTC−5), Search (Ctrl/⌘+K) and the two primary actions
**+ Plan Trade** and **+ Record Live Trade**. Phones get a bottom tab bar `Today · Journal · (+) · Accounts · More`.

| Route | Purpose | Page |
|---|---|---|
| `/today` | Home workstation | `src/app/(app)/today/page.tsx` |
| `/trades/new`, `/trades/[id]/edit` | Plan Trade, Edit draft | `src/app/(app)/trades/new/page.tsx`, `src/app/(app)/trades/[id]/edit/page.tsx` |
| `/trades/live/new` | Record Live Trade | `src/app/(app)/trades/live/new/page.tsx` |
| `/trades/[id]` | Trade workspace | `src/app/(app)/trades/[id]/page.tsx` |
| `/journal` | Every trade, filters, search | `src/app/(app)/journal/page.tsx` |
| `/edge` | Statistics, charts, calendar, breakdowns | `src/app/(app)/edge/page.tsx` |
| `/accounts`, `/accounts/new`, `/accounts/[id]`, `/accounts/[id]/manage` | Accounts workspace, creation, dashboard, management | `src/app/(app)/accounts/**` |
| `/review`, `/review/weekly`, `/review/recent`, `/review/monthly`, `/review/history` | Review workspace | `src/app/(app)/review/**` |
| `/settings` | General, AI, Connections, Data, Security, Danger zone, Developer | `src/app/(app)/settings/page.tsx` |
| `/login`, `/forgot-password`, `/update-password` | Public pages | `src/app/login`, `src/app/forgot-password`, `src/app/update-password` |

All app pages share one authenticated layout (`src/app/(app)/layout.tsx`, shell in `src/components/shell/`:
`sidebar.tsx`, `top-bar.tsx`, `mobile-tab-bar.tsx`, `account-selector.tsx`, `primary-actions.tsx`,
`command-palette.tsx`). V1 URLs keep working as real 307 redirects (`/analyze`, `/analyze/[id]`, `/journal/[id]`,
`/edge/weekly|recent|monthly`, `/preview`; ARCH §1.2), and V1 bookmarks of `/journal` and `/edge` keep their filters.
The proxy (`src/proxy.ts`, ARCH §1.3) refreshes the session on every page and applies `?account=`.

Tests: `v2-legacy-routes.test.ts` (every V1 page and route handler at `bc5441c`), `v2-proxy.test.ts`,
`v2-ui-shell.test.ts`.

## 3. Canonical Trade state model

**Records** (ARCH §3.3–§3.6, all in 0015): `trades` (origin `PLANNED | LIVE_FIRST | IMPORTED`), `trade_revisions`
(draft revision n → a V1 `setup_proposals` row), `trade_plan_links` (exactly one plan per trade, unique both ways),
`trade_lifecycle_events` (`DRAFT_DISCARDED`, `REVIEW_COMPLETED`, `REVIEW_REOPENED`), `trade_position_facts` and
`trade_unplanned_closes` (live-first and imported), `trade_journal_entries`, `trade_evidence` (+ removals, labels),
`trade_tag_sets`. Risk checks, plans, fills and outcomes stay in the V1 tables and are written by the V1 functions,
which V2's RPCs call.

**Derived lifecycle** (ARCH §2.2): computed in SQL by `public.trade_ledger` (0015; redefined in 0018 to add AI review
counts) and mirrored by `deriveLifecycle`, `deriveDraftCheck` and `deriveTradeState` in `src/domain/trade-state.ts`.

| Lifecycle | User label | Applies to |
|---|---|---|
| DRAFT (UNCHECKED / BLOCKED / APPROVED current / APPROVED stale) | Draft / Blocked / Ready to lock / Recheck needed | Planned |
| LOCKED | Locked · waiting for entry | Planned |
| LIVE | Live | All origins (live-first and imported start here) |
| CLOSED | Closed · review pending | All |
| REVIEWED | Reviewed | All |
| SKIPPED / CANCELLED / DISCARDED | Skipped / Cancelled / Discarded | Planned |

Each state has exactly one primary next action and named secondary actions (ARCH §2.4); which blocked row applies is
decided from the stored check (`blockRemedy`, `withBlockingFindings` in `src/domain/trade-state.ts`). The editability
matrix (ARCH §2.5) states what can still change in each state, and the UI says it in words ("Locked plans can't be
edited. Later changes are recorded in the journal."). A plan can exist only inside the trade model: the deferred
constraint trigger `plan_requires_trade` (0015) rolls back any API transaction that inserts a plan without its trade
link (ARCH §2.1).

Tests: `v2-ledger-parity.test.ts` (SQL lifecycle = TypeScript lifecycle for every state, including V1 history),
`v2-domain-trade-state.test.ts`, `v2-trades-database.test.ts`.

## 4. Planned-trade workflow

ARCH §8.1. Each step and the code that performs it:

| Step | What happens | Implementation |
|---|---|---|
| Plan Trade | Explicit account, instrument, direction, model, prices, risk preset, thesis, checks, staged screenshots; live preview by the TypeScript engine | `src/components/trade/forms/plan-trade-form.tsx`, `risk-preview.tsx` |
| Save draft | `create_planned_trade` writes the trade and revision 1 and runs the free server check | 0015; `src/app/actions/trades.ts` |
| Read the verdict | Blocked with every exact reason, or Ready to lock | `src/components/trade/plan-section.tsx`, `src/domain/risk-explain.ts` |
| Edit draft | New revision of the same trade (item 9) | `revise_trade_draft` |
| Optional AI | Analyze setup / Challenge my bias, cost shown, never automatic (item 21) | `src/components/ai/pre-trade-ai-panel.tsx` |
| Lock plan | Confirmation lists what becomes immutable and what is reserved; the server re-evaluates under the account lock | `lock_trade` (0015) → V1 lock path |
| Record entry | Pre-filled from the plan; a differing price, size or an "Earlier" time opens "Record this entry?" first | `record_planned_entry`; `src/components/trade/record-entry-form.tsx`, `record-confirm-dialog.tsx` |
| Live journal | Notes, decisions, stop/target/partial entries, screenshots (item 7) | `add_journal_entry` |
| Close | Only from the "Close this trade?" dialog, which shows the result as the database will store it | `close_planned_trade`; `src/domain/close-preview.ts`, `src/components/trade/close-trade-form.tsx` |
| Review | Tags, lessons, Mark reviewed | `set_trade_tags`, `complete_trade_review` |

Evidence: acceptance flow `planned` (step ids `onboarding`, `plan-blocked`, `paste-screenshot`, `drop-screenshot`,
`save-blocked`, `edit-draft`, `ready`, `analyze-ready`, `lock`, `locked-immutable`, `record-entry`, `live-note`, `close`,
`close-preview`, `lesson-after-close`, `review`, `timeline`); results in item 41. `v2-close-preview-parity.test.ts`
compares the dialog's figures with what the close stores. Screens: [plan-trade-blocked-desktop.png](v2-screens/plan-trade-blocked-desktop.png),
[trade-draft-blocked-desktop.png](v2-screens/trade-draft-blocked-desktop.png),
[trade-planned-live-desktop.png](v2-screens/trade-planned-live-desktop.png),
[trade-closed-timeline-desktop.png](v2-screens/trade-closed-timeline-desktop.png).

## 5. Live-first workflow

ARCH §3.5, §8.2. **Record Live Trade** (item 6) creates a `LIVE_FIRST` trade with its first `trade_position_facts` row
(`record_live_trade`, 0015) and opens the trade page with the composer focused and the banner **"No pre-trade plan was
recorded before execution."** (constant in `src/domain/trade-state.ts`). The trader adds notes, screenshots, decisions
and stop/target/partial entries while live; missing entry details can be completed once ("Add entry details",
`complete_live_entry`: a field is never changed once set). **Close** records an exit price, or the platform's net P&L
when price math is impossible (`close_live_trade`, `UNPLANNED_CLOSE_V1`: P&L calculated when instrument, entry,
quantity and exit are known, otherwise user-reported; R only with a risk basis), through the same confirmation dialog
as a planned close. Notes after the close are After close. Live-first trades never offer the pre-trade AI tools; their
AI review states `planStatus: NO_PLAN_RECORDED` (ARCH §8.3, §11.4). No planned values are fabricated: the planned
columns of `trade_ledger` stay null (ARCH §3.12).

Evidence: acceptance flow `live-first` (`record`, `no-plan`, `note`, `screenshot`, `decision`, `close`,
`after-close-note`, `not-pre-entry`, `timeline`); `v2-trades-database.test.ts` (create, complete, close math, R null
without basis); screens [trade-live-first-desktop.png](v2-screens/trade-live-first-desktop.png),
[mobile-live-first-timeline-mobile.png](v2-screens/mobile-live-first-timeline-mobile.png).

## 6. Quick Live Trade implementation

- **Entry points:** the header's **+ Record Live Trade** on every page (`src/components/shell/primary-actions.tsx`), the
  phone's (+) sheet, the `L` shortcut (`src/components/shell/shortcuts.ts`), the command palette, Today's empty-day
  action and each account dashboard (carrying `?account=<id>`).
- **Form** (ARCH §14.3; `src/components/trade/forms/live-trade-form.tsx`, `live-model.ts`): one screen,
  mobile-first. Mandatory: Trading Account (explicit), instrument (or "Other symbol"), direction, and an entry price
  or "Already open — add price later". Entry time defaults to "Now"; "Earlier" reveals a field in strategy time.
  Size, stop and risk amount are optional.
- **Server validation** (`record_live_trade`, ARCH §3.5): instrument of the account or a valid symbol, entry time not
  in the future, tick and step alignment and stop side when the contract is known; idempotent by request key.
- **After saving:** "Start live journal" opens `/trades/[id]#journal` with the composer focused.
- **Unsaved entries** are kept in the browser tab and cleared on sign-out (`src/components/trade/forms/autosave.ts`;
  DEPLOY "Operational notes").

Evidence: spec §60.8 in item 42 (recorded with account, instrument, direction and entry price only);
`v2-screen-forms.test.ts`; screen [record-live-trade-mobile.png](v2-screens/record-live-trade-mobile.png).

## 7. Live Trade Journal

- **Record** (ARCH §3.6): `trade_journal_entries`, kinds `NOTE`, `DECISION`, `STOP_CHANGE`, `TARGET_CHANGE`,
  `PARTIAL_CLOSE`, `LESSON`; append-only; idempotent by request key (`add_journal_entry`, 0015).
- **Phase and state** are stored by the server at insert, never taken from the client (item 8).
- **Structured entries** (stop, target, partial close) are accepted only while the trade is live
  (`ENTRY_NOT_LIVE`). After the close, what happened is written as a Decision or a Note and never changes the stored
  close. This is a deliberate design decision: a stop move dated by its recording time would sit after the close in
  the timeline and in the AI facts.
- **Composer** (`src/components/trade/journal/composer.tsx`, `composer-model.ts`): "Add to trade journal…", kind
  chips, paste, drop or attach screenshots, the phone camera, Ctrl/⌘+Enter. The trader never leaves the trade.
- **Timeline** (`src/components/trade/journal/timeline.tsx`, `timeline-model.ts`, `src/domain/timeline.ts`): grouped
  Before entry / While live / After close, with exact times, and both times when the event and its recording differ
  by more than 5 minutes.
- **Today:** each live trade card has an inline note composer and a screenshot drop zone
  (`src/components/today/live-panels.tsx`).
- **Partial closes are journal records, not accounting events.** The close form works out the single exit price from
  the partials journaled while live (`src/domain/partial-closes.ts`, `src/components/trade/close-model.ts`) and shows
  the arithmetic.

Tests: `v2-ui-journal-composer.test.ts`, `v2-ui-journal-timeline.test.ts`, `v2-trades-database.test.ts`
(`ENTRY_NOT_LIVE` in every state), `v2-domain-close.test.ts`, `v2-screen-today-model.test.ts`.

## 8. Timestamp/phase integrity design

ARCH §5. The guarantee: **a post-trade note can never be presented as pre-entry evidence.**

1. **Authoritative time sources** (ARCH §5.1): server clock (`clock_timestamp()`) for every recording; the
   user-reported entry and exit times are bounded: an entry is at or after the lock and not in the future, and an exit
   is at or after the entry.
2. **Stored phase at creation** (ARCH §5.2): `private.trade_phase` (0015) stores `PRE_ENTRY`, `LIVE` or `POST_TRADE`
   with every journal entry and screenshot, together with the lifecycle at that moment (`state_at_creation`). A plan
   that ended without an entry (`private.plan_ended_at`: discard, skip or cancel, or a V1 skip) makes later records
   `POST_TRADE`.
3. **Effective timing at read time** (ARCH §5.3): `classifyTiming` (`src/domain/timeline.ts`) compares microsecond
   instants. The stored phase can never upgrade an item to Before entry; the timestamp check can only downgrade it
   (flags "Recorded after execution began", "Recorded after the plan ended").
4. **One classification everywhere:** the trade page, the AI facts (`timing` on every
   timeline item and screenshot, ARCH §11.4), the export's evidence manifest (ARCH §10.5) and evidence copying on
   duplicate (`private.copyable_evidence`, ARCH §7.4) use the same rule.
5. **Causal ordering** (ARCH §5.4): a risk check never sorts before the revision it evaluated, and the evaluation that
   authorised a lock is placed right before "Plan locked".

Tests: `v2-domain-timeline.test.ts` (including back-dated entries), `v2-integrity-plan-end.test.ts`,
`v2-integrity-copy-evidence.test.ts`, `v2-trades-database.test.ts` (phase at creation in every lifecycle state).
Acceptance: spec §60.9 in item 42.

## 9. Editable-draft implementation

ARCH §2.5, §3.3–§3.4, §14.2.
- **Revisions, not mutation.** Each save inserts a new proposal and `trade_revisions` row n+1 (`revise_trade_draft`).
  Optimistic concurrency: the caller sends `p_expected_revision`; a stale editor gets `DRAFT_CHANGED`. A replay of the
  same request key returns the same revision. The lock also checks the expected revision.
- **What stays:** screenshots belong to the trade, not the revision, so they carry over; the thesis and every field
  are pre-filled from the latest revision; the page shows "Revision n → n+1".
- **When editing stops:** once a plan exists, or the draft is discarded or was skipped in V1 (`DRAFT_NOT_EDITABLE`).
  The edit page then shows "can't be edited" (`src/components/trade/forms/not-editable.tsx`).
- **AI on old revisions:** pre-trade AI runs only on the latest revision (`start_bias_challenge`, shared by Analyze
  Setup and Challenge My Bias, redefined in 0018: `NOT_LATEST_REVISION`). Older results are marked "Based on draft revision n · current revision is m"
  (`src/components/ai/stale-revision-marker.tsx`).
- **Duplicate draft** (`duplicate_trade_draft`): copies the latest revision, resets the news check, moves to the
  account's current contract (a changed contract must be re-confirmed, `CONTRACT_UNCONFIRMED`), and copies only
  evidence that was Before entry in the source (ARCH §7.4).
- **Discard** (`discard_trade_draft`) appends `DRAFT_DISCARDED`; nothing is deleted.

Tests: `v2-trades-database.test.ts`, `v2-actions-trades.test.ts`, `v2-risk-duplicate.test.ts`,
`v2-integrity-copy-evidence.test.ts`, `v2-ai-pretrade.test.ts`. Acceptance: spec §60.5 in item 42.

## 10. Risk-policy changes

ARCH §3.10, §6; RISK_ENGINE.md "Risk-plan precedence" and "Selectable risk per trade".
- **Default risk per trade:** new column `risk_plan_versions.default_risk_percent` (≤ maximum; null on legacy versions
  means "default equals maximum", the V1 behaviour).
- **Versioned policy:** `create_risk_policy_version` (0015) creates a new version with default risk, maximum risk,
  trades per day, minimum RR and its BLOCK/WARN policy, news policy, daily risk cap and daily loss limit. A new version
  starts on the next strategy day; an immediate one needs a reason of 5 or more characters and is recorded as a
  configuration event. Old versions are never changed.
- **Precedence fix (V1 finding C9):** `private.active_risk_plan` picks, among versions effective on a day, the newest
  created. A next-day loosening scheduled before an immediate tightening can no longer undo the tightening. Every
  engine path (0016), loader and UI label uses it; history labels ("Starts tomorrow", "Replaced before it started")
  come from `riskPlanTimeline` in `src/lib/accounts-data.ts`.
- **Selectable risk:** Plan Trade offers 0.25 %, 0.50 %, 0.75 %, 1.00 % filtered to the maximum, the plan's default,
  and Custom. The choice is only a request: `RISK_LIMIT` blocks anything strictly above the maximum in the preview and
  on the server. The requested risk is part of the locked plan.
- **Hidden hard limits (spec §13):** every limit above is now a per-account, versioned setting. The strategy rules
  (ICT V1.0: sessions, Dead Pool, models, the documented 3R minimum) stay immutable in the strategy version. Manage →
  Risk policy warns when the risk plan's minimum RR is below the strategy's 3R.
- **History** keeps the strategy and risk-plan version each trade was checked and locked under (item 42, §60.20).

Files: `src/components/accounts/manage-risk-policy-form.tsx`, `risk-plan-table.tsx`. Tests:
`v2-risk-engine-usage.test.ts` (C9 precedence), `v2-risk-engine-boundaries.test.ts` (S6), `v2-actions-accounts.test.ts`,
`v2-screen-accounts.test.ts`, `v2-loaders-data.test.ts`. Acceptance steps `settings/risk-preferences`,
`analytics/historical-versions`. Screen: [account-manage-risk-policy-desktop.png](v2-screens/account-manage-risk-policy-desktop.png).

## 11. BLOCKED-reason implementation

ARCH §6.4–§6.5.
- **Report 1.2** (`riskReportSchemaV12`, `src/domain/risk-report.ts`): every issue carries a flat `params` object, and
  `ruleResults` lists all 18 hard rules exactly once, so every blocking reason can be explained without guessing.
- **One message catalogue** (`explainIssue`, `explainReport` in `src/domain/risk-explain.ts`) renders exact sentences
  from code and params, for example "Requested risk 1.00% exceeds your configured maximum of 0.50%." and "Trading is
  not permitted during Dead Pool (12:00–18:00 UTC−5). New plans can be locked from 18:00." SQL stores the same
  sentences for audit, but the UI always renders from code and params. Reports 1.1 and 1.0 get their missing params
  from the immutable risk-plan and instrument versions they reference, never from today's settings.
- **Where reasons show:**
  - the Plan section lists every blocking reason first, then warnings (notes collapsed);
  - the header's next-action line and Today's plan rows show the first reason with " (+N more)";
  - the Plan Trade preview shows the same verdict before saving.
- **What clears it:** a caption says what can clear the block (a lower risk that fits, the fields to change, or when
  a recheck can pass: 18:00 UTC−5, the next trading day, an open position closing, account values confirmed today;
  ARCH §14.4). The primary action follows from it (`blockRemedy`).
- No reason requires opening Technical details; rule codes are never shown.

Tests: `v2-domain-risk-explain.test.ts`, `v2-screen-trade.test.ts`, `v2-screen-today.test.ts`,
`v2-v1-replacements-today.test.ts`. Acceptance: spec §60.6 in item 42. Screens:
[trade-draft-blocked-desktop.png](v2-screens/trade-draft-blocked-desktop.png),
[plan-trade-blocked-desktop.png](v2-screens/plan-trade-blocked-desktop.png).

## 12. Risk precision/boundary findings

The V1 precision audit's findings and their resolution (ARCH §6.1, §6.6; RISK_ENGINE.md "Calculations", "Precision
and display"). The audit's working notes are not part of the repository (`tests/v2-risk-engine-boundaries.test.ts:11`
names them); ARCH §6.1 and the test cases are the record.

| Finding | Resolution | Evidence (`tests/v2-risk-engine-boundaries.test.ts` unless noted) |
|---|---|---|
| C1, C2, C13: display rounding could contradict the verdict (an RR shown as the minimum while it failed) | Values compared with a threshold are rounded toward the side that preserves the verdict and gain decimals until the shown comparison agrees (`formatAgainst`); money at risk always rounds up (`formatMoneyUp`); R never shows `-0.00R`; no `Number(x).toFixed` in money, price, R or percent paths (`src/domain/format.ts`) | T2 (RR exactly 2.995 against 3 shows "2.99R"), T3; `v2-domain-format.test.ts` |
| Equality at a boundary must pass (spec §11: `4.00 >= 4.00`) | Exact decimal comparison: cross-multiplication for RR, `numeric` in SQL, Decimal.js with 100 significant digits in TypeScript | T4/T5 (minimum 2.995 passes at equality, 2.996 blocks), T10/T11, T12/T13 (cap 100 passes at exactly 100, 100.01 blocks), T14/T15 |
| Requested risk forms | `"0.5"`, `"0.50"`, `"0.50000000"` are the same request; `0.50000001` is above the maximum although budget and permitted risk are both 50.00 | T7, T8, T9 |
| C3: the daily loss cap double-counted closed losing trades | The loss check uses realized losses + open exposure + this trade, not every reservation | S1, S2, S4, S5 |
| Daily loss typed by hand | Computed from closed trades plus explicit external losses (item 13) | S3, T16; `v2-risk-engine-usage.test.ts` |
| Live-first trades invisible to the daily limits | Live-first and imported trades entered today take trade slots and add their known risk | T18 |
| C5, C12: long or inexact SQL decimals | Canonical `trim_scale` strings; RR truncated exactly to 8 decimals; budgets truncated to cents; no exponent notation | T3, T21, T23, T26, T27 |
| C6, C7: the preview hid blockers and its messages differed | The TypeScript engine mirrors SQL rule coverage and `ruleResults`; MAX_TRADES, DEAD_POOL and STALE_EQUITY are evaluated even when input errors stop sizing; one message catalogue | T25; `v2-risk-engine-parity.test.ts` |
| C8: whether an approval was still current was judged on the browser clock | `isRiskReportCurrent` uses the server time passed by the page | `v2-risk-report-current.test.ts` |
| C9: risk-version precedence | `private.active_risk_plan` everywhere (item 10) | S6; `v2-risk-engine-usage.test.ts` |
| Session boundaries | Fixed UTC−5, start-inclusive, end-exclusive, to the microsecond | T24 (Judas → kill zone → Dead Pool → Asia → next strategy day); `v2-session-boundaries.test.ts` |

Every T and S case runs through both `private.risk_report_v12` with an explicit `p_now` and `evaluateRisk`, and the two
reports must be identical except `evaluatedAt`. `v2-risk-engine-parity.test.ts` adds the precision-audit inputs and
**400 seeded random cases** ("agrees on 400 cases covering every finding and every rule outcome"; ARCH §16.1 requires
at least 250). The engine version stays `1.1` (V1's rules and sizing arithmetic); the report version is `1.2`; stored
1.0 and 1.1 reports keep their meaning (`storedRiskSchema`).

## 13. Daily-loss redesign

ARCH §3.9, §6.2, §8.4.
- **The manual input is gone.** The V1 field "Today's gross realized losses" no longer exists; Settings asks for no
  loss total (acceptance evidence for spec §60.17).
- **Known losses are computed.** `private.daily_usage` (0016; exposed to the owner as `public.get_daily_risk_usage`)
  returns 13 keys (`DailyUsage` in `src/domain/risk.ts`). Among them: `realizedLoss`, the losses of planned outcomes
  and live-first closes whose exit falls on today's strategy day; `externalLoss`; `openExposure`; and
  `lossTotal = greatest(coalesce(legacyReportedLoss, 0), realizedLoss + externalLoss)`. The `greatest` prevents double
  counting when a V1 manual total already included today's losses, and never counts less than V1 did.
- **External losses are explicit:** "Add external loss" with amount and optional note, and an audited removal
  (`external_loss_entries`, `external_loss_removals`, `add_external_loss`, `remove_external_loss`; Manage → External
  losses and Today). Helper copy: "Losses from trades not recorded in Trading OS today, for example on another
  platform."
- **Double counting with sync:** the note under the form (`EXTERNAL_LOSS_SYNC_NOTE`,
  `src/components/accounts/copy.ts`) says not to add losses already recorded on a trade. Manage → Connection's pointer
  to External losses adds "If you later record its close on a trade, remove that external loss." (GAPS §1.2).
- **Today shows the figures:** "Realized losses today" with the external part, and account-values freshness with a
  one-click "Confirm unchanged" (`src/components/today/status-section.tsx`, `status-actions.tsx`).

Tests: `v2-risk-engine-usage.test.ts`, `v2-today-data-losses.test.ts`, `v2-domain-daily-status.test.ts` (every
restriction Today shows also blocks the engine, over 400 seeded account states).

## 14. Screenshot/evidence workflow

ARCH §7.
- **Capture** (`src/components/evidence/evidence-stager.tsx`, `paste-model.ts`, `stager-model.ts`):
  - Ctrl/⌘+V anywhere on Plan Trade, Edit Draft and the trade page;
  - a full-page drop overlay and the composer and gallery drop zones;
  - the file picker, and the camera on phones (`capture="environment"`);
  - an immediate preview, a label defaulted by phase, an optional timeframe and caption, and remove/replace before
    saving.
- **Upload** (`POST /api/trades/[id]/evidence`, `src/app/api/trades/[id]/evidence/route.ts`, `src/lib/evidence.ts`):
  1. same-origin and session checks, then trade ownership through the user's RLS client;
  2. a bounded body (4 MiB + 64 KiB), then magic bytes and a full decode (40 MP, single frame);
  3. the trusted server uploads to the private `trade-evidence` bucket at `{uid}/{trade}/{evidenceId}`;
  4. `register_trade_evidence` (service role only) re-verifies the owner, enforces 24 active images per trade and
     stores the phase;
  5. on failure the object is removed.
- **Bucket** (0015): private, 4,194,304-byte limit, PNG, JPEG or WEBP only. Policies require a registered row, and
  restrictive guards deny browser writes.
- **Delivery:** `GET /api/evidence/[id]` (`?variant=thumb`), `private, no-store`, `nosniff`. Legacy V1 screenshots
  keep working through `GET /api/screenshots/[id]` and appear in the same gallery.
- **Gallery and viewer** (`src/components/evidence/gallery.tsx`, `viewer.tsx`, `selection.tsx`):
  - grouped Before entry / While live / After close, with large thumbnails;
  - "Selected for AI" with a per-operation maximum;
  - a full-screen viewer with ←/→/Esc;
  - relabel and remove are append-only (`trade_evidence_labels`, `trade_evidence_removals`); the phase never changes.

Tests: `v2-routes-evidence.test.ts`, `v2-v1-replacements-routes.test.ts`, `v2-ui-evidence-stager.test.ts`,
`v2-ui-evidence-upload.test.ts`, `v2-ui-evidence-gallery.test.ts`, `v2-integrity-copy-evidence.test.ts`,
`v2-trades-database.test.ts`. Acceptance: spec §60.3 and §60.4 in item 42. Screens:
[plan-trade-blocked-desktop.png](v2-screens/plan-trade-blocked-desktop.png) (one pasted and one dropped image staged),
[evidence-viewer-desktop.png](v2-screens/evidence-viewer-desktop.png).

## 15. Trade Detail redesign

ARCH §14.4; `src/components/trade/trade-workspace.tsx`.
- **Header** (`trade-header.tsx`): `EURUSD · Long`, account chip, state pill, origin badge, the single next action,
  and an overflow menu.
- **Stepper or banner:** the stepper `Draft → Validated → Locked → Live → Closed → Reviewed` for planned trades
  (`trade-progress.tsx`), or the live-first banner.
- **Plan** (`plan-section.tsx`): the draft with its last check and exact reasons, or the locked plan card ("Locked
  09:12 · Risk Plan V1.0 · ICT V1.0 · immutable"); the thesis is Before entry; a readable strategy card replaces V1's
  raw strategy prompt (`src/domain/strategy-card.ts`, `strategy-card-sheet.tsx`).
- **Pre-trade AI:** read-only once the trade is no longer a draft.
- **Execution** (`execution-section.tsx`): Plan vs reality for planned trades (`src/domain/plan-vs-reality.ts`:
  - entry slippage in ticks and pips;
  - size ratio with "Oversized";
  - risk at stop;
  - realized R against planned RR).

  Live-first trades show "No pre-trade plan recorded" instead of planned values.
- **Live journal and Evidence:** in the side column on desktop; on phones the journal comes first while the trade is
  live.
- **Result** (`result-section.tsx`): the close form, then the outcome card with its calculation basis.
- **Review** (`review-section.tsx`): tags, lessons, Mark reviewed, and the AI review card with its history.
- **Technical details** (`technical-section.tsx`): collapsed.

Tests: `v2-screen-trade.test.ts`, `v2-screen-trade-model.test.ts`, `v2-screen-trade-dialogs.test.ts`,
`v2-domain-plan-vs-reality.test.ts`. Screens: [trade-planned-live-desktop.png](v2-screens/trade-planned-live-desktop.png),
[trade-closed-timeline-desktop.png](v2-screens/trade-closed-timeline-desktop.png),
[trade-planned-live-mobile.png](v2-screens/trade-planned-live-mobile.png).

## 16. Today redesign

ARCH §14.1; `src/components/today/today-screen.tsx`, loader `src/lib/today-data.ts`. Today answers within seconds:
- **Session ribbon** (`session-ribbon.tsx`): the current session, the next boundary, Dead Pool shaded.
- **Trading status per account** (`status-section.tsx`): "You can trade" or the exact block, trades left, risk left,
  today's result, realized losses today, and account-values freshness. Each reason has its action.
- **Live trades first** (`live-section.tsx`, `live-panels.tsx`): instrument, direction, account, entry, live duration,
  risk rounded up, and the last journal item, with inline Add note, Paste screenshot, Open and Close.
- **Plans waiting** (`plans-section.tsx`): drafts with their first blocking reason, and locked plans.
- **Today's closed trades** (`closed-section.tsx`) and the optional "Today's plan · notes".
- **Empty day:** two large actions.

All Accounts shows one compact status row per active account, and its totals cover the same trades.

Tests: `v2-screen-today.test.ts`, `v2-screen-today-loader.test.ts`, `v2-screen-today-model.test.ts`,
`v2-v1-replacements-today.test.ts`, `v2-today-data-losses.test.ts`. Acceptance step `ux/today`. Screens:
[today-desktop.png](v2-screens/today-desktop.png), [today-mobile.png](v2-screens/today-mobile.png),
[mobile-today-live-note-mobile.png](v2-screens/mobile-today-live-note-mobile.png).

## 17. Journal redesign

ARCH §14.5; `src/components/journal/journal-screen.tsx`, `load-journal.ts`, `trade-row.tsx`.
- **Rows:** thumbnail, instrument and direction, date and time, account, model (OB/OTE), planned risk %, realized R,
  P&L in the trade's own currency, state pill, origin badge, tags, and an AI-reviewed icon. Rows are grouped by trade
  date (entry, else lock, else creation day).
- **Paging:** keyset pages of 50 with the exact total ("Showing 50 of 312 trades").
- **Filters** (URL state, removable chips): account (in All Accounts also a read-only account filter), date range,
  result, state, origin, model, session, reviewed, AI-reviewed, tags, instrument, currency.
- **Search:** instrument, tag and note text. PostgREST filter syntax is stripped.
- **V1 bookmarks:** the keys `status`, `outcome`, `from` and `to` keep their V1 meanings; unreadable values are named
  in a notice, never silently dropped.

Tests: `v2-screen-journal.test.ts`, `v2-v1-replacements-presentation.test.ts`. Screens:
[journal-desktop.png](v2-screens/journal-desktop.png), [journal-mobile.png](v2-screens/journal-mobile.png). Large
histories: item 43.

## 18. EDGE redesign

ARCH §14.6; `src/components/edge/edge-screen.tsx`, `edge-data.ts`, `headline.tsx`, `results-charts.tsx`,
`breakdowns.tsx`, `definitions.tsx`, `performance-calendar.tsx`.
- **Filter row:** date range, account context or account filter, model, session, origin, instrument.
- **Headline:** Net R, Expectancy, Win rate, Profit factor, Max R drawdown and closed trades, with a sample caveat,
  and money per currency.
- **Charts** (item 19), the **calendar** (item 20), and **breakdowns** with drill-down links into the Journal.
- **Calculation definitions**, and a CSV export that reads the page's own query (`src/app/edge/export/route.ts`).
- **V1 links** keep their meanings; options with no V2 equivalent are named in a warning.
- **Read limit:** at most 20,000 closed trades (`MAX_LEDGER_ROWS`, `src/lib/performance-data.ts`), with a notice when
  more match.

Deterministic metrics are unchanged from V1 (`rMetrics` in `src/domain/performance.ts`, parity in
`v2-domain-performance.test.ts`).

Tests: `v2-screen-edge.test.ts`, `edge-routes.test.ts`, `v2-data-export.test.ts`, `analytics.test.ts`. Screens:
[edge-desktop.png](v2-screens/edge-desktop.png), [edge-desktop-dark.png](v2-screens/edge-desktop-dark.png). Load
times at scale: item 43.

## 19. Charts added

ARCH §13.6; `src/components/charts/`. Hand-written SVG with server-rendered geometry and a small client tooltip layer.
Every chart:
- names the trading question it answers and shows its sample size;
- has a Table toggle and a text summary (ARCH §13.5);
- drills down on click;
- uses one y-axis;
- uses colours validated for colour-vision deficiency and contrast in light and dark themes (ARCH §13.1 chart tokens,
  `src/app/globals.css`).

| Chart | Question | Where |
|---|---|---|
| Cumulative R (line + area) | Is the process compounding? | EDGE, account dashboard |
| R drawdown | Where am I giving profits back? | EDGE, account dashboard |
| Daily net R / net P&L (diverging bars; P&L per currency) | Which days drive results? | EDGE, account dashboard |
| Calendar heatmap | When am I winning or losing? | EDGE, account dashboard |
| R distribution (0.5R bins) | How are outcomes distributed? | EDGE |
| Breakdown bars (model, session, weekday, origin, account, risk %, strategy and risk version) | Which conditions perform? | EDGE |
| Account contribution | Which account contributes most? | EDGE (All Accounts) |
| Balance from trades (own currency) | How has this account's recorded balance moved? | Account dashboard |

Long series stay light (ARCH §13.6, `src/components/charts/thinning.ts`): above 300 points a line chart keeps marks,
tooltips, links and table rows only for one point per run of ⌈count / 300⌉ plus the first, the last and the deepest
drawdown, and draws min/max-decimated paths, so every swing keeps its depth; the table says which points it lists and
that the Journal lists every trade. Daily bars show the last 30 (dashboard) or 120 (EDGE) trading days with exits.

Tests: `v2-ui-charts.test.ts`, `v2-ui-chart-thinning.test.ts`, `v2-screen-edge.test.ts` (long history). Load times of
very long histories are in item 43 (GAPS §3).

## 20. Performance calendar

ARCH §13.6, §14.6.
- **Month heatmap** with modes Net R, Net P&L (one currency at a time), Gross realized loss and Trade count
  (`src/components/edge/performance-calendar.tsx`, `src/components/charts/calendar-heatmap.tsx`, `calendar.ts`).
- **Days are strategy days (UTC−5) of the exit** (`calendarMonth` in `src/domain/performance.ts`). Zero-trade days are
  distinct from break-even days.
- **Drill-down:** clicking a day opens a sheet with that day's trades, linking to each trade and its evidence
  (`src/components/edge/day-sheet.tsx`).
- **Scope:** All Accounts (R across accounts, money per currency) or one account; the account dashboard has its own
  calendar.
- **Small samples:** day cells name the trades without a recorded risk ("2 closed trades · 1 without risk").

Tests: `v2-domain-performance.test.ts` (calendar buckets on the UTC−5 exit day), `v2-ui-charts.test.ts`,
`v2-screen-edge.test.ts`. Acceptance step `analytics/calendar-day`. Screen:
[edge-calendar-day-desktop.png](v2-screens/edge-calendar-day-desktop.png).

## 21. AI-output redesign

ARCH §11.1.
- **Concise card by default**, designed for a 10–20 second read. Pure summarizers (`src/domain/ai-summary.ts`) take
  the first sentence of the headline field and at most 2 items per section over the stored output shapes. Each
  operation keeps its own purpose and sections (spec §21):
  - Analyze Setup: Setup, Strengths, Weaknesses, Invalidation, AI observation, Evidence;
  - Challenge My Bias: why the thesis might be wrong, Invalidation, Missing evidence, Questions;
  - Review Trade: headline, thesis check, execution vs plan, live management, key lesson;
  - periodic reviews: Went well, Needs attention, Focus next.
- The **Risk Engine status line** leads pre-trade cards.
- **View full analysis** opens a side sheet with every section and citation (`src/components/ai/full-analysis-sheet.tsx`).
- **Friendly source chips** (`resolveSourceChip`; `src/components/ai/source-chip.tsx`): "M5 chart", "Trade plan",
  "Risk Engine", "Live note · 09:45" and so on. A chip opens the screenshot or scrolls to the timeline item; raw ids
  appear only in Technical details.
- **AI history** shows compact rows ("Analyze Setup · Completed · 08:00"). Failed rows state the accounting outcome
  in plain words (`src/components/ai/ai-history-list.tsx`).
- No AI runs on page load or without an explicit click; no numeric score is invented.

Tests: `v2-domain-ai-summary.test.ts`, `v2-ui-ai-components.test.ts`, `v2-ui-ai-panels.test.ts`, `v2-ai-history.test.ts`,
`v2-ai-periodic-chip-target.test.ts`. Acceptance: spec §60.16 in item 42. Screens:
[ai-analyze-setup-concise-desktop.png](v2-screens/ai-analyze-setup-concise-desktop.png),
[ai-review-trade-concise-desktop.png](v2-screens/ai-review-trade-concise-desktop.png),
[ai-review-trade-full-desktop.png](v2-screens/ai-review-trade-full-desktop.png).

## 22. Timeline-aware AI review

ARCH §11.4; `0018_trade_ai_timeline.sql` part 2.
- **Operation** `REVIEW_TRADE_TIMELINE`: mini model, at most 4 images, 24,000 input and 4,000 output tokens, no tools.
  The V1 `REVIEW_TRADE` stays for history only; V2 cannot start it (`v2-ai-entry-points.test.ts`).
- **Records:** tables `trade_timeline_reviews` and `trade_timeline_review_results` (any origin, keyed by the trade).
  The service-only `start_`, `authorize_` and `finish_trade_timeline_review` require an owned, closed trade, one
  in-flight review per trade, evidence of the same trade that is not removed and whose sha256 matches, and SETTLED
  usage for COMPLETED.
- **Facts** `REVIEW_TRADE_TIMELINE_FACTS_V1` (`src/ai/trade-timeline-review-context.ts`):
  - `planStatus` (`LOCKED_PLAN` or `NO_PLAN_RECORDED`);
  - the locked plan, strategy rules (no written prompt), risk version and stored verdict;
  - execution facts;
  - every timeline item and screenshot with its Trading OS timing (`BEFORE_ENTRY`, `WHILE_LIVE`, `AFTER_CLOSE`) and
    flags;
  - V1 decisions as their own items.
- **Deterministic validation** (`src/ai/trade-timeline-review-contract.ts`, `src/ai/trade-timeline-review-sources.ts`):
  - the thesis check may cite only plan, strategy, risk-version, Risk Engine and Before-entry sources
    (`HINDSIGHT_CITATION`);
  - `NO_PLAN_RECORDED` forces the thesis check to `NOT_RECORDED` or `INSUFFICIENT_EVIDENCE` and execution vs plan to
    `NO_PLAN`;
  - every reference must be in the manifest;
  - trading directives are rejected.

  Failures persist as FAILED with the raw output, and charged usage is still accounted.
- **Prompt rules:** facts are separated from interpretation; nothing about motives, timestamps or causality is
  invented; After-close text is hindsight, never pre-entry evidence.

Tests: `v2-ai-timeline-contract.test.ts`, `v2-ai-timeline-review.test.ts`, `v2-ai-database.test.ts`. Acceptance step
`ai/review-trade`.

## 23. Technical-details/debug separation

ARCH §0.9, §13.9, §15.
- **Default UI shows no raw internals:** no UUIDs, hashes, provider or response ids, raw JSON, prompts, rule codes or
  backend state names. SQL errors map to human copy (`SQL_ERROR_COPY`, `src/app/actions/state.ts`).
- **Technical details** is a collapsed disclosure (`src/components/ui/technical-details.tsx`) for ids, versions, raw
  reports, manifests, hashes, provider, model and token usage.
- **Developer mode** (Settings → Developer, cookie `tos_dev`, `DEVELOPER_COOKIE` in `src/lib/account-context.ts`;
  `src/components/settings/developer-settings.tsx`) opens these disclosures by default.
- **The strategy card** replaces V1's raw strategy prompt (`src/domain/strategy-card.ts`).
- **The developer component gallery** `/dev/ui` answers 404 in a production build (`galleryEnabled` in
  `src/app/dev/ui/page.tsx`).
- No core workflow needs Technical details (spec §60.13).

Tests: `v2-screen-trade.test.ts` ("keeps ids, versions and raw reports inside Technical details, opened by developer
mode"); raw-id scans of rendered markup in `v2-screen-*.test.ts`; `v2-domain-strategy-card.test.ts`. Browser text scan:
574 scans of 18 screens (42 screen, viewport and theme combinations), 0 with raw internals.

## 24. Trading Accounts architecture

ARCH §3.2, §9.1–§9.2.
- **Records:**
  - `accounts` (V1) plus append-only `account_profiles` revisions: display name, broker, platform (`MANUAL`,
    `CTRADER`, `MT5`, `MT4`, `TRADINGVIEW`, `OTHER`), type (`DEMO`, `EVALUATION`, `FUNDED`, `PERSONAL`, `OTHER`),
    starting balance, status (`ACTIVE`, `ARCHIVED`);
  - 18 allowed currencies;
  - instrument versions per account (`create_instrument_version`);
  - account values (`record_account_values`).
- **Creation** (`create_trading_account`, idempotent) writes, in one call: the account, its first balance/equity
  observation, the ICT V1.0 strategy (copied byte-identical from a template extracted at migration time, ARCH §3.1),
  Risk Plan V1.0, the default instruments and a profile.
- **Archive instead of delete:** while archived, every RPC that would start new activity refuses (`ACCOUNT_ARCHIVED`,
  `private.require_active_account`). History stays readable, existing trades can be finished, and turning AI off stays
  possible. Restore re-enables everything.
- **Context:**
  - cookie `tos_account` (`all` or an account id), with `?account=` overriding it for a page load (ARCH §9.2);
  - `getAccountContext` (`src/lib/account-context.ts`) resolves an unknown, foreign or archived id to All Accounts
    with a notice, never to "the first account";
  - sign-in keeps only the person's own ids (`keepOwnAccountContext`); sign-out, password reset and deletion clear
    both context cookies;
  - Plan Trade and Record Live Trade always show an explicit account field.

Files: `src/app/actions/accounts.ts`, `src/components/accounts/*`, `src/components/shell/account-selector.tsx`,
`context-sync.ts`. Tests: `v2-actions-accounts.test.ts`, `v2-integrity-archived-accounts.test.ts`,
`v2-integrity-archived-actions.test.ts`, `v2-proxy.test.ts`, `v2-ui-context-sync.test.ts`, `v2-screen-accounts.test.ts`.
Acceptance flow `accounts`.

## 25. All Accounts aggregation methodology

ARCH §9.3. All Accounts is a context, never a record: no table row, id or placeholder represents it, and every path
that needs an account (planning, recording, risk checks, AI budgets and consent) receives an explicit account id.

| Measure | Across accounts | Rule |
|---|---|---|
| Trade counts, win/loss/break-even counts, win rate | Yes | Per-trade counts |
| Realized R (net R, expectancy, R curve, R drawdown) | Yes, labelled "R is per-trade risk units, not money" | Each trade's R is normalised by its own initial risk; drawdown over the combined exit-ordered sequence; trades without a risk basis excluded with a visible count |
| Money (P&L, fees, gross realized loss) | Only within one currency | Grouped by currency ("+$1,420.00 · +€380.00"); never converted; no FX |
| Percent returns, balances, equity | No | Per account only |
| Account contribution | Per account | Each account's trades, net R, net P&L in its currency, share of total R |

Small-sample bands apply to every aggregate (ARCH §13.8). AI periodic reviews stay per account (budgets, consent and
the SQL scope check are per account; ARCH §11.5). Code: `moneyByCurrency`, `accountContribution`
(`src/domain/performance.ts`), `accountCurrencyTotals` (`src/domain/account-metrics.ts`). Tests:
`v2-domain-performance.test.ts`, `v2-domain-account-metrics.test.ts`, `v2-screen-accounts.test.ts`. Screen:
[accounts-desktop.png](v2-screens/accounts-desktop.png).

## 26. Individual account dashboard

ARCH §9.4, §14.8; `src/app/(app)/accounts/[id]/page.tsx`, `src/components/accounts/account-dashboard.tsx`,
`src/lib/accounts-data.ts`, `src/domain/account-metrics.ts`.
- **Header:** name, type, broker and platform, currency, status; Plan Trade and Record Live Trade on this account.
- **Value cards:** last recorded balance and equity (user-reported, with date), starting balance, realized P&L in
  Trading OS, and "Starting balance + realized P&L recorded in Trading OS". The last one is never called equity, and a
  value not known deterministically is "—" with a reason.
- **Charts:** balance from trades, cumulative R, R drawdown, daily P&L (last 30 trading days with exits).
- **Below the charts:** the calendar; recent and live trades (live trades read from the account's open trades); model
  and session performance with N and "without risk" counts; risk-plan history; quick links to the account's Journal,
  EDGE and Manage. Chart points and calendar days drill into trades.
- **Above 20,000 trades** the results, charts, calendar and groups are replaced by "More trades than this page can
  add up", with links to EDGE and the Journal; nothing partial is shown.

Tests: `v2-screen-accounts.test.ts`, `v2-domain-account-metrics.test.ts`, `v2-perf-ledger-reads.test.ts`. Acceptance
step `accounts/account-dashboard`. Screen: [account-dashboard-desktop.png](v2-screens/account-dashboard-desktop.png).

## 27. Existing-data migration strategy

**No "legacy default account" was needed.** Every V1 record already carries an explicit trading account (`accounts`
with `user_id`; every V1 proposal and plan references `(user_id, account_id)`), so no orphan is possible (ARCH §2.1).
The strategy (0015 backfill, ARCH §3.2–§3.3; spec §37):

- **Insert-only, deterministic backfill.** Each `trade_plans` row becomes one `PLANNED` trade (`migrated_from
  'V1_PLAN'`) with its plan link and its linked proposal as revision 1. Each unlocked `setup_proposals` row becomes one
  `PLANNED` trade (`migrated_from 'V1_PROPOSAL'`). Creation times come from the V1 records; `request_key` is null.
- **Profiles.** Each V1 account gets one `account_profiles` row with `source 'MIGRATION'`: its V1 name, platform
  `MANUAL`, type `DEMO` (V1 enforced demo), starting balance from its earliest observation, `ACTIVE`.
- **V1 meanings are kept:**
  - V1 human decisions (Taken, Skipped, taken despite a block) feed the lifecycle and the timeline;
  - V1 tags show read-only until V2 tags are set;
  - V1 screenshots join the gallery;
  - risk reports 1.0 and 1.1 still parse and explain;
  - V1 AI history renders;
  - `journal_analytics` is untouched.
- **Nothing historical is rewritten:** no V1 row is updated or deleted, and migrations 0001–0014 are byte-identical to
  `bc5441c` (`git diff --name-only bc5441c -- supabase/migrations/` lists only 0015–0019).
- **Bypasses closed:** V1 entry points that could create records outside the trade model are revoked from
  `authenticated` in 0019; `check_setup_risk` stays granted but is trade-aware (ARCH §10.4).
- **One-way:** the V1 app cannot run on a V2 database (DEPLOY "Rollback").

**Automated evidence:** `v2-v1-migration.test.ts` builds a representative V1 database through the V1 RPCs (0001–0014
only), snapshots every table, applies 0015+, and checks the mapping, the counts, ownership and that no history row
changed. `v2-ledger-parity.test.ts` checks lifecycles of V1 history after the upgrade.

**Upgrade-path evidence from the gate** on local PostgreSQL 17 (procedure in DEPLOY "Procedure" step 3):
- Source: the full replay of the round-2 verification on 2026-11-08 (16:47 UTC, in the Kill zone, so the V1 locks were allowed), with migrations identical to the final ones except the `linked_disposition_guard` trigger appended to 0017 afterwards, which the final fresh-apply catalog comparison covers. Started from `reset.mjs --through=0014`. V1 data was created through the V1 RPCs,
  as two synthetic users:
  - a plan locked, filled, journaled twice, marked TAKEN, closed at +1.97R and tagged;
  - a plan locked and skipped;
  - a blocked draft with a V1 screenshot;
  - a filled plan left open;
  - AI on with a budget, and a stored V1 weekly review produced by the V1 code at `bc5441c`;
  - for the second user, one closed loss.
- `start.mjs` applied 0015–0019 (exit 0).
- All 92 V1 rows in 25 tables and the stored screenshot object were unchanged after the upgrade (0-line snapshot diff).
- 5 plans → 5 trade links; every plan and proposal maps to exactly one trade; V1 statuses and numbers agree with the V2 ledger (CLOSED → CLOSED with equal R and net P&L, SKIPPED → SKIPPED, TAKEN with fill → LIVE).
- The V1 decision, journal counts and tags carry over; the blocked draft is Draft/Blocked with its V1 screenshot; all 3 accounts got a MIGRATION profile; the AI budget and the V1 weekly review are preserved.
- RLS still isolates the users (5 trades for the owner, 1 for the other user).
- The V2 app read the upgraded data: 9 pages answered 200 with 0 console errors (closed trade with its full V1 timeline, Journal without the other user's trade, blocked draft with its V1 image, live trade, Review › Weekly with the V1 review).

## 28. Review workspace

ARCH §11.5, §14.10; `src/app/(app)/review/**`, `src/components/review/*`, `src/components/ai/periodic-review-panel.tsx`.
- **Tabs:** Weekly · Recent trades · Monthly · History.
- **Scope is explicit:** an account chooser in All Accounts, and every card states its scope ("FTMO 100K · Week of
  Oct 6–12 (UTC−5) · 8 trades").
- **Cards and budget:** concise cards with friendly sources, the budget summary, and the estimate on the run button.
- **Bounds** (`src/ai/periodic-limits.ts`): a week of at most 20 trades and 70 records; Recent 10, 20 or 30 trades; a
  month of at most 120 trades. Whether a sample fits is decided by the pre-flight estimate
  (`src/ai/request-estimate.ts`) before anything is reserved.
  - Refusals state the rule; nothing is silently left out.
  - Recent Trades names the largest sample that fits.
  - A month too large for detail is reviewed as an announced deterministic summary.
  - A week is reviewed whole or not at all.
- **One run at a time:** a running review of the same period makes the button wait with the reason.
- **Not included yet:** live-first and imported trades are not included in periodic AI reviews; the page counts them
  (item 43).
- **History** lists every request, with View full analysis on every completed row.
- **Placement:** Review This Trade stays on the trade page; Analyze Setup and Challenge My Bias stay in the plan
  section (spec §39).

Tests: `v2-screen-review.test.ts`, `v2-screen-review-model.test.ts`, `v2-ai-periodic-facts.test.ts`,
`v2-ai-periodic-panel.test.ts`, `v2-ai-periodic-database.test.ts`, `v2-ui-ai-panels.test.ts`. Acceptance steps
`ai/weekly`, `ai/recent`, `ai/monthly`. Screen: [review-weekly-concise-desktop.png](v2-screens/review-weekly-concise-desktop.png).

## 29. AI budget UX

ARCH §11.2; spec §40.
- **Summary line:** "AI usage this month · €0.74 of €5.00 · €4.26 left · resets Nov 1", with one status chip (On,
  Off, Limit reached, Paused — needs review, Unavailable). There is one per trading account; All Accounts shows a
  compact row per account (`src/components/ai/ai-budget-summary.tsx`).
- **Every paid button shows an estimate** ("≈ €0.02"), with a tooltip on the maximum reserved and the release of
  unused funds (`estimateAiCost` in `src/domain/ai-summary.ts`, `src/components/ai/estimate.ts`).
- **Details live in Settings → AI → Details:** held amounts, dispositions, uncertainty, provider and model.
- **A held (uncertain) reservation is explained plainly** wherever AI is offered: what happened, that nothing beyond
  the held amount was charged, and that the account's AI is paused until an audited resolution
  ([AI_ACCOUNTING_RESOLUTION.md](AI_ACCOUNTING_RESOLUTION.md)).
- **Consent and archived accounts:**
  - turning AI on needs explicit consent per account;
  - turning it off is one action, also on an archived account (`ArchivedAiControls` in
    `src/components/settings/ai-account-controls.tsx`; the database allows it, `set_account_ai_preferences` in 0015);
  - the AI settings actions refuse writes on an outdated schema (`writableSession`, `src/lib/schema-gate.ts`, used by
    `src/app/ai-settings-actions.ts`).

Tests: `v2-ui-ai-components.test.ts`, `v2-ai-held-reservation.test.ts`, `v2-domain-ai-summary.test.ts`,
`v2-screen-settings.test.ts`, `v2-v1-replacements-ai-settings.test.ts`, `ai-settings.test.ts`. Acceptance steps
`ai/budget-summary`, `ai/history-and-budget`, `ai/failure-accounting`, `settings/ai-consent`. Screens:
[ai-failure-accounting-desktop.png](v2-screens/ai-failure-accounting-desktop.png),
[settings-desktop.png](v2-screens/settings-desktop.png).

## 30. Connections architecture

ARCH §8.6; `0017_platform_connections.sql`; `src/domain/sync/*`; `src/lib/sync-service.ts`.
- **Records:**
  - `platform_connections` (provider `CTRADER`, `MT5` or `MOCK`; a masked display reference, never a secret);
  - append-only `platform_connection_events` (Pending, Connected, Syncing, Synced, Error, Disconnected, with human
    messages);
  - `external_executions`, unique on `(connection_id, external_id)` with a payload hash;
  - appended `external_execution_closes`;
  - append-only `trade_execution_links` (`LINK` / `UNLINK`; method `AUTO_MATCH`, `USER` or `IMPORT_CREATED`);
  - overview views;
  - `private.platform_connection_secrets` (no grants; unused in V2).
- **Ingest is service-only** (`ingest_external_execution`):
  - deduplicates by external id; an identical payload is a no-op;
  - a position first seen open and later closed appends its close;
  - any other change becomes a warning event and never overwrites;
  - the decision is CREATE (imported trade), LINK (a planned trade, re-validated) or HOLD (ambiguous, unlinked);
  - an archived account defers new positions and syncs the rest.
- **User RPCs:** `create_platform_connection` (only `MOCK`; `CTRADER` and `MT5` raise `PROVIDER_NOT_AVAILABLE`),
  `disconnect_platform_connection`, `link_external_execution`, `unlink_external_execution`.
- **A linked plan cannot be skipped or cancelled** (trigger `linked_disposition_guard`, `EXECUTION_LINKED`).
- **TypeScript:**
  - `ExecutionSyncProvider` (`readOnly: true`, `fetchPositions(since)`; `src/domain/sync/contract.ts`);
  - `normalizeExternalPosition` (strict zod, canonical decimals);
  - `matchExecution` (item 34);
  - `MockSyncProvider` (deterministic fixtures);
  - `runSync`, which runs one sync end to end;
  - `syncConnection` on the server.
- **"Simulate sync"** exists only with `TRADING_OS_ENABLE_MOCK_SYNC=true` (`isMockSyncEnabled`), which DEPLOY forbids
  on Preview and production.
- **UX:** Settings → Connections shows Manual (active), cTrader ("Read-only sync planned for V2.1") and MetaTrader 5
  ("Bridge planned for V2.2"), and never claims connectivity that does not exist. Manage → Connection lists unmatched
  and linked executions with tickets, platform notices and warnings.

Tests: `v2-domain-sync.test.ts`, `v2-connections-database.test.ts`, `v2-connections-sync-database.test.ts` (the real
sync path over PGlite, owner reads under RLS, ingest as service role), `v2-connections-service.test.ts`,
`v2-connections-actions.test.ts`, `v2-data-connections.test.ts`. Acceptance step `settings/connections`.

## 31. cTrader V2.1 readiness

**V2 ships only the MOCK provider, on purpose.**
- **Spec boundaries:** spec §4, §42 and §62 defer real cTrader and MetaTrader sync and forbid guessing undocumented
  API behaviour.
- **Risk exposure:** GAPS §1.2 records that the daily limits do not yet see platform executions that are held,
  unlinked or unrecorded on a trade; DEPLOY's hard rules require closing it before any real provider is accepted.
- **No credentials or paid traffic:** no provider credentials and no external API traffic were in scope or available.

**What is ready for cTrader** (ARCH §8.6):
- **Data model:** provider value `CTRADER`, connection events, executions deduplicated by external id, appended
  closes, and append-only links with provenance.
- **Provider-neutral contract:** `ExecutionSyncProvider` declares `readOnly: true` and has only `fetchPositions`, so
  no order capability exists.
- **Pipeline:** normalization, deterministic matching, and service-only ingest called by the trusted server.
- **UX copy and permission scope:** "Read-only: account, positions, deals, balances. Trading OS never requests trading
  permission." (`READ_ONLY_SCOPE`, `src/lib/sync-service.ts`).
- **Credential storage:** a server-only table exists (`private.platform_connection_secrets`, unused in V2; it cascades
  with the connection, so erasure removes it).

**What V2.1 must add before `create_platform_connection` accepts `CTRADER`:**
1. Executions count toward daily usage by their own facts whatever their link state, with a new engine version label
   (GAPS §1.5).
2. "Import as a new trade" for held executions (`import_external_execution`), and optionally an append-only dismissal
   that never removes the execution from the limits (GAPS §1.5).
3. Contract attachment by normalized symbol, and the platform's contract specification and stop at entry where the
   official API provides them (GAPS §2.3).
4. A cTrader provider implementing `ExecutionSyncProvider` against the verified official API, with its OAuth tokens
   sealed server-side. This is design only; none of it exists in V2.

## 32. MetaTrader V2.2 readiness

From ARCH §8.6 "MetaTrader 5 readiness" (design only; spec §43):
- **A local bridge, not an invented API.** MetaTrader offers no consumer OAuth, so V2.2 plans an Expert Advisor or a
  small companion program next to the terminal.
- **What the bridge sends:** only what the provider-neutral contract already accepts, namely read-only positions and
  deals normalized by `normalizeExternalPosition`, and account balances.
- **Per-connection authentication:**
  - the trader creates an MT5 connection, and the server issues a bridge credential for that one connection (shown
    once, stored only as a hash, revoked on disconnect);
  - the bridge posts to a server route that verifies the credential and resolves the connection and its owner;
  - the server then calls `ingest_external_execution` and `record_platform_sync_status` with the service role, exactly
    as the mock sync does.
- **What the bridge never gets:** Supabase keys, the service-role key or a user session. It has no order capability:
  the contract has no order, modify or close operation.
- **Same pipeline:** matching, deduplication, warnings, imported trades and links work as for any provider.

**State in V2:** `create_platform_connection` refuses `MT5` (`PROVIDER_NOT_AVAILABLE`, 0017). No bridge credential
table or route exists yet (no "bridge" object in `supabase/migrations/` or `src/`). The GAPS §1.5 prerequisite applies
to MT5 exactly as to cTrader.

## 33. Imported-trade model

ARCH §3.5, §8.6; spec §45.
- **Creation:** an `IMPORTED` trade is created only by service-role ingest from a platform execution, with:
  - `trade_position_facts` with `source 'IMPORT'`;
  - when exit data is present, a `trade_unplanned_closes` row with `pnl_source 'IMPORTED'`, the platform's realized
    P&L taken as net P&L;
  - a link `IMPORT_CREATED`.
- **Provenance:** the execution keeps the connection, external id, payload hash and received time; a later change is
  a warning event, never an overwrite.
- **No plan is fabricated:** the trade shows "No pre-trade plan was recorded before execution.", gets no pre-trade AI
  tools, and accepts live and post-trade journal entries, screenshots, tags and a review.
- **R:** only with a risk basis. A contract is attached only when the account's latest version of the exact symbol
  fits the position's grid; otherwise R needs a risk recorded while the trade is open (GAPS §2.1–§2.2).
- **Counted like live-first:** imported trades take slots, add risk and realized losses in daily usage, and appear in
  Journal, EDGE and export with an Imported badge.
- **Known gaps:** held or unlinked executions can only be linked to a planned trade (GAPS §1.1); see item 43.

Tests: `v2-connections-database.test.ts` (dedup, close appended, changed payload as warning, CREATE/LINK/HOLD, contract
attachment on the grid only), `v2-connections-sync-database.test.ts`. Acceptance step `settings/connections` (imported
trades appear in the Journal; disconnect keeps them).

## 34. Plan ↔ execution matching design

ARCH §8.6; `matchExecution` in `src/domain/sync/match.ts`; spec §46.
- **Candidates:** planned trades of the same account, normalized symbol and direction that are LOCKED or LIVE
  without a link, were locked before the external entry, and whose external entry is within 30 minutes after the lock
  and within `max(20 ticks, 25 % of the planned stop distance)` of the planned entry.
- **Result:** exactly one candidate gives `UNIQUE` (auto LINK, method `AUTO_MATCH`); several give `AMBIGUOUS` (HOLD:
  stored unlinked, listed under "Unmatched executions" for the trader to confirm); none gives `NONE` (CREATE an
  imported trade).
- **Manual Link / Unlink** (`link_external_execution`, `unlink_external_execution`): append-only rows, method
  `USER`. Link candidates come from the account's linkable plans, read once (`loadLinkablePlans`,
  `linkCandidatesFor`): LOCKED, LIVE, CLOSED or REVIEWED, locked at or before the entry, not yet linked. The database
  re-validates account, symbol and direction.
- **Comparison:** the trade page's Plan vs reality (item 15) compares planned and recorded entry, size, risk at stop,
  exit and R. A platform close of a linked plan is stored but not applied automatically; Manage → Connection flags it
  ("Closed on the platform, but the trade is still open in Trading OS…").

Tests: `v2-domain-sync.test.ts` ("matchExecution (spec §8.6)"), `v2-connections-database.test.ts`,
`v2-connections-service.test.ts`, `v2-data-connections.test.ts`.

## 35. Account deletion implementation

ARCH §10.4; `0019_account_erasure.sql`; `src/lib/erasure.ts`; `src/app/actions/erasure.ts`;
`src/components/settings/delete-account.tsx`.

**Database:**
- **Scoped delete exception:** `private.reject_mutation` allows DELETE only while the transaction-local
  `trading_os.erase_user_id` equals the row's `user_id`. UPDATE is never allowed.
- **`public.purge_user_trading_data(p_user_id, p_confirm)`** is executable by `service_role` only, so no user token
  can call it. It:
  1. requires the server constant `'ERASE ALL MY TRADING OS DATA'`;
  2. locks the user's accounts and refuses while an AI request is in flight (`AI_REQUEST_IN_PROGRESS`);
  3. collects storage paths;
  4. deletes from every public table in a foreign-key order computed from the catalog, so future tables are covered;
  5. verifies that no row remains (`PURGE_INCOMPLETE: <table>` rolls back everything);
  6. writes a de-identified receipt (`private.erasure_receipts`, no user id or email).
- **Connection secrets** cascade with their connection.
- **Guards and indexes:** statement-level TRUNCATE guards on every public table, and foreign-key lookup indexes.

**Server action** `deleteTradingOsAccount`:
1. The user typed `DELETE` exactly and re-entered the password. A non-persisting client verifies it for the session
   user, and that verifier session is signed out again.
2. The trusted server calls the purge in one transaction.
3. Storage objects in both buckets are deleted, then the `{uid}/` prefixes are swept until empty.
4. Global sign-out, `auth.admin.deleteUser`, the auth and context cookies cleared, and a redirect to
   `/login?reason=account_deleted`.
5. Every step is idempotent; on failure the copy says nothing was shared and a retry is safe.

The UI lists exactly what is deleted, states that it cannot be undone, and suggests Export my data first.

Tests: `v2-erasure-database.test.ts` (two users, every table populated, flag scoping, UPDATE never allowed,
completeness rollback, idempotent re-run, AI in-flight refusal, TRUNCATE guard, no user token of any age can call a
purge function), `v2-erasure-service.test.ts`. Acceptance step `settings/delete-account`, on a synthetic user:
- a wrong password deletes nothing;
- after deletion no row in any tenant table, no auth user, no storage object or file remains;
- one de-identified receipt is written;
- another user's rows are unchanged;
- no context cookie is left.

## 36. Export implementation

ARCH §10.5; `src/app/api/export/route.ts`, `src/lib/export.ts`, `src/lib/zip.ts`, `src/components/settings/export-data.tsx`,
`export-archive.ts`.
- **Endpoint:** `GET /api/export?part=core|trades|ai|evidence-manifest|trades-csv`. It is authenticated, reads with the
  user's own session (RLS) in keyset order, and returns `private, no-store` attachments with numerics as exact
  strings.
- **Parts:**
  - `core`: profile, accounts and profiles, strategy, risk-plan and instrument versions, observations, external losses,
    configuration events, daily contexts;
  - `trades`: every trade record, V1 and V2;
  - `ai`: all AI requests, results and accounting;
  - `evidence-manifest`: every screenshot with its timing band, computed exactly as the trade page computes it, and
    paged per table for large accounts;
  - `trades-csv`: one row per trade, formula-injection guarded.
- **Download my data (.zip):** the browser fetches the parts (and the images when "Include screenshots" is ticked),
  builds the ZIP locally (store method, CRC32), and checks each image's SHA-256 against the manifest. Export is
  separate from deletion.

Tests: `v2-export.test.ts`, `v2-zip.test.ts`, `v2-data-export.test.ts`, `v2-screen-settings-export.test.ts`. Acceptance
step `settings/export`: the ZIP is downloaded and checked; every part belongs to the user, every table holds exactly the
user's rows, no other user's id or email appears, there is one CSV row per trade, and every screenshot is present with
its SHA-256.

## 37. Mobile/desktop strategy

ARCH §13.3, §14; spec §51.
- **Desktop (≥ 1024 px):**
  - a collapsible sidebar and a top bar with account selector, strategy clock, Search and both primary actions;
  - two-column trade page (Plan, Execution, Result, Review | Live journal, Evidence);
  - Plan Trade with the live risk preview in a side column;
  - keyboard: palette, `P`, `L`, `J`, `?`, Ctrl/⌘+Enter, Ctrl/⌘+V.
- **Tablet (768–1023 px):** icon rail and top bar.
- **Phone (< 768 px):**
  - compact top bar and bottom tab bar `Today · Journal · (+) · Accounts · More`, where (+) opens Plan Trade / Record
    Live Trade (`src/components/shell/mobile-tab-bar.tsx`);
  - Record Live Trade is mobile-first;
  - live trades put the journal first;
  - the camera is offered for screenshots;
  - Today's live card takes a note with taps only;
  - the gallery is 2-up, hit targets are at least 44 px, and long account names wrap instead of widening the page.

Evidence: acceptance at 393×852 with touch for every flow (item 41), and the phone-width check
every phone screen reached fits 393 px. `v2-ui-account-name-chips.test.ts`,
`v2-screen-today-model.test.ts`. Phone screens in item 45.

## 38. Database migrations

Additive only; 0001–0014 unchanged since `bc5441c`; existing functions change only through `create or replace` in a
new file; every file ends with `notify pgrst, 'reload schema'`; `0019` must stay last (ARCH §0.2, §4; DEPLOY
"Migrations").

| Migration | Tables and views | Main functions |
|---|---|---|
| `0015_canonical_trades.sql` | `trades`, `trade_revisions`, `trade_plan_links`, `trade_lifecycle_events`, `trade_position_facts`, `trade_unplanned_closes`, `trade_journal_entries`, `trade_evidence` (+ `_removals`, `_labels`), `trade_tag_sets`, `external_loss_entries` (+ `_removals`), `account_profiles`, view `trade_ledger`, `private.strategy_templates`; bucket `trade-evidence`; column `risk_plan_versions.default_risk_percent`; currency allow-list | `create_trading_account`, `update_account_profile`, `create_instrument_version`, `record_account_values`, `create_planned_trade`, `revise_trade_draft`, `duplicate_trade_draft`, `discard_trade_draft`, `check_trade_risk`, `lock_trade`, `record_planned_entry`, `close_planned_trade`, `set_planned_disposition`, `record_live_trade`, `complete_live_entry`, `close_live_trade`, `add_journal_entry`, `register_trade_evidence` (service), `remove_trade_evidence`, `relabel_trade_evidence`, `set_trade_tags`, `complete_trade_review`, `reopen_trade_review`, `add_external_loss`, `remove_external_loss`, `create_risk_policy_version`, `private.active_risk_plan`, `private.trade_phase`, `private.plan_ended_at`, `private.require_active_account`, `trading_os_schema`; redefined V1 `check_setup_risk`, `save_setup_proposal`, `save_daily_context`, `set_account_ai_preferences`; backfill |
| `0016_risk_engine_usage.sql` | — | `private.daily_usage`, `get_daily_risk_usage`, `private.risk_report_v12`; every engine path uses the active risk plan and today's usage |
| `0017_platform_connections.sql` | `platform_connections`, `platform_connection_events`, `external_executions`, `external_execution_closes`, `trade_execution_links`, views `platform_connection_overview`, `external_execution_status`, `private.platform_connection_secrets` | `create_platform_connection`, `disconnect_platform_connection`, `ingest_external_execution` (service), `record_platform_sync_status` (service), `link_external_execution`, `unlink_external_execution`; trigger `linked_disposition_guard` |
| `0018_trade_ai_timeline.sql` | `trade_timeline_reviews`, `trade_timeline_review_results`, `ai_request_generations`, view `trade_ai_activity`; `trade_ledger` redefined | `start_`/`authorize_`/`finish_trade_timeline_review` (service); redefined `start_bias_challenge`, `authorize_bias_challenge`, `start_weekly_ai_review`, `start_recent_ai_analysis`, `start_monthly_ai_review`, `dispatch_account_ai_request`, `settle_account_ai_request` |
| `0019_account_erasure.sql` | `private.erasure_receipts`; TRUNCATE guards; foreign-key indexes | `purge_user_trading_data` (service); redefined `private.reject_mutation`; revokes (item 39) |

**Verification:**
- Every database test applies all 19 migrations to an in-memory PostgreSQL 18 (PGlite, `tests/helpers/pglite.ts`).
- The local stack applies them to PostgreSQL 17 (`scripts/local-stack/reset.mjs`, `status.mjs`, `verify.mjs`).
- Gate results: reset 19/19 applied, no public table granted to `anon`, verify 10/10, and
  the catalog of the working database and of a fresh one compared over the migration ledger, grants, RLS flags,
  columns, constraints, policies, triggers, indexes, views and every function definition:
  identical: the live database and a fresh apply of 0001–0019 give byte-identical catalog dumps (8,186 lines: columns, constraints, policies, triggers, indexes, views, grants and every function's definition).

**Release note.** `0015_canonical_trades.sql` and `0017_platform_connections.sql` were edited after they had been
applied to the local development database, and to no other database:
- 0015 (commit `87e8d2f`) added the archived-account rules of `save_daily_context` and `set_account_ai_preferences`;
- 0017 (commit `4cbd03d`) added `linked_disposition_guard`.

No hosted database has any V2 migration (DEPLOY, first line). A database that ran an earlier version of either file
would lack these changes and would need them as a new migration (`0020_…`), because applied files are never re-run
(DEPLOY "Hard rules", which now carries this release note).

**Line endings.** `.gitattributes` keeps every `.sql` file at LF on checkout. A CRLF copy of a migration (a Windows
checkout with `core.autocrlf`) stores carriage returns in function bodies, so its catalog no longer equals that of a
database that applied the LF file; the final verification found exactly this for a CRLF copy of 0017 and was re-run
with the LF file (catalog identical).

## 39. RLS/security changes

ARCH §0.5, §10.1–§10.3.
- **Every new table** has:
  - `user_id` and `account_id` with composite foreign keys;
  - RLS on, with exactly one owner SELECT policy `user_id = (select auth.uid())` (documented exceptions in the test);
  - `revoke all` from `public`, `anon`, `authenticated` and `service_role`, then `grant select` to `authenticated`;
  - the immutability trigger and a TRUNCATE guard.

  Writes go only through `security definer` functions with `search_path = ''`, `auth.uid()` ownership checks (or a
  re-verified `p_user_id` for service-only functions), `clock_timestamp()`, and an explicit revoke followed by an exact
  grant. Views are `security_invoker`.
- **Storage:** the `trade-evidence` bucket is private, and its owner reads require a registered row. Uploads happen
  only through the trusted server after validation; reads only through `/api/evidence/[id]` with the user's session.
  The V1 bucket and its policies are untouched.
- **The service role is used only for** (complete list, ARCH §10.3):
  - evidence upload, registration, cleanup and duplicate copies;
  - AI ledger and start/authorize/finish RPCs;
  - mock connection ingest;
  - the erasure purge, storage deletion and `auth.admin.deleteUser`.

  The key stays in `server-only` modules, and a static source scan proves no browser code creates a Supabase client
  (`v2-proxy.test.ts`).
- **0019 hygiene:**
  - the service role loses DML on public tables except inserts on `setup_evaluation_passes` and `evaluator_versions`;
  - `journal_analytics` keeps only SELECT for `authenticated`, and the V1 sequences lose their `anon` and
    `authenticated` privileges;
  - `lock_trade_plan`, `evaluate_trade_plan`, `import_locked_setup`, `create_risk_version`, `record_observation` and
    `record_setup_decision` are revoked from `authenticated`.
- **Archived accounts** are refused new activity in the database, including every V1 RPC still granted (item 24).
- **Cookies:** session cookies are HttpOnly, SameSite=Lax, path `/`, and Secure on HTTPS (`authCookieOptions`,
  `src/lib/cookie-security.ts`); the context cookies follow the same rules.
- **Pages and routes:** every response is `private, no-store`; route handlers check same origin and session for
  writes (`src/lib/route-security.ts`).
- **Schema gate:** an un-migrated database renders "Database update required" and refuses every write
  (`src/lib/schema-gate.ts`).

Tests: `v2-schema-catalog.test.ts` (every public table and function of the final schema), `v2-erasure-database.test.ts`,
`v2-integrity-archived-accounts.test.ts`, `v2-trades-database.test.ts` (ownership denials), `v2-proxy.test.ts`,
`v2-supabase-server-cookies.test.ts`, `v2-routes-evidence.test.ts`. Gate results:
- grants to `anon`: no public table granted to `anon`;
- secret scan of the client build output, the server build output and the working tree: 0 secret or personal hits (client build 0 hits; working tree only the 5 documented test fixtures).

## 40. Test results

**Suite and static checks (gate of 2026-11-08):**

| Check | Result |
|---|---|
| `tsc --noEmit -p .` (TypeScript 7.0.2) | PASS, exit 0, no diagnostics |
| `pnpm lint` (Biome 2.5, warnings fail; then `scripts/check-unused-exports.mjs`) | PASS: 715 files, 0 errors, 0 warnings, 63 infos; "Unused exports: none" |
| `vitest run` (all of `tests/**/*.test.ts`) | 158 files, 4,392 tests passed, 0 failed |
| `next build` | PASS, exit 0 |
| Migrations from a fresh database (PostgreSQL 17) | reset 19/19 applied, no public table granted to `anon`, verify 10/10 |
| Upgrade from a V1 database | PASS (item 27; source: round-2 verification replay) |
| Secret scan | 0 secret or personal hits (client build 0 hits; working tree only the 5 documented test fixtures) |
| Dev-server log over the acceptance run | 0 HTTP 4xx/5xx, 0 failed reads or writes, 0 hydration errors, 0 unhandled errors out of 1,190 requests (the only error lines are the run's deliberate wrong password on Delete account) |

**Inventory** (counted from the repository): 158 tracked test files: 117 `tests/v2-*.test.ts` and 41 V1-era files,
plus fixtures and helpers in `tests/fixtures/` and `tests/helpers/`. All run without credentials; `tests/no-live-ai.ts`
(Vitest setup file) blocks OpenAI hosts, and tests pin the clock instead of reading it (ARCH §16.1).

**Spec §63 coverage:**

| Required test area | Test files |
|---|---|
| Migrations from a fresh database | every `*-database.test.ts` (PGlite applies all migrations) |
| Migration from a representative V1 state | `v2-v1-migration.test.ts`, `v2-ledger-parity.test.ts` |
| RLS and ownership | `v2-schema-catalog.test.ts`, `v2-trades-database.test.ts`, `v2-erasure-database.test.ts`, `v2-routes-evidence.test.ts` |
| Risk Engine boundaries | `v2-risk-engine-boundaries.test.ts`, `v2-risk-engine-parity.test.ts`, `risk.test.ts`, `v2-session-boundaries.test.ts` |
| Risk-plan versioning | `v2-risk-engine-usage.test.ts`, `v2-actions-accounts.test.ts`, `v2-screen-accounts.test.ts`, `v2-loaders-data.test.ts` |
| Draft revisions | `v2-trades-database.test.ts`, `v2-actions-trades.test.ts`, `v2-risk-duplicate.test.ts` |
| Live-first trades | `v2-trades-database.test.ts`, `v2-domain-close.test.ts`, `v2-close-preview-parity.test.ts` |
| Timeline timestamps and phases | `v2-domain-timeline.test.ts`, `v2-integrity-plan-end.test.ts`, `v2-integrity-copy-evidence.test.ts` |
| Multi-account isolation and aggregation | `v2-loaders-data.test.ts`, `v2-domain-performance.test.ts`, `v2-domain-account-metrics.test.ts`, `v2-integrity-archived-accounts.test.ts` |
| Account deletion security | `v2-erasure-database.test.ts`, `v2-erasure-service.test.ts` |
| Screenshots and evidence | `v2-routes-evidence.test.ts`, `v2-ui-evidence-*.test.ts` |
| AI budget regressions | `ai-budget.test.ts`, `ai-budget-database.test.ts`, `v2-ai-request-gate.test.ts`, `v2-ai-release-database.test.ts`, `v2-ai-held-reservation.test.ts`, `v2-seed-ai-pricing.test.ts` |
| Imported-trade deduplication (mock provider) | `v2-connections-database.test.ts`, `v2-connections-sync-database.test.ts` |
| Plan ↔ execution matching | `v2-domain-sync.test.ts`, `v2-connections-service.test.ts` |
| Responsive, keyboard, accessibility | `v2-ui-shell.test.ts`, `v2-ui-focus.test.ts`, `v2-ui-primitives.test.ts`, `v2-ui-account-name-chips.test.ts`; browser flow `ux` (item 41) |
| Secret scan | gate step (item 39); static client scan in `v2-proxy.test.ts` |

**V1 test replacement record** (ARCH §12.3 and §16.1 require it here; the full intent-by-intent table is [V2_TEST_REPLACEMENTS.md](V2_TEST_REPLACEMENTS.md)). Tests whose subject was V1-only code removed in
V2 were deleted; their intents are asserted by the V2 tests below, whose header comments name the V1 file they replace.
`git diff --name-status bc5441c HEAD -- tests` shows 14 deleted test files, 7 deleted browser bench entries, 27 V1-era test files changed in place and 120 added.

| Deleted V1 test (present at `bc5441c`) | V1 subject (deleted) | Intents now asserted in |
|---|---|---|
| `ui-review.test.ts`, `ui-presentation.test.ts`, `ux.test.ts` | V1 journal page, session ribbon, status banner, numeric display, `src/domain/ux.ts` | `v2-v1-replacements-presentation.test.ts`, `v2-v1-replacements-today.test.ts`, `v2-v1-replacements-actions.test.ts`, `v2-screen-journal.test.ts`, `v2-domain-daily-status.test.ts`, `v2-session-boundaries.test.ts`, `v2-domain-format.test.ts` |
| `ai-failure-accounting-ui.test.ts` | V1 panels of the six AI operations | `v2-v1-replacements-ai-history.test.ts`, `v2-ui-ai-components.test.ts` |
| `analyze-setup.test.ts`, `bias-challenge.test.ts` | V1 setup-page AI services | `v2-ai-pretrade.test.ts` (ported cases, line 369) |
| `analyze-setup-actions-data.test.ts`, `bias-challenge-actions-data.test.ts` | V1 actions and setup-page loaders | `v2-ai-actions.test.ts`, `v2-v1-replacements-ai-actions.test.ts`, `v2-ai-pretrade.test.ts` (line 447) |
| `weekly-review-actions-data.test.ts`, `recent-trades-actions-data.test.ts`, `monthly-review-actions-data.test.ts` | V1 periodic actions and loaders | `v2-v1-replacements-ai-actions.test.ts`, `v2-v1-replacements-ai-history.test.ts`, `v2-ai-actions.test.ts`, `v2-ui-ai-panels.test.ts` |
| `trade-review-actions.test.ts`, `trade-review-data.test.ts`, `trade-review.test.ts` | V1 REVIEW_TRADE runs (V2 keeps its history only) | `v2-ai-timeline-review.test.ts`, `v2-ai-actions.test.ts`, `v2-v1-replacements-ai-actions.test.ts`; stored V1 contract still in `trade-review-contract.test.ts`, `trade-review-database.test.ts`, `trade-review-sources.test.ts` |
| `tests/browser/*-entry.tsx` (7) | Manual benches for the V1 AI panels | Browser acceptance against the real app with the local mock provider (`scripts/local-stack/acceptance/`), and `v2-ui-ai-panels.test.ts`, `v2-ui-ai-components.test.ts`, `v2-screen-review.test.ts` |

Rewritten in place because their V1 subject was removed: `ai-settings.test.ts` (V1 component, now
`v2-v1-replacements-ai-settings.test.ts`), `ai-disabled.test.ts`, `audit-routes.test.ts` and `setup-routes.test.ts`
(V1 upload route, now `v2-v1-replacements-routes.test.ts`). `risk.test.ts` moved to the report-1.2 context
(`slotsUsed`, `riskConsumed` and `grossLoss` were removed from `RiskContext`, ARCH §6.7; `DAILY_LOSS_UNKNOWN` is not
produced by 1.2) and gained cases for live-first slots. Each in-place change is reviewable with
`git diff bc5441c HEAD -- tests/<file>`.

## 41. Browser acceptance results

Scripted acceptance (`scripts/local-stack/acceptance/run.mjs`; ARCH §16.2; scripts/local-stack/README.md "Browser
acceptance"):
- **Environment:** Playwright-core drives an installed Edge against the running app on the local Supabase-compatible
  stack, with fresh synthetic users at `example.test` and the local mock AI provider (no network).
- **How it checks:** controls are found by role and accessible name, never by test ids. Every Dead Pool answer is
  checked against the strategy clock before a step is accepted as clock-limited.

Run 20261108-202941-7c51f8, verdict PASS, no failed step, no browser console errors, failed requests or dev-overlay issues,
strategy clock 15:29 UTC−5 (Dead Pool) → 15:42 UTC−5 (Dead Pool).

| Flow (spec §64) | Desktop 1440×1000 | Phone 393×852 (touch) |
|---|---|---|
| Planned workflow | PASS 16/19 (1 clock-limited, 2 skipped) | PASS 16/19 (1 clock-limited, 2 skipped) |
| Live-first workflow | PASS 10/10 | PASS 10/10 |
| Analytics drill-down | PASS 8/8 | PASS 8/8 |
| Trading accounts | PASS 10/10 | PASS 10/10 |
| AI (local mock provider) | PASS 10/12 (2 clock-limited) | PASS 10/12 (2 clock-limited) |
| Settings, export, erasure | PASS 8/8 | PASS 8/8 |
| UX criteria, keyboard, themes | PASS 12/12 | PASS 14/14 |

- **Text scan:** 574 scans of 18 screens (42 screen, viewport and theme combinations), 0 with raw internals.
- **Phone width:** every phone screen reached fits 393 px.
- **Clock-limited steps:**
  Analyze Setup on a ready draft, locking a new plan and Challenge My Bias were not exercised in the browser at either viewport: the run was inside Dead Pool (12:00–18:00 UTC−5), where the Risk Engine correctly refuses every lock, and the runner checked those answers against the clock. The planned flow continued on a seeded locked plan. Their database and unit coverage is listed in items 4, 21 and 40; the last browser passes were run 20261108-165555-478b32 (desktop Analyze Setup and lock, before 12:00 UTC−5) and run 20261108-144139-cd12b9 (Challenge My Bias).
  These paths are covered by `v2-ai-pretrade.test.ts`, `v2-ai-actions.test.ts` and `v2-trades-database.test.ts`.
- **Steps per flow:** `.local/acceptance/<run-id>/summary.md` lists every step, its evidence and its screenshots.

## 42. Objective UX acceptance checklist results

Spec §60, verdicts from the browser run above. Step ids are `flow/step` in `summary.md`; screenshots are in
`docs/v2-screens/`.

| # | Criterion | Verdict | Browser evidence | Screenshot | Tests |
|---|---|---|---|---|---|
| 1 | Next action identifiable within seconds | PASS | `ux/next-actions`: every state's next action in the first viewport (blocked → Edit draft, ready → Lock plan, locked → Record entry, live → Add to journal) | [trade-draft-blocked-desktop.png](v2-screens/trade-draft-blocked-desktop.png) | `v2-domain-trade-state.test.ts`, `v2-screen-trade.test.ts` |
| 2 | Live note without leaving the trade | PASS | `planned/live-note`, `live-first/note`: added in place, URL unchanged | [trade-planned-live-desktop.png](v2-screens/trade-planned-live-desktop.png) | `v2-ui-journal-composer.test.ts` |
| 3 | Screenshot pasted with Ctrl+V | PASS | `planned/paste-screenshot` (Plan Trade) and `planned/live-note` (journal composer), real key press | [plan-trade-blocked-desktop.png](v2-screens/plan-trade-blocked-desktop.png) | `v2-ui-evidence-stager.test.ts`, `v2-ui-journal-composer.test.ts` |
| 4 | Drag/drop evidence | PASS | `planned/drop-screenshot`, `live-first/screenshot` (saved as While live) | [plan-trade-blocked-desktop.png](v2-screens/plan-trade-blocked-desktop.png) | `v2-ui-evidence-stager.test.ts`, `v2-ui-evidence-upload.test.ts` |
| 5 | Unlocked draft edited without recreating it | PASS | `planned/edit-draft`: same trade, revision 1 → 2, revision 1 kept | — | `v2-trades-database.test.ts` (`DRAFT_CHANGED`), `v2-actions-trades.test.ts` |
| 6 | BLOCKED reasons in primary UI | PASS | `planned/save-blocked`: "Requested risk 1.00% exceeds your configured maximum of 0.50%." in the Plan section | [trade-draft-blocked-desktop.png](v2-screens/trade-draft-blocked-desktop.png) | `v2-domain-risk-explain.test.ts`, `v2-screen-trade.test.ts` |
| 7 | No raw UUIDs, provider ids or prompts in default UI | PASS | 574 scans of 18 screens (42 screen, viewport and theme combinations), 0 with raw internals | all of item 45 | raw-id scans in `v2-screen-*.test.ts`; scan rules in `v2-acceptance-runner.test.ts` |
| 8 | Live-first trade with minimal mandatory fields | PASS | `live-first/record`: account, instrument, direction, entry price only | [record-live-trade-mobile.png](v2-screens/record-live-trade-mobile.png) | `v2-screen-forms.test.ts`, `v2-trades-database.test.ts` |
| 9 | Post-trade note cannot pass as pre-entry evidence | PASS | `planned/lesson-after-close`, `planned/timeline`, `live-first/not-pre-entry` | [trade-closed-timeline-desktop.png](v2-screens/trade-closed-timeline-desktop.png), [mobile-live-first-timeline-mobile.png](v2-screens/mobile-live-first-timeline-mobile.png) | `v2-domain-timeline.test.ts`, `v2-integrity-plan-end.test.ts` |
| 10 | Paid AI not the default on a blocked draft | PASS | `ai/blocked-draft`: primary "Edit draft"; AI only as secondary "Analyze blocked setup anyway · ≈ €0.02"; nothing sent on load | [trade-draft-blocked-desktop.png](v2-screens/trade-draft-blocked-desktop.png) | `v2-domain-trade-state.test.ts`, `v2-ui-ai-panels.test.ts` |
| 11 | Selected Trading Account always obvious | PASS | `accounts/switch-context`; Trading Account selector was visible on all 34 app screens scanned (desktop and phone) | [accounts-desktop.png](v2-screens/accounts-desktop.png) | `v2-ui-shell.test.ts`, `v2-ui-context-sync.test.ts` |
| 12 | All Accounts is an aggregation context | PASS | `accounts/all-accounts`, `analytics/edge`: R aggregated and labelled; money per currency, never summed | [accounts-desktop.png](v2-screens/accounts-desktop.png), [edge-desktop.png](v2-screens/edge-desktop.png) | `v2-domain-performance.test.ts`, `v2-domain-account-metrics.test.ts` |
| 13 | Core flow independent of hidden debug accordions | PASS | `ux/core-actions-visible`; no Technical details opened during any core flow | [trade-planned-live-desktop.png](v2-screens/trade-planned-live-desktop.png) | `v2-screen-trade.test.ts` |
| 14 | All Accounts → Account → Day/statistic → Trade → Evidence | PASS | `analytics/drill-down`, `analytics/statistic-to-trades`, `analytics/calendar-day`, by clicking only | [edge-calendar-day-desktop.png](v2-screens/edge-calendar-day-desktop.png), [evidence-viewer-desktop.png](v2-screens/evidence-viewer-desktop.png) | `v2-screen-edge.test.ts`, `v2-screen-journal.test.ts`, `v2-ui-charts.test.ts` |
| 15 | No developer knowledge needed to create, journal, close, review | PASS | `planned/review`, `live-first/timeline`: both flows created, journaled, closed and reviewed through labelled controls only, developer mode off | [trade-closed-timeline-desktop.png](v2-screens/trade-closed-timeline-desktop.png) | `v2-screen-trade.test.ts`, `v2-screen-forms.test.ts` |
| 16 | No core workflow requires reading huge AI output | PASS | concise cards (Analyze Setup 1,181, Weekly Review 755, Recent Trades 971, Monthly Review 718, Analyze Setup 1,360, Weekly Review 755, Recent Trades 971, Monthly Review 718 visible characters); full analysis only on request | [ai-analyze-setup-concise-desktop.png](v2-screens/ai-analyze-setup-concise-desktop.png), [review-weekly-concise-desktop.png](v2-screens/review-weekly-concise-desktop.png) | `v2-domain-ai-summary.test.ts`, `v2-ui-ai-components.test.ts` |
| 17 | No manual input duplicates known information | PASS | `planned/plan-blocked`, `planned/record-entry`, `settings/general`: account, contract and risk plan pre-filled; entry pre-filled from the plan; daily losses computed | [plan-trade-blocked-desktop.png](v2-screens/plan-trade-blocked-desktop.png) | `v2-screen-forms-data.test.ts`, `v2-domain-daily-status.test.ts` |
| 18 | Mobile live note without desktop-only interactions | PASS | `ux/mobile-live-note`, `planned/live-note` (phone), `live-first/screenshot` (phone, Take photo): taps and system pickers only | [mobile-today-live-note-mobile.png](v2-screens/mobile-today-live-note-mobile.png), [trade-planned-live-mobile.png](v2-screens/trade-planned-live-mobile.png) | `v2-screen-today-model.test.ts`, `v2-ui-evidence-stager.test.ts` |
| 19 | Locked plan immutability intact | PASS | `planned/locked-immutable`: no editor; the owner's own `revise_trade_draft` / `discard_trade_draft` refused with `DRAFT_NOT_EDITABLE` | — | `v2-trades-database.test.ts`, `v2-schema-catalog.test.ts` |
| 20 | Historical records keep their original strategy/risk versions | PASS | `analytics/historical-versions`: a trade locked under Risk Plan V1.0 still shows V1.0 while the account's active plan is V1.2 | — | `v2-risk-engine-usage.test.ts`, `v2-domain-risk-explain.test.ts` |

## 43. Known limitations

| # | Limitation | Effect | Source |
|---|---|---|---|
| 1 | Daily limits do not see platform executions that are held, unlinked, or whose close is not recorded on a trade | A trader could keep the full loss budget and trade slots despite a losing synced position. **None in V2**, which accepts only MOCK; must be closed before any real provider | GAPS §1.2, §1.5; DEPLOY "Hard rules" |
| 2 | A held or unlinked execution can only be linked to a planned trade: no "Import as a new trade", no dismissal | Such a position appears in no Journal, EDGE or CSV view until linked | GAPS §1.1, §1.4 |
| 3 | Imported trades may have no contract (only the latest exact-symbol version whose grid fits is attached) | Risk basis and R unknown unless a risk was recorded while open; positions closed at import never get R | GAPS §2 |
| 4 | Accounts above 20,000 trades | Dashboard and Accounts show "—" with the reason instead of a partial figure; EDGE reads at most 20,000 matching closed trades | GAPS §3.1; ARCH §9.4, §14.6 |
| 5 | Large histories (production build, 1440×1000) | Chart payloads are bounded (ARCH §13.6) and exit sorts parse each timestamp once, so page weight no longer grows with history (2.5–3.1 MB of HTML at 15,000–19,900 trades). Account dashboard: 4.6–5.2 s at 19,900 trades, 3.6–4.0 s at 15,000. EDGE: 5.5–5.8 s for one account of 19,900 trades (5.7–9.4 s filtered); 8.2–8.4 s for All Accounts at 3 × 15,000 (7.4–7.9 s filtered), above the 5 s budget: the rest is server time over up to 20,000 trades | GAPS §3.1, §3.2 |
| 6 | Journal at about 45,000 trades | 7.9–8.7 s for All Accounts (7.3–7.9 s filtered), over the 5 s budget; one account of 19,900 trades 3.3–3.4 s. Reads sorted by a computed trade date risk the 8 s statement timeout under PostgREST's generic plan | GAPS §4.1 |
| 7 | Hosted pre-deployment checks not yet run | Recovery sessions must carry a timestamped `recovery` method in `amr` (otherwise every password recovery is refused); PostgREST must be 11 or later (open-trade anti-joins) | DEPLOY "Pre-deployment checks"; PASSWORD_RECOVERY.md "Session/security design" |
| 8 | AI pricing profile validity | `GPT_5_4_MINI_EUR_2026_10_13` is valid until `2026-11-12T00:00:00Z` (`src/ai/pricing.ts`, `validUntil`); from then on every AI request is refused before any provider call until the pricing is re-verified. The legacy setup evaluator's profile expired on 2026-10-22 and V2 does not offer it | ARCH §11.6, §11.7; README "AI without a provider" |
| 9 | Migration release note | `0015_canonical_trades.sql` and `0017_platform_connections.sql` were edited after being applied to the local development database only; a database that ran the earlier versions needs the changes as a new migration | item 38 |
| 10 | Periodic AI reviews | Live-first and imported trades are not yet included; the page counts them as "not included" | ARCH §11.5 |
| 11 | Accounting scope | Partial closes are journal records; a close records one exit price; no multi-leg accounting, outcome amendments or market data | IMPLEMENTATION_STATUS.md "Not in V2"; ARCH §3.6 |
| 12 | Structured journal entries after the close | Stop, target and partial-close entries are refused once a trade is closed (`ENTRY_NOT_LIVE`); what happened is written as a Decision or Note | ARCH §3.6 (decision) |
| 13 | Unknown or foreign trade and account ids | Rendered as not-found inside the shell with HTTP 200 and `noindex` ("soft 404"), revealing nothing about the record; legacy URLs give real 307s and 404s | DEPLOY "Operational notes" (decision) |
| 14 | No return to the V1 app | Once 0019 is applied the V1 UI cannot lock plans or record values; repair is forward-only | DEPLOY "Rollback" |
| 15 | Verified on a local Supabase-compatible stack only | Emulated gateway, GoTrue and Storage; PostgREST v13.0.8; migrations run as superuser; `C.UTF-8` collation | scripts/local-stack/README.md "Known differences from hosted Supabase" |
| 16 | AI verified with the local mock provider only | Real-provider acceptance follows the independent audit; `AI_ENABLED=false` on Preview and production until then | IMPLEMENTATION_STATUS.md; DEPLOY "Hard rules" |
| 17 | Cost estimate of the timeline review | `REVIEW_TRADE_TIMELINE` uses REVIEW_TRADE's measured typical cost until it is measured itself | ARCH §11.2 |
| 18 | Browser coverage of the clock-dependent steps | Analyze Setup on a ready draft, locking a new plan and Challenge My Bias were not exercised in the browser at either viewport: the run was inside Dead Pool (12:00–18:00 UTC−5), where the Risk Engine correctly refuses every lock, and the runner checked those answers against the clock. The planned flow continued on a seeded locked plan. Their database and unit coverage is listed in items 4, 21 and 40; the last browser passes were run 20261108-165555-478b32 (desktop Analyze Setup and lock, before 12:00 UTC−5) and run 20261108-144139-cd12b9 (Challenge My Bias) | item 41 |
| 19 | Open cosmetic findings | none open: the phone composer's kind chips, which had scrolled sideways at "Partial", wrap onto two rows | item 41 |

## 44. Explicit V2.1/V2.2 deferred work

**V2.1** (GAPS; IMPLEMENTATION_STATUS.md; spec §4):
1. Real cTrader read-only sync (item 31), after these prerequisites:
   - platform executions count toward daily usage exactly once by their own facts, with a new engine version label
     (GAPS §1.5);
   - `public.import_external_execution` ("Import as a new trade"), sharing `private.create_imported_trade` with the
     ingest CREATE path; optional `dismiss_external_execution` that never removes an execution from the limits
     (GAPS §1.5).
2. Contract attachment by normalized symbol and the newest fitting version; platform contract specification as an
   instrument version with `source 'PLATFORM'`; the platform's stop at entry as the initial stop (GAPS §2.3).
3. Per-account totals in SQL for accounts above 20,000 trades, with parity tests against the TypeScript metrics
   (GAPS §3.2). The same SQL totals for EDGE across accounts, which is still above the 5 s budget at 20,000 trades (GAPS §3.1); bounded chart payloads already shipped in V2 (ARCH §13.6).
4. A stored, indexed trade date and plain open-state facts, so the Journal and every open-trade list become index
   range reads (GAPS §4.2).

**V2.2:** the MetaTrader 5 bridge with per-connection credentials (item 32).

**Not scheduled** (IMPLEMENTATION_STATUS.md "Not in V2"): market data, multi-leg (partial-position) accounting,
outcome amendments. Also open: live-first and imported trades in periodic AI reviews (ARCH §11.5), and a measured
cost figure for `REVIEW_TRADE_TIMELINE` (ARCH §11.2).

**After the independent audit:** real-provider AI acceptance, and re-verification of the pricing profile (item 43
#8).

## 45. Screenshots of major V2 screens

29 curated screens from browser acceptance run 20261108-202941-7c51f8 (synthetic users,
local mock AI; charts inside screenshots are stamped "Synthetic chart"). Index with captions:
[v2-screens/README.md](v2-screens/README.md).

| Area | Screen | Viewport | File |
|---|---|---|---|
| Today | Session ribbon, trading status, live trades, plans waiting, closed today | Desktop 1440×1000 | [today-desktop.png](v2-screens/today-desktop.png) |
| Today | Same, whole page | Phone 393×852 | [today-mobile.png](v2-screens/today-mobile.png) |
| Today | Live trade card with the inline note composer (taps only) | Phone 393×852 | [mobile-today-live-note-mobile.png](v2-screens/mobile-today-live-note-mobile.png) |
| Planned trade | Plan Trade: live preview blocked with the exact reason, two staged screenshots | Desktop 1440×1000 | [plan-trade-blocked-desktop.png](v2-screens/plan-trade-blocked-desktop.png) |
| Planned trade | Blocked draft: exact reason, Edit draft as next action | Desktop 1440×1000 | [trade-draft-blocked-desktop.png](v2-screens/trade-draft-blocked-desktop.png) |
| Planned trade | Live planned trade: journal note and pasted screenshot | Desktop 1440×1000 | [trade-planned-live-desktop.png](v2-screens/trade-planned-live-desktop.png) |
| Planned trade | Live planned trade: note and screenshot from the phone's picker | Phone 393×852 | [trade-planned-live-mobile.png](v2-screens/trade-planned-live-mobile.png) |
| Planned trade | Reviewed trade with its timeline (Before entry · While live · After close) | Desktop 1440×1000 | [trade-closed-timeline-desktop.png](v2-screens/trade-closed-timeline-desktop.png) |
| Live-first | Record Live Trade, minimal form | Phone 393×852 | [record-live-trade-mobile.png](v2-screens/record-live-trade-mobile.png) |
| Live-first | No pre-trade plan banner, live journal, close form | Desktop 1440×1000 | [trade-live-first-desktop.png](v2-screens/trade-live-first-desktop.png) |
| Live-first | Timeline (While live · After close) | Phone 393×852 | [mobile-live-first-timeline-mobile.png](v2-screens/mobile-live-first-timeline-mobile.png) |
| Journal | Trades grouped by day with origin, state, R and P&L | Desktop 1440×1000 | [journal-desktop.png](v2-screens/journal-desktop.png) |
| Journal | Same | Phone 393×852 | [journal-mobile.png](v2-screens/journal-mobile.png) |
| EDGE | Headline statistics, sample caveat, money per currency, charts | Desktop 1440×1000 | [edge-desktop.png](v2-screens/edge-desktop.png) |
| EDGE | Calendar: a day opens the trades closed on it | Desktop 1440×1000 | [edge-calendar-day-desktop.png](v2-screens/edge-calendar-day-desktop.png) |
| Evidence | Viewer with label, timing band and recorded time | Desktop 1440×1000 | [evidence-viewer-desktop.png](v2-screens/evidence-viewer-desktop.png) |
| Accounts | Accounts in their own currencies; totals only within one currency | Desktop 1440×1000 | [accounts-desktop.png](v2-screens/accounts-desktop.png) |
| Accounts | Account dashboard | Desktop 1440×1000 | [account-dashboard-desktop.png](v2-screens/account-dashboard-desktop.png) |
| Accounts | Manage → Risk policy versions (scheduled version starts tomorrow) | Desktop 1440×1000 | [account-manage-risk-policy-desktop.png](v2-screens/account-manage-risk-policy-desktop.png) |
| Review and AI | Weekly Review concise card with source chips | Desktop 1440×1000 | [review-weekly-concise-desktop.png](v2-screens/review-weekly-concise-desktop.png) |
| Review and AI | Analyze Setup concise card led by the Risk Engine line | Desktop 1440×1000 | [ai-analyze-setup-concise-desktop.png](v2-screens/ai-analyze-setup-concise-desktop.png) |
| Review and AI | Review Trade concise card | Desktop 1440×1000 | [ai-review-trade-concise-desktop.png](v2-screens/ai-review-trade-concise-desktop.png) |
| Review and AI | Review Trade full analysis sheet | Desktop 1440×1000 | [ai-review-trade-full-desktop.png](v2-screens/ai-review-trade-full-desktop.png) |
| Review and AI | AI failure: held reservation reported, account AI paused for review | Desktop 1440×1000 | [ai-failure-accounting-desktop.png](v2-screens/ai-failure-accounting-desktop.png) |
| Settings | General, AI per account, connections, data, security, danger zone, developer | Desktop 1440×1000 | [settings-desktop.png](v2-screens/settings-desktop.png) |
| Keyboard | Command palette (Ctrl+K) | Desktop 1440×1000 | [command-palette-desktop.png](v2-screens/command-palette-desktop.png) |
| Dark theme | Today | Desktop 1440×1000 | [today-desktop-dark.png](v2-screens/today-desktop-dark.png) |
| Dark theme | Live trade | Phone 393×852 | [trade-live-mobile-dark.png](v2-screens/trade-live-mobile-dark.png) |
| Dark theme | EDGE | Desktop 1440×1000 | [edge-desktop-dark.png](v2-screens/edge-desktop-dark.png) |

## 46. Final commit

⟦FINAL: commit⟧pending⟦/FINAL⟧ on `ui/claude-v2` holds everything delivered. The branch tip is the commit after it, which only
records this hash and the bundle path here and in [V2_VERIFICATION.json](V2_VERIFICATION.json).

History since the base (`git log --oneline bc5441c..HEAD`):

| Commit | Date | Content |
|---|---|---|
| `257ab5d` | 2026-10-18 | Database and domain foundation: trade model, Risk Engine report 1.2, connections, timeline AI review, erasure |
| `bae4d96` | 2026-10-23 | Data layer: loaders, server actions, evidence routes, app layout, proxy |
| `b265b34` | 2026-10-23 | Evidence, live journal and AI presentation components |
| `5e774f4` | 2026-10-23 | Synthetic dataset and screenshot tooling |
| `2d580ea` | 2026-10-24 | Every screen on the shared design system |
| `088dc29` | 2026-10-28 | Integration fixes after review |
| `4215b24` | 2026-11-08 | Review findings fixed and verified |
| `87e8d2f` | 2026-11-08 | Archived-account guards, connections, weekly-review capacity, UI audit fixes, performance |
| `4cbd03d` | 2026-11-08 | Archived-account AI off, linked-plan guard, bounded charts and exit sorts, report draft |
| ⟦FINAL: commit⟧pending⟦/FINAL⟧ | ⟦FINAL: commit date⟧pending⟦/FINAL⟧ | ⟦FINAL: commit content⟧pending⟦/FINAL⟧ |

**Delivery.** The build environment has no push rights to `github.com/zeromakiman/TradingOS`; its stored credential can
only pull. The branch is therefore delivered as a git bundle: ⟦FINAL: bundle path⟧pending⟦/FINAL⟧. In a clone of the
repository that contains `bc5441c`:

```sh
git bundle verify <bundle>
git fetch <bundle> ui/claude-v2:ui/claude-v2
git log --oneline -1 ui/claude-v2        # must print the final commit above
git push origin ui/claude-v2             # by the owner; never to main
```

Nothing was merged into `main` and nothing was deployed to production (spec §1, §66).

## 47. Vercel Preview URL

**Not created.** Reasons:
1. **No credentials or Git integration.** The Vercel project is deployed through the Vercel CLI only, with no Git
   integration (DEPLOY "Environment"; docs/AI_V1_STAGING_REVIEW.md line 12), and no Vercel credentials are available
   in the build environment.
2. **The branch cannot be pushed** from the build environment (item 46).
3. **The Preview environment is unsafe for this branch as configured.** It points at the staging Supabase project
   with `AI_ENABLED=true` and server-only provider credentials (docs/AI_V1_STAGING_REVIEW.md line 12,
   docs/AI_MINI_STAGING_PREPARATION.md line 46; DEPLOY: "A Preview that was used for V1 AI acceptance may still have
   `AI_ENABLED=true` and a live key"). A Preview of this branch would therefore:
   - be able to make paid OpenAI calls, which spec §65 forbids during V2 development;
   - need migrations 0015–0019 applied to the staging database, which the build must not touch (ARCH §0.8; spec §1).

   Until then the schema gate would only show "Database update required" (ARCH §13.10).

**Steps for the owner to create a safe Preview** (DEPLOY "Environment", "Migrations", "Procedure", "Authentication
URLs"):
1. **Turn AI off in Preview.** Inspect it with `vercel env ls preview`. Set `AI_ENABLED=false`, remove
   `OPENAI_API_KEY`, and make sure `TRADING_OS_ENABLE_MOCK_SYNC` is absent. This CLI project cannot scope variables
   by branch, so the change applies to every Preview.
2. **Set the Supabase variables.** Preview needs `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` of the staging project, and `SUPABASE_SECRET_KEY`, which V2 requires for
   evidence, AI accounting and erasure.
3. **Prepare the staging database.** It must hold only synthetic data, never production data.
   - Back up the database and both storage buckets.
   - Compare its migration ledger with `supabase/migrations/`.
   - Apply 0015, 0016, 0017, 0018 and 0019 in order, in one maintenance window.
   - Verify that `select public.trading_os_schema()` returns `2.0`, that the grants match `tests/v2-schema-catalog.test.ts`,
     that `trade-evidence` is private, and that anonymous requests see no table.
4. **Run the two pre-deployment checks** on that project: the recovery `amr` claim and PostgREST 11 or later.
5. **Push and deploy.** Push `ui/claude-v2` from the bundle (item 46). From a checkout of the final commit, deploy a
   Preview with the Vercel CLI (`vercel deploy`, without `--prod`). If password recovery is to be tested, add the
   Preview origin's exact `/update-password` URL to the staging project's redirect URLs.
6. **Run the acceptance flows** with synthetic users: DEPLOY "Procedure" step 6 and the spec §64 flows, all except
   AI, which stays off. The scripted runner accepts loopback origins only and seeds users through the local stack
   (scripts/local-stack/README.md "Browser acceptance", `--base`), so on a Preview the flows are run by hand.
7. **Record the Preview URL** in this item.

---

## Readiness

**Complete:**
- Deliverables 1–46 are documented above, each with files, migration objects and tests an auditor can open.
- The V2 implementation (migrations 0015–0019, domain, data layer, screens) and its test suite are in the tree.
- The final verification of 2026-11-08 passed every step it ran: type check, lint, the full suite (158 files, 4,392
  tests), production build, secret scan, migrations from a fresh database with a catalog identical to the working
  database's, browser acceptance at both viewports with no failed step, and all 20 spec §60 criteria
  ([V2_VERIFICATION.json](V2_VERIFICATION.json)). The V1 → V2 upgrade was verified by the replay of the same day
  (item 27).
- No paid AI call was made, nothing was merged into `main`, and production was not touched.

**Missing:**
- **Deliverable 47, the Vercel Preview URL:** not created, for the reasons in item 47. This alone keeps the deliverable
  set incomplete.
- **Browser coverage of the lock path in the final run:** the run was inside Dead Pool (12:00–18:00 UTC−5), so Analyze
  Setup on a ready draft, locking a new plan and Challenge My Bias were not exercised in the browser by it. They passed
  in the browser earlier that day (runs 20261108-165555-478b32 and 20261108-144139-cd12b9) and are covered by the tests
  in item 40. To close it, run `node scripts/local-stack/acceptance/run.mjs --flows=planned,ai --viewport=both` outside
  Dead Pool (from 18:00 UTC−5) and before the AI pricing expires on 2026-11-12T00:00:00Z.
- **Before any release** (not needed for the audit): the hosted pre-deployment checks (item 43 #7) and the migration
  release note (item 38).

TRADING OS V2 NOT READY FOR INDEPENDENT AUDIT
