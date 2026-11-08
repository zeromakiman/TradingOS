# Trading OS V2: architecture and implementation specification

Status: AUTHORITATIVE DESIGN for branch `ui/claude-v2` (base `bc5441c`).
Audience: the engineers and agents implementing V2, and the independent auditor.
Every implementation decision must trace back to this document. When code and this document disagree, fix one of them deliberately.

> Simple on the surface, rigorous underneath. The central object is the **Trade and its decision history**.

---

## 0. Ground rules (apply to every change)

1. **Protected invariants stay authoritative.** Auth, ownership, RLS, deterministic risk authority (SQL engine decides at lock), append-only history, strategy and risk-plan versioning, locked-plan immutability, deterministic realized R and EDGE, fixed UTC−5 strategy clock, AI budget reservation/reconciliation, AI uncertainty accounting, canonical citations, provider abstraction, audit history. AI is advisory and never overrides BLOCKED.
2. **Additive migrations only.** Never edit migrations 0001–0014. New files `0015`–`0019`, named `^\d+_[a-z_]+\.sql$` (no digits after the prefix, so `scripts/migration-review.mjs` can see them). Existing functions change only via `create or replace` in a new migration. Never UPDATE or DELETE historical rows (the only exception is the owner-requested erasure path in §10.4). Backfills insert new rows only.
3. **History is never reinterpreted.** A stored risk report, plan, fill, outcome or AI result keeps the version and meaning it had when written. New behaviour gets a new version label.
4. **Precision.** Money/price/percent math uses Decimal.js (TS) or NUMERIC (SQL). Never `Number()`/`parseFloat()` a decimal string for comparison or arithmetic; never compare the result of a division (cross-multiply); never let display rounding contradict a verdict (§6.6).
5. **Every new table**: `user_id`, `account_id` (FK to `accounts(user_id,id)`, or to a child by composite key), RLS enabled, exactly one owner SELECT policy `user_id = (select auth.uid())`, `revoke all ... from public, anon, authenticated, service_role`, `grant select ... to authenticated`, immutability trigger `before update or delete ... execute function private.reject_mutation()`, a TRUNCATE guard (§10.4), and writes only through `security definer` functions with `set search_path = ''`, schema-qualified names, `auth.uid()` ownership checks (or a re-verified `p_user_id` for service-only functions), `clock_timestamp()` for authoritative time, and explicit `revoke all on function ... from public, anon[, authenticated][, service_role]` followed by an exact grant. End each migration with `notify pgrst, 'reload schema';`.
6. **Stable error contract.** SQL raises with stable English messages that start with a code-like prefix where practical (e.g. `'DRAFT_CHANGED: ...'`); TypeScript maps them to human copy. Never show raw SQL errors.
7. **No paid AI calls.** Tests use mocks/fixtures; `tests/no-live-ai.ts` stays in force.
8. **Synthetic data only.** Never touch production or staging databases.
9. **No raw internals in default UI** (UUIDs, hashes, response IDs, provider IDs, raw JSON, prompts, rule codes, backend state names). They live behind a collapsed "Technical details" disclosure or in Developer mode (§13.9).

---

## 1. Information architecture

### 1.1 Primary navigation

`Today · Journal · Accounts · EDGE · Review · Settings`, plus two global primary actions that are always visible in the header: **+ Plan Trade** and **+ Record Live Trade**, a **Trading Account selector** (`All Accounts ▾`), and **Search ⌘K**.

Mobile: bottom tab bar `Today · Journal · (+) · Accounts · More`; `(+)` opens a sheet with *Plan Trade* and *Record Live Trade*; *More* lists EDGE, Review, Settings.

### 1.2 Routes (App Router, all under a shared authenticated layout `src/app/(app)/layout.tsx`)

| Route | Purpose |
|---|---|
| `/today` | Home workstation (§14.1) |
| `/trades/new` | Plan Trade: create a draft (§14.2) |
| `/trades/live/new` | Record Live Trade: minimal live-first form (§14.3) |
| `/trades/[id]` | Trade workspace: plan, execution, live journal, result, review, evidence (§14.4) |
| `/trades/[id]/edit` | Edit draft (new revision) |
| `/journal` | Trade list with filters/search (§14.5) |
| `/edge` | Analytics dashboard + calendar + breakdowns with drill-down (§14.6) |
| `/accounts` | Accounts workspace summary (§14.7) |
| `/accounts/new` | Create trading account |
| `/accounts/[id]` | Individual account dashboard (§14.8) |
| `/accounts/[id]/manage` | Profile, account values, external losses, risk policy, instruments, connection, archive (§14.9) |
| `/review` | Review workspace: Weekly, Recent trades, Monthly, AI history (§14.10) |
| `/review/weekly`, `/review/recent`, `/review/monthly` | Periodic AI reviews (account-scoped) |
| `/settings` | General, AI, Connections, Data (export), Security, Danger zone, Developer (§14.11) |
| `/login`, `/forgot-password`, `/update-password` | Public auth pages (outside the app layout) |

Legacy routes keep working by redirect (never 404 a bookmark):
`/analyze` → `/trades/new`; `/analyze/[id]` (proposal id) → `/trades/[tradeId]`; `/journal/[id]` (plan id) → `/trades/[tradeId]`; `/edge/weekly|recent|monthly` → `/review/weekly|recent|monthly` (query string preserved); `/preview` → `/login`. These are real 307 redirects (an unknown or foreign legacy id is a real 404). V1 bookmarks of `/journal` and `/edge` keep their filters: the V1 keys are read with their V1 meanings (§14.5, §14.6), and a value that cannot be applied is named in the page's notice, never silently dropped.

Route handlers: `POST /api/trades/[id]/evidence` (upload), `GET /api/evidence/[id]` (V2 evidence bytes, `?variant=thumb`), `GET /api/screenshots/[id]` (legacy, keeps working, adds `?variant=thumb`), `GET /api/export` (data export), `GET /edge/export` (legacy CSV, kept; it reads its query with EDGE's own parser, so the page and its CSV select the same trades, and an inverted V1 `from`/`to` is still refused with V1's message), `POST /api/setups/[id]/analyze` (legacy evaluator; kept but not linked from V2 UI; it answers 400 `{error}` for a missing or malformed body, and the evaluator itself is refused before any provider call since its pricing expired, §11.6).

### 1.3 Proxy

`src/proxy.ts` matcher becomes a catch-all `'/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|robots.txt).*)'` (the app icons load on signed-out pages too) with explicit public lists: pages `/login`, `/forgot-password`, `/update-password`; route handlers `/api/*` and `/edge/export` keep JSON/CSV 401 behaviour (not redirected). This fixes the V1 gap where `/edge/weekly|recent|monthly` had no session refresh. The proxy also implements the account-context cookie (§9.2).

---

## 2. Canonical Trade model

### 2.1 Object

A **Trade** (`public.trades`) is the user-facing aggregate. It is an immutable identity row with an origin; everything else (draft revisions, plan, fills, outcome, journal, evidence, reviews) hangs off it through append-only records.

| Origin | Meaning |
|---|---|
| `PLANNED` | Started as a Trading OS draft before entry. May become locked, executed, closed. |
| `LIVE_FIRST` | Recorded while (or after) the position was open, with **no pre-trade plan**. |
| `IMPORTED` | Created from a platform execution (future cTrader/MT5; mock in V2). No pre-trade plan. |

V1 data: every `trade_plans` row and every unlocked `setup_proposals` row becomes one `PLANNED` trade by backfill (§3.3). No orphan is possible because every V1 record already carries an explicit trading account.

Every plan belongs to exactly one trade, also in the database: `trade_plan_links` makes the link unique on both sides, and the deferred constraint trigger `plan_requires_trade` on `trade_plans` (0015, `private.require_plan_trade()`, executable by no API role) makes it exist. A plan inserted by a transaction acting as an API role (PostgREST sets `authenticated` or `service_role`) must have its link when the transaction commits, otherwise `PLAN_WITHOUT_TRADE` rolls the whole transaction back, so no path can lock a plan outside the trade model (a V1 lock, or `check_setup_risk` with a NULL `p_lock`, which also raises `INVALID_INPUT` itself). Sessions without a role (migrations, operators, the synthetic history seed) are not checked; the V1 plans were linked by the backfill.

### 2.2 Lifecycle (derived, never stored as a mutable status)

`lifecycle` is derived in SQL (view `trade_ledger`) and mirrored by a pure TS function (`deriveTradeState`, parity-tested):

```
PLANNED:
  discarded (DRAFT_DISCARDED event)                    → DISCARDED
  no plan link:
     legacy V1 SKIPPED human decision (latest)         → SKIPPED
     otherwise                                          → DRAFT     (draftCheck: UNCHECKED | BLOCKED | APPROVED)
  plan link:
     outcome exists  → review completed ? REVIEWED : CLOSED
     execution exists                                   → LIVE
     disposition SKIPPED / CANCELLED                    → SKIPPED / CANCELLED
     legacy V1 SKIPPED human decision (latest, V1 meaning preserved) → SKIPPED
     otherwise                                          → LOCKED   (legacy TAKEN-without-fill keeps LOCKED with legacy_decision 'TAKEN')
LIVE_FIRST / IMPORTED:
  close exists     → review completed ? REVIEWED : CLOSED
  otherwise                                             → LIVE
```

"Review completed" = latest `trade_lifecycle_events` row among `REVIEW_COMPLETED|REVIEW_REOPENED` is `REVIEW_COMPLETED`. (AI review alone does not mark a trade reviewed: the trader decides.)

`draftCheck` = decision of the newest risk evaluation attached to the newest revision (`APPROVED`/`BLOCKED`), else `UNCHECKED`. Whether an `APPROVED` check is still *current* (same strategy day, session, observation, risk version, usage) is a time-dependent judgement made in TS from the stored report (§6.5); the lock RPC always re-evaluates on the server regardless.

### 2.3 User-facing vocabulary

| Internal | Label | Tone | Stepper step |
|---|---|---|---|
| DRAFT/UNCHECKED | Draft | neutral | Draft |
| DRAFT/BLOCKED | Blocked | danger | Draft |
| DRAFT/APPROVED (current) | Ready to lock | positive | Validated |
| DRAFT/APPROVED (stale) | Recheck needed | warning | Draft |
| DRAFT of an archived account (any check) | Account archived | muted | Draft |
| LOCKED | Locked · waiting for entry | info | Locked |
| LIVE | Live | live (accent, pulsing dot) | Live |
| CLOSED | Closed · review pending | neutral | Closed |
| REVIEWED | Reviewed | positive-muted | Reviewed |
| SKIPPED / CANCELLED / DISCARDED | Skipped / Cancelled / Discarded | muted | — |

Origin badge: `Planned` (planned trades), `Live-first` (with tooltip "No pre-trade plan was recorded before execution"), `Imported`.

Stepper (planned trades only): `Draft → Validated → Locked → Live → Closed → Reviewed`. Live-first/imported trades show a banner instead: **"No pre-trade plan was recorded before execution."** (exact copy, §15).

### 2.4 Next action (one primary CTA per state)

| State | Primary action | Secondary |
|---|---|---|
| Draft (unchecked) | Check risk (free) | Edit draft, Discard |
| Blocked, and an edit of the draft can clear a reason | Edit draft (with the first blocking reason inline, and " (+N more)" when there are more) | Analyze blocked setup anyway · ≈ €0.02 (only if AI available), Discard |
| Blocked today only by what no edit clears: Dead Pool, a used-up daily trade limit, daily risk cap or daily loss limit, or open risk filling the loss limit | Recheck risk (the Plan caption says when it can pass: from 18:00 UTC−5, on the next trading day, or once an open position closes) | Edit draft, Analyze blocked setup anyway · ≈ €0.02 (only if AI available), Discard |
| Blocked today by stale account values, with nothing an edit clears and no used-up daily limit | Confirm account values (Manage → Account values) | Edit draft, Analyze blocked setup anyway · ≈ €0.02 (only if AI available), Discard |
| Blocked by stale account values that have been confirmed for today since the check | Recheck risk ("Today's account values have been confirmed since the check: recheck risk now.") | Edit draft, Analyze blocked setup anyway · ≈ €0.02 (only if AI available), Discard |
| Blocked on an earlier strategy day | Recheck risk (free: today's limits, session and account values can differ) | Edit draft (with first blocking reason inline), Analyze blocked setup anyway · ≈ €0.02 (only if AI available), Discard |
| Ready to lock | Lock plan | Analyze setup · ≈ €0.02, Challenge my bias · ≈ €0.02, Edit draft |
| Recheck needed | Recheck risk | Edit draft |
| Account archived (draft of an archived account) | — (restore the account in Manage account) | Discard |
| Locked | Record entry | Skip this trade |
| Live | Add to journal (focus composer) | Close trade |
| Closed | Write review / mark reviewed | Review this trade with AI · ≈ €0.02 |
| Reviewed | — (view) | Reopen review |

Which blocked row applies is decided from the stored check (`blockRemedy` / `withBlockingFindings` in `src/domain/trade-state.ts`): a daily risk cap or daily loss limit that still had room when the check ran is edit-clearable (a lower risk fits under it), and so is every rule that depends on the draft (risk, RR, prices, flags, the instrument, DUPLICATE); once no room is left only the next trading day frees it, or, for the loss limit, closing an open position while today's losses alone still leave room. Dead Pool, the daily trade limit and stale account values never depend on the draft. The trade page and Today apply the same rule.

### 2.5 Editability matrix

| Part | Draft | Locked | Live | Closed |
|---|---|---|---|---|
| Plan fields (instrument, direction, model, prices, risk %, thesis, flags) | editable → new revision | immutable | immutable | immutable |
| Evidence | add/remove/relabel | add; remove and relabel are soft and audited (timing never changes; the timeline shows "Screenshot removed" with its timing; removed items leave the gallery and AI selection) | same | same |
| Journal entries | add (pre-entry; notes, decisions, lessons only) | add (pre-entry; notes, decisions, lessons only) | add (live; also stop, target and partial-close entries) | add (post-trade; notes, decisions, lessons only) |
| Entry facts | — | record once | immutable (live-first: fill missing fields once) | immutable |
| Close facts | — | — | record once | immutable |
| Tags | editable (revisions) | editable | editable | editable |
| Review status | — | — | — | complete / reopen |

The UI states what is immutable in plain words ("Locked plans can't be edited. Later changes are recorded in the journal.").

---

## 3. Data model: migration `0015_canonical_trades.sql`

All tables follow §0.5. Column lists below are normative (names, types, checks). Indexes are minimal and listed.

### 3.1 Strategy template

`private.strategy_templates(version text primary key, rules jsonb not null, written_rules text not null)`.
Populated **at migration time** from the body of `public.create_demo_account(text,text,text)` (`pg_proc.prosrc`) by extracting the two literals inserted into `strategy_versions` (rules JSON after `'ICT V1.0','`, written rules after `'::jsonb,'` up to `');` before `insert into public.risk_plan_versions`), un-escaping `''` → `'`. This guarantees byte-identical strategy content with every existing account in that database (including CRLF variants). A test asserts the template equals what `bootstrap_demo_account` inserts. Function `private.seed_ict_strategy(p_user uuid, p_account uuid) returns uuid` inserts a `strategy_versions` row from the template.

### 3.2 Trading accounts

1. Relax currency checks (constraints are auto-named):
   - `accounts`: drop `accounts_currency_check`; add `check (currency in ('USD','EUR','GBP','CHF','JPY','AUD','CAD','NZD','SGD','HKD','SEK','NOK','DKK','PLN','CZK','HUF','ZAR','MXN'))`.
   - `instrument_versions`: drop `instrument_versions_currency_check`; add the same allow-list.
   - `accounts.mode` stays `'DEMO'` (legacy column; V2 type lives in the profile). Documented, never shown.
2. `public.account_profiles` (append-only revisions; latest `id` wins):
   ```
   id bigint generated always as identity primary key,
   user_id uuid not null, account_id uuid not null,
   display_name text not null check (length(btrim(display_name)) between 1 and 100),
   broker text check (broker is null or length(btrim(broker)) between 1 and 100),
   platform text not null check (platform in ('MANUAL','CTRADER','MT5','MT4','TRADINGVIEW','OTHER')),
   account_type text not null check (account_type in ('DEMO','EVALUATION','FUNDED','PERSONAL','OTHER')),
   starting_balance numeric(20,2) check (starting_balance > 0 and starting_balance < 1000000000000),
   status text not null check (status in ('ACTIVE','ARCHIVED')),
   source text not null default 'USER' check (source in ('USER','MIGRATION')),
   recorded_at timestamptz not null default clock_timestamp(),
   foreign key (user_id, account_id) references public.accounts(user_id, id)
   ```
   Index `(account_id, id desc)`. Backfill one `MIGRATION` row per existing account: `display_name = accounts.name`, `platform 'MANUAL'`, `account_type 'DEMO'` (V1 enforced demo), `starting_balance` = balance of the account's earliest observation, `status 'ACTIVE'`.
3. RPCs (authenticated):
   - `create_trading_account(p_request_key uuid, p_input jsonb) returns uuid` — input `{name, currency, accountType, platform, broker?, startingBalance?, balance, equity}`. Idempotent via `bootstrap_requests` (normalized input compared on replay, advisory lock on `uid||key` like 0003). Inserts: `accounts(user_id,name,currency)`, first observation (balance/equity, today), ICT V1.0 strategy from template, `Risk Plan V1.0` (0.5 max, default 0.5, 2 trades, min RR 3 BLOCK, news WARN, no caps), instruments (USD → the V1 EURUSD/GBPUSD seeds; other currencies → none), `configuration_events ACCOUNT_INITIALIZED` with currency/type, profile row (`starting_balance` defaults to `balance`). Returns the account id. `bootstrap_demo_account` keeps working unchanged.
   - `update_account_profile(p_account_id uuid, p_input jsonb) returns bigint` — any subset of `{displayName, broker, platform, accountType, startingBalance, status}`; missing keys copy the latest revision; no-op if unchanged (returns latest id).
   - `create_instrument_version(p_account_id uuid, p_input jsonb) returns uuid` — `{symbol (^[A-Z0-9][A-Z0-9._/-]{0,19}$), quantityUnit (1..60), tickSize, pipSize?, tickValue, quantityStep, minimumQuantity}`; `currency` = account currency (tick value must be denominated in it; copy says so); `source 'USER_DEFINED'`. A new version for an existing symbol supersedes it in pickers (latest `created_at` per symbol); old versions stay attached to history.
   - `record_account_values(p_account_id uuid, p_balance text, p_equity text) returns uuid` — wraps `record_observation` with `p_gross_loss = null`.
4. Archived accounts take no new activity (`private.require_active_account`, error prefix `ACCOUNT_ARCHIVED`, shown as "This trading account is archived, so it takes no new trades or records. Restore it in Manage account to use it again."): `create_planned_trade`, `record_live_trade`, `duplicate_trade_draft`, `revise_trade_draft`, `check_trade_risk`, `lock_trade` (and the still-granted V1 `save_setup_proposal` and `check_setup_risk` on an archived account, both redefined in 0015; a replay of an earlier `save_setup_proposal` request still returns its id), `record_account_values`, `add_external_loss`, `create_platform_connection` and imports that create a trade (`ingest_external_execution`) refuse while the latest profile revision is `ARCHIVED`. History stays readable, and the trades the account already holds can be finished: a locked plan's entry, skip or cancel, closes, discards, journal entries, screenshots, tags and reviews. Restoring the account (`update_account_profile`) re-enables everything; the check runs under the account row lock that archive/restore also takes.

### 3.3 Trades, revisions, plan links, lifecycle events

```
public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null, account_id uuid not null,
  origin text not null check (origin in ('PLANNED','LIVE_FIRST','IMPORTED')),
  created_at timestamptz not null default clock_timestamp(),
  request_key uuid,
  duplicated_from uuid,
  migrated_from text check (migrated_from in ('V1_PLAN','V1_PROPOSAL')),
  unique (user_id, account_id, id), unique (user_id, request_key),
  foreign key (user_id, account_id) references public.accounts(user_id, id),
  foreign key (user_id, account_id, duplicated_from) references public.trades(user_id, account_id, id))
index (account_id, created_at desc)

public.trade_revisions (
  proposal_id uuid primary key, trade_id uuid not null, revision int not null check (revision >= 1),
  user_id uuid not null, account_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (trade_id, revision),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id),
  foreign key (user_id, account_id, proposal_id) references public.setup_proposals(user_id, account_id, id))

public.trade_plan_links (
  trade_id uuid primary key, plan_id uuid not null unique,
  user_id uuid not null, account_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id),
  foreign key (user_id, account_id, plan_id) references public.trade_plans(user_id, account_id, id))

public.trade_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null, account_id uuid not null, trade_id uuid not null,
  event text not null check (event in ('DRAFT_DISCARDED','REVIEW_COMPLETED','REVIEW_REOPENED')),
  reason text check (reason is null or length(btrim(reason)) between 1 and 2000),
  recorded_at timestamptz not null default clock_timestamp(),
  request_key uuid, unique (user_id, request_key),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id))
index (trade_id, recorded_at desc)
```

**Backfill (insert-only, deterministic):**
- For every `trade_plans` row `P`: one trade `origin 'PLANNED'`, `migrated_from 'V1_PLAN'`, `created_at = least(P.locked_at, min(created_at of proposals linked to P via setup_locks))`; a `trade_plan_links` row (`created_at = P.locked_at`); the linked proposal (if any) as revision 1 (`created_at = proposal.created_at`).
- For every `setup_proposals` row `S` with no `setup_locks` row: one trade `origin 'PLANNED'`, `migrated_from 'V1_PROPOSAL'`, `created_at = S.created_at`, revision 1 = `S`.
- Backfilled trades have `request_key null`. A test proves: every plan and every proposal maps to exactly one trade; counts match; owner/account preserved; no history row changed.

### 3.4 Planned-trade RPCs (authenticated)

All take the account row lock first (`for update`) when they touch reservations, then the trade. All return `jsonb`.

| RPC | Contract |
|---|---|
| `create_planned_trade(p_account_id, p_proposal jsonb, p_request_key, p_expected_risk_id, p_expected_observation_id)` | Replay on `trades(user_id, request_key)`: must map to the same account and an identical revision-1 proposal, else raise `'IDEMPOTENCY_CONFLICT'`. Otherwise `save_setup_proposal(...)` (free deterministic check, persisted) → insert trade + revision 1. Returns `{tradeId, proposalId, revision:1, evaluationId, result}`. |
| `revise_trade_draft(p_trade_id, p_proposal, p_request_key, p_expected_revision int, p_expected_risk_id, p_expected_observation_id)` | Trade owned, `PLANNED`, not discarded, no plan link, no legacy SKIPPED decision → else `'DRAFT_NOT_EDITABLE'`. Latest revision must equal `p_expected_revision` → else `'DRAFT_CHANGED'`. Replay: a revision whose proposal has `request_key = p_request_key` on this trade is returned. Proposal must keep the trade's account. Inserts revision n+1. |
| `duplicate_trade_draft(p_trade_id, p_request_key, p_expected_risk_id, p_expected_observation_id)` | Any owned trade with at least one revision or a plan. Source proposal = latest revision (or the plan's proposal). Copy with `news` reset to `'UNKNOWN'` (news must be re-verified). A duplicate is a new plan, so it uses the account's current contract of the symbol, exactly like Edit Draft and the pickers (newest version by `created_at desc, id desc`): when that differs from the version the source was written with, `instrumentId` moves to it and `contractConfirmed` becomes false, so the free check blocks with CONTRACT_UNCONFIRMED until the trader confirms the new values. All else identical. New trade `duplicated_from = p_trade_id`. Evidence copying is done by the server afterwards (§7.4). Returns `{tradeId, proposalId}`. |
| `discard_trade_draft(p_trade_id, p_reason text, p_request_key)` | Only DRAFT. Inserts `DRAFT_DISCARDED`. Idempotent. |
| `check_trade_risk(p_trade_id)` | Latest revision → `check_setup_risk(proposal, false)`. Only DRAFT. (`check_setup_risk`, the engine's `private.assess_plan` and `private.check_proposal_risk` refuse a NULL `p_lock` with `INVALID_INPUT: p_lock must be true or false` before writing anything.) |
| `lock_trade(p_trade_id, p_expected_revision int)` | Latest revision must equal expected (`'DRAFT_CHANGED'`). `check_setup_risk(latest, true)`; when `planId` returned, insert `trade_plan_links` if absent. Returns the check envelope plus `tradeId`. BLOCKED → no plan, envelope returned (UI shows reasons). |
| `record_planned_entry(p_trade_id, p_entry text, p_quantity text, p_entered_at timestamptz)` | Requires plan link → `open_journal_trade(plan, ...)` (all V1 checks apply). Returns `{executionId, oversize:boolean, plannedQuantity, actualQuantity}`; the UI must have shown an explicit confirmation when quantity > planned (§8.5). |
| `close_planned_trade(p_trade_id, p_exit text, p_exited_at timestamptz, p_fees text)` | → `close_journal_trade` (FULL_CLOSE_V1, R = net ÷ locked risk, unchanged). |
| `set_planned_disposition(p_trade_id, p_status text, p_reason text)` | → `set_journal_disposition`. |

### 3.5 Live-first and imported positions

```
public.trade_position_facts (            -- entry facts for trades without a Trading OS plan
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null, account_id uuid not null, trade_id uuid not null,
  instrument_version_id uuid,                                   -- known contract (nullable)
  symbol text check (symbol is null or symbol ~ '^[A-Z0-9][A-Z0-9._/-]{0,19}$'),
  direction text check (direction in ('LONG','SHORT')),
  entry_model text check (entry_model in ('OB_FIRST_TOUCH','OTE','OTHER')),
  entry_price numeric check (entry_price > 0),
  entered_at timestamptz,                                        -- user-reported (or broker) entry time
  quantity numeric check (quantity > 0),
  initial_stop numeric check (initial_stop > 0),
  risk_amount numeric(20,2) check (risk_amount > 0),             -- user-reported money at risk
  source text not null check (source in ('USER','IMPORT')),
  recorded_at timestamptz not null default clock_timestamp(),
  request_key uuid, unique (user_id, request_key),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id),
  foreign key (user_id, account_id, instrument_version_id) references public.instrument_versions(user_id, account_id, id),
  check (entry_price is null or entry_price not in ('NaN'::numeric)), ... finite checks like 0007)
index (trade_id, recorded_at, id)
```
Rule: the first row of a trade must carry `symbol` and `direction`. Later rows may only set fields that are still null in the effective state ("complete missing details"); a field is never changed once set. Effective value of each field = first non-null in `(recorded_at, id)` order.

```
public.trade_unplanned_closes (
  trade_id uuid primary key,
  user_id uuid not null, account_id uuid not null,
  exit_price numeric check (exit_price > 0),
  exited_at timestamptz not null,
  fees numeric(20,2) not null check (fees >= 0),
  gross_pnl numeric,
  net_pnl numeric not null,
  pnl_source text not null check (pnl_source in ('CALCULATED','USER_REPORTED','IMPORTED')),
  risk_basis numeric, risk_basis_source text check (risk_basis_source in ('USER_REPORTED','DERIVED')),
  realized_r numeric,
  outcome text not null check (outcome in ('WIN','LOSS','BREAKEVEN')),
  calculation_version text not null default 'UNPLANNED_CLOSE_V1' check (calculation_version = 'UNPLANNED_CLOSE_V1'),
  recorded_at timestamptz not null default clock_timestamp(),
  check ((outcome='WIN' and net_pnl>0) or (outcome='LOSS' and net_pnl<0) or (outcome='BREAKEVEN' and net_pnl=0)),
  check ((realized_r is null) = (risk_basis is null)),
  check ((risk_basis is null) = (risk_basis_source is null)),
  check (gross_pnl is null or net_pnl = gross_pnl - fees),
  finite checks, foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id))
```

Close math (`UNPLANNED_CLOSE_V1`):
- Calculable when instrument, entry price, quantity and exit price are known: `gross = (exit − entry) × dir / tick_size × tick_value × quantity`, `net = gross − fees`, `pnl_source 'CALCULATED'` (a user net P&L is rejected in this case: `'PNL_IS_CALCULATED'`).
- Otherwise the user must report `netPnl` (signed money, ≤ 2 dp) → `pnl_source 'USER_REPORTED'`, `gross null`.
- Risk basis: `risk_amount` if set (`USER_REPORTED`); else derived `|entry − stop| / tick × tick_value × qty` when all known (`DERIVED`); else null → `realized_r null`.
- `realized_r = net / risk_basis` computed exactly (`trim_scale`), never rounded for storage.
- Outcome by sign of net.
- Exit time: not in the future; `≥ entered_at` when known.

RPCs (authenticated): `record_live_trade(p_account_id, p_input jsonb, p_request_key) returns uuid`; `complete_live_entry(p_trade_id, p_input jsonb, p_request_key) returns uuid`; `close_live_trade(p_trade_id, p_input jsonb) returns uuid` (exact replay returns the id; different values raise `'ALREADY_CLOSED'`).
Validation in `record_live_trade`: `instrumentId` must belong to the account (symbol taken from it) or `symbol` must be given; `enteredAt ≤ now`; when instrument is known: entry/stop aligned to tick, quantity to step and ≥ minimum; stop on the correct side of entry when both known.

### 3.6 Live trade journal

```
public.trade_journal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null, account_id uuid not null, trade_id uuid not null,
  kind text not null check (kind in ('NOTE','DECISION','STOP_CHANGE','TARGET_CHANGE','PARTIAL_CLOSE','LESSON')),
  body text check (body is null or length(btrim(body)) between 1 and 5000),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  phase text not null check (phase in ('PRE_ENTRY','LIVE','POST_TRADE')),
  state_at_creation text not null,
  source text not null default 'USER' check (source in ('USER','IMPORT')),
  recorded_at timestamptz not null default clock_timestamp(),
  request_key uuid, unique (user_id, request_key),
  check (body is not null or details <> '{}'::jsonb),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id))
index (trade_id, recorded_at, id)
```
RPC `add_journal_entry(p_trade_id, p_kind, p_body, p_details jsonb, p_request_key) returns uuid`. Details validation: `STOP_CHANGE`/`TARGET_CHANGE` require `{price}` (positive decimal string ≤ 8 dp; tick-aligned when the instrument is known); `PARTIAL_CLOSE` allows `{price?, quantity?, percent?}` (percent 0 < p < 100, at most one of quantity/percent); `NOTE`, `DECISION`, `LESSON` require `body`. Unknown detail keys rejected. `phase` and `state_at_creation` are computed by `private.trade_phase(trade)` / `private.trade_lifecycle(trade)` at insert time (§5). `STOP_CHANGE`, `TARGET_CHANGE` and `PARTIAL_CLOSE` are accepted only while `private.trade_phase` is `LIVE`; otherwise the RPC raises `'ENTRY_NOT_LIVE: Stop, target and partial-close entries can only be recorded while the trade is live'` (a draft's stop and target change through Edit draft, a locked plan cannot change, and nothing is managed after the close). Notes, decisions and lessons fit every phase. Exact replay by `request_key` returns the id (also of an entry accepted while the trade was live); a different payload under the same key raises `'IDEMPOTENCY_CONFLICT'`.

Partial closes are **journal records**, not accounting events: final accounting uses one exit price (FULL_CLOSE_V1 / UNPLANNED_CLOSE_V1), which keeps the math exact for the whole position; true multi-leg accounting is deferred. The close form works that one price out where it can (`src/domain/partial-closes.ts`, `src/components/trade/close-model.ts`): when every `PARTIAL_CLOSE` journaled while the trade was LIVE has a price and an amount (a quantity, or a percent on the first partial only) and together they are less than the position, the field asks for "Exit price of the remaining 70% (≈ 3.66 lots)", shows the average and its arithmetic, and sends that average rounded to the nearest tick (the rounding is shown; it moves the result by at most half a tick × size × tick value). Otherwise (a missing price or amount, a percent after an earlier partial, an unknown position size, partials at or over the position, or a journal that could not be read in full) it asks for "Average exit price (all partials)" with the partials listed and the reason; partials that add up to the whole position prefill their average. The trader can always switch to typing the average.

### 3.7 Trade evidence (V2 screenshots)

New private bucket `trade-evidence` (public false, `file_size_limit 4194304`, mime png/jpeg/webp) with policies mirroring 0005 but keyed to `public.trade_evidence` (owner read requires a registered row with `storage_path = name` and `user_id = auth.uid()`; restrictive guards deny browser insert/update/delete and any read without a registered row). The legacy bucket and its policies are untouched.

```
public.trade_evidence (
  id uuid primary key,
  user_id uuid not null, account_id uuid not null, trade_id uuid not null,
  storage_path text not null unique check (storage_path = user_id::text || '/' || trade_id::text || '/' || id::text),
  label text not null check (label in ('HTF','CONTEXT','PRE_ENTRY','ENTRY','MANAGEMENT','EXIT','OTHER')),
  timeframe text check (timeframe in ('DAILY','H4','H1','M30','M15','M5','M3','OTHER')),
  caption text check (caption is null or length(btrim(caption)) between 1 and 200),
  original_filename text not null check (length(original_filename) between 1 and 255),
  mime_type text not null check (mime_type in ('image/png','image/jpeg','image/webp')),
  byte_size integer not null check (byte_size between 1 and 4194304),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  width integer not null check (width > 0), height integer not null check (height > 0),
  phase text not null check (phase in ('PRE_ENTRY','LIVE','POST_TRADE')),
  state_at_creation text not null,
  capture_method text not null check (capture_method in ('PASTE','DROP','FILE','CAMERA','DUPLICATE','IMPORT')),
  copied_from uuid,
  recorded_at timestamptz not null default clock_timestamp(),
  check (width::bigint * height <= 40000000),
  unique (user_id, account_id, trade_id, id),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id))
index (trade_id, recorded_at, id)

public.trade_evidence_removals (evidence_id uuid primary key, user_id, account_id, trade_id, recorded_at default clock_timestamp(),
  foreign key (user_id, account_id, trade_id, evidence_id) references public.trade_evidence(user_id, account_id, trade_id, id))

public.trade_evidence_labels (            -- relabel history; latest wins; phase never changes
  id bigint generated always as identity primary key, evidence_id uuid not null, user_id, account_id, trade_id,
  label text not null (same check), timeframe text (same check), caption text (same check),
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (user_id, account_id, trade_id, evidence_id) references public.trade_evidence(user_id, account_id, trade_id, id))
```
- `register_trade_evidence(p_user_id uuid, p_record jsonb) returns jsonb` — **service_role only**; called by the upload route after byte validation and storage upload. Re-verifies the trade belongs to `p_user_id`; locks the trade row (`for update` on `trades`); enforces ≤ 24 active (non-removed) items per trade (`'EVIDENCE_LIMIT'`); computes `phase`/`state_at_creation`; replay with the same `id` and `sha256` returns the existing row; different content under the same id raises.
- `remove_trade_evidence(p_evidence_id)` and `relabel_trade_evidence(p_evidence_id, p_label, p_timeframe, p_caption)` — authenticated, owner only, append-only.

### 3.8 Tags (any trade)

```
public.trade_tag_sets (
  id bigint generated always as identity primary key,
  user_id, account_id, trade_id,
  setup_grade text check (setup_grade in ('A+','A','B','C','INVALID')),
  liquidity_context text check (liquidity_context in ('ARL_HIGH','ARL_LOW','PDH','PDL','PWH','PWL','KZ_HIGH','KZ_LOW','EQUAL_HIGHS','EQUAL_LOWS','OTHER')),
  mss_timeframe text check (mss_timeframe in ('M15','M5','M3')),
  tags text[] not null default '{}' check (private.valid_tags(tags)),     -- ≤ 12 tags, each ^[a-z0-9][a-z0-9 _-]{0,31}$, unique
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (user_id, account_id, trade_id) references public.trades(user_id, account_id, id))
```
`set_trade_tags(p_trade_id, p_grade, p_liquidity, p_mss, p_tags text[]) returns bigint`. Effective tags = latest set; for legacy plans with no V2 set, the latest `trade_tag_revisions` row is shown (read-only).

### 3.9 External losses (daily loss input redesign)

```
public.external_loss_entries (
  id uuid primary key default gen_random_uuid(), user_id, account_id,
  trading_day date not null,                       -- strategy day at recording
  amount numeric(20,2) not null check (amount > 0 and amount < 1000000000000),
  note text check (note is null or length(btrim(note)) between 1 and 500),
  recorded_at timestamptz not null default clock_timestamp(),
  request_key uuid, unique (user_id, request_key),
  foreign key (user_id, account_id) references public.accounts(user_id, id))
public.external_loss_removals (entry_id uuid primary key references public.external_loss_entries(id), user_id, account_id,
  reason text check (reason is null or length(btrim(reason)) between 1 and 500), recorded_at default clock_timestamp())
```
RPCs: `add_external_loss(p_account_id, p_amount text, p_note text, p_request_key) returns uuid` (amount money ≤ 2 dp; `trading_day = private.strategy_day(clock_timestamp())`); `remove_external_loss(p_entry_id, p_reason text)`.

### 3.10 Risk policy v2 (versioned)

- `alter table public.risk_plan_versions add column default_risk_percent numeric(11,8)` plus `check (default_risk_percent is null or (default_risk_percent > 0 and default_risk_percent <= max_risk_percent))`. Legacy versions: `null` means "default equals maximum" (V1 behaviour).
- `create_risk_policy_version(p_account_id, p_config jsonb, p_immediate boolean, p_reason text) returns uuid` — same semantics as `create_risk_version` (next strategy day unless immediate with a reason of ≥ 5 chars; `configuration_events RISK_VERSION_CREATED`; name `'Risk Plan V1.'||count`) plus `defaultRiskPercent` (required, ≤ max).
- `private.active_risk_plan(p_account_id uuid, p_day date) returns public.risk_plan_versions` — **precedence fix**: among versions with `effective_day <= p_day`, the newest *created* wins (`order by created_at desc, id desc`). This fixes V1 finding C9 (a next-day loosening scheduled before an immediate tightening silently undid the tightening). Used by every V2 path and, from 0016, by the engine.
- Risk-plan history labels (account dashboard and Manage → Risk policy, `riskPlanTimeline` in `src/lib/accounts-data.ts`) apply the same rule at every instant: a version can first govern a check at its start, the later of its creation and 00:00 UTC−5 of its effective day. When a newer version (by `created_at desc, id desc`) already existed then and had already started, it outranks this one for good, so this version never governed a check: "Replaced before it started", on every day, also after its own day has passed (the C9 case). Any other past version is "Replaced", also when it was replaced on its own first day (two immediate changes on one day, an immediate edit on the account's first day, an immediate change on the day a scheduled version starts); a future one is "Starts tomorrow" / "Starts Oct 21"; the active one is "Active".

### 3.11 Schema marker

`public.trading_os_schema() returns text` → `'2.0'` (stable, `security invoker`, granted to authenticated). The app layout calls it once per request; when missing, the app renders a full-page "Database update required" state and performs no writes (§13.10).

### 3.12 Ledger view `public.trade_ledger` (security_invoker, one row per trade)

Columns (normative; computed with lateral joins; numeric columns cast to text with `trim_scale`):
`id, account_id, origin, created_at, duplicated_from, migrated_from, currency,`
`revision_count, latest_revision, latest_proposal_id, latest_revision_at, latest_check_decision ('APPROVED'|'BLOCKED'|null), latest_check_at, latest_check_evaluation_id,`
`plan_id, locked_at, plan_trading_day, strategy_version_id, strategy_version, risk_plan_version_id, risk_plan_version,`
`symbol, instrument_version_id, direction, entry_model,`
`planned_entry, planned_stop, planned_target, requested_risk_percent, planned_rr, planned_quantity, planned_risk,`
`entry_price, entered_at, entry_time_known (bool), entry_recorded_at, quantity, initial_stop, initial_risk (R denominator: plan nominal for planned; risk basis for unplanned), actual_initial_risk (planned: |fill − planned stop| / tick × tick_value × qty; unplanned: same as derived basis), oversize (planned: quantity > planned_quantity),`
`exit_price, exited_at, close_recorded_at, fees, gross_pnl, net_pnl, realized_r, outcome, calculation_version, pnl_source,`
`disposition ('SKIPPED'|'CANCELLED'|null), disposition_reason, legacy_decision ('TAKEN'|'SKIPPED'|null), discarded_at,`
`lifecycle, draft_check, review_completed_at,`
`setup_grade, liquidity_context, mss_timeframe, tags (text[]), tag_source ('V2'|'V1'|null),`
`evidence_count (active, V2 + legacy), cover_evidence_id, cover_evidence_kind ('V2'|'LEGACY'), journal_count, ai_review_count`.
Planned trades take plan/proposal values from the locked plan when present, else from the latest revision. Live-first/imported take them from effective position facts; their `planned_*` columns are null (**never fabricated**).

`journal_analytics` (V1) stays untouched for V1 AI consumers.

---

## 4. Migration order

| File | Content | Depends on |
|---|---|---|
| `0015_canonical_trades.sql` | §3 (template, accounts, trades, revisions, positions, journal, evidence, tags, external losses, risk policy v2, ledger view, schema marker) | 0001–0014 |
| `0016_risk_engine_usage.sql` | §6 (engine/report v1.2, daily usage, precedence in engine paths, canonical decimals) | 0015 |
| `0017_platform_connections.sql` | §8.6 (connections, external executions, links, ingest) | 0015 |
| `0018_trade_ai_timeline.sql` | §11.3–11.4 (AI on trade evidence; timeline-aware trade review table + RPCs) | 0015 |
| `0019_account_erasure.sql` | §10.4 (erasure, TRUNCATE guards on every public table, service_role DML revokes) — **must stay last** | all |

Every migration must apply cleanly on PGlite (PostgreSQL 18, plpgsql only, no extensions, single multi-statement exec) using the stub in `tests/*-database.test.ts`, and on Supabase PostgreSQL 17.

---

## 5. Time semantics and phase integrity (P0)

### 5.1 Authoritative time sources

| Fact | Authoritative timestamp | Source |
|---|---|---|
| Draft revision written | `trade_revisions.created_at` | server clock |
| Plan locked | `trade_plans.locked_at` | server clock |
| Entry happened | planned: `trade_executions.entered_at`; unplanned: effective `trade_position_facts.entered_at` | **user-reported** (bounded: at or after lock for planned; not in the future) |
| Entry recorded | `trade_executions.recorded_at` / first facts row `recorded_at` | server clock |
| Exit happened | `trade_outcomes.exited_at` / `trade_unplanned_closes.exited_at` | user-reported (at or after entry; not in the future) |
| Note/evidence recorded | `recorded_at` | server clock |

Phase is **never** taken from a client label or a client-supplied time.

### 5.2 Stored phase (at creation)

`private.trade_phase(trade_id)` at insert time:
- a close exists (planned outcome or unplanned close) → `POST_TRADE`;
- an entry exists (planned execution, or any live-first/imported trade — those are live from creation) → `LIVE`;
- a planned trade that ended without an entry (`private.plan_ended_at`: the earliest of the `DRAFT_DISCARDED` event, the skip/cancel disposition of its plan and a latest V1 `SKIPPED` decision) → `POST_TRADE`, so a note or screenshot added after the end is never stored as pre-entry evidence;
- otherwise → `PRE_ENTRY`.

`state_at_creation` stores the lifecycle at that moment (`DRAFT`, `LOCKED`, `LIVE`, `CLOSED`, …).

### 5.3 Effective timing (read time, pure function `classifyTiming`, TS)

Inputs: `recordedAt`, `storedPhase`, `origin`, `entryAt` (null if unknown), `entryRecordedAt`, `exitAt` (null if open), `endedAt` (when a planned trade ended without an entry, `planEndedAt` = `private.plan_ended_at`; null otherwise). Microsecond-exact instant comparison (reuse `instantKey` from `analytics.ts`).

```
if origin != PLANNED                                     -> never BEFORE_ENTRY
if exitAt != null and recordedAt >= exitAt               -> AFTER_CLOSE
if endedAt != null and recordedAt >= endedAt             -> AFTER_CLOSE (+ flag RECORDED_AFTER_PLAN_ENDED unless storedPhase == POST_TRADE)
if storedPhase == POST_TRADE                             -> AFTER_CLOSE
if storedPhase == PRE_ENTRY and (entryAt == null or recordedAt < entryAt)
                                                         -> BEFORE_ENTRY
if storedPhase == PRE_ENTRY and entryAt != null and recordedAt >= entryAt
                                                         -> WHILE_LIVE + flag RECORDED_AFTER_EXECUTION_BEGAN
otherwise                                                -> WHILE_LIVE
```
For live-first trades with unknown entry time, `entryAt` is treated as `trade.created_at` (the position was already open when recorded).

UI labels (exact): **Before entry**, **While live**, **After close**; flag copy: **"Recorded after execution began"**, **"Recorded after the plan ended"** (a row stored before the end rule existed keeps its stored phase and is marked, never rewritten). Trade Detail groups the timeline into these three bands. Only `BEFORE_ENTRY` items may be presented as pre-entry evidence anywhere (Trade Detail "Plan" section, AI facts `PRE_ENTRY`, analytics). A post-trade note can therefore never masquerade as pre-entry evidence, even if an entry time is later back-dated (the stored phase alone can never upgrade an item to BEFORE_ENTRY; the timestamp check can only downgrade).

### 5.4 Timeline assembly (TS, `src/domain/timeline.ts` + loader)

Items (each `{id, kind, at, recordedAt, timing, title, body?, details?, evidenceId?, source}`), sorted by `(at, recordedAt, id)` in causal order where one action writes its records a few milliseconds apart: a risk check is never placed before the revision it evaluated (check inputs carry the proposal id), and the evaluation that authorised a lock (`trade_plans.risk_evaluation_id`) is placed right before "Plan locked"; displayed times never change:
draft revisions ("Draft created" / "Draft revised · revision n"), risk checks ("Risk check: Approved/Blocked" with first reason), plan lock, V1 `trade_events` (NOTE_ADDED as notes; TRADE_OPENED/CLOSED skipped when the execution/outcome rows render them), V1 human decisions (`setup_human_decisions` on the trade's revisions, read owner-filtered: "Decision: Skipped", "Decision: Taken", or "Taken despite a block" for a V1 manual override, with the trader's reason as the body and timing from the recording time; the V1 skip that ended the plan stays Before entry, like a disposition), entry ("Trade opened" at `entered_at`, with "recorded hh:mm" when recorded more than 5 minutes after `entered_at`), size deviation ("Size above plan: 1.00 vs 0.25 lots"), journal entries, evidence added/removed (V2 and legacy screenshots via `uploaded_at`), tag changes, disposition, close ("Trade closed: +3.40R"), AI analyses (compact), review completed/reopened, discard.
`at` = the event's real time (entry/exit use user-reported times; everything else uses `recordedAt`). Both are shown when they differ by more than 5 minutes ("09:42 · recorded 10:15"). A recording shown on another day than the event dates both times ("Sep 15, 03:15 · recorded Oct 31, 06:02"), and once the times shown (events and the recordings shown) span more than one day, every time on the timeline carries its day.
The lock and its own evaluation are always Before entry with no flag: an entry may be stored at `locked_at` itself (an entry typed in the lock's minute), and the lock transaction writes the authorising evaluation a few milliseconds after `locked_at`, so neither the lock nor that evaluation is ever shown, or sent to AI, as recorded after execution began.

---

## 6. Risk Engine v1.2 (`0016_risk_engine_usage.sql` + `src/domain/risk.ts`)

### 6.1 What changes and why

| Finding (V1 audit) | V2 fix |
|---|---|
| C1/C2/C13: display rounding contradicts verdicts | §6.6 formatting rules; no `Number(x).toFixed` in money/R/percent paths |
| C3: daily loss cap double-counts closed losing trades | loss check uses realized losses + **open exposure**, not all reservations |
| Daily loss typed manually | realized loss computed from closed trades (planned + live-first) + explicit external losses |
| Live-first trades invisible to daily limits | unplanned trades entered today count toward trade slots and daily risk |
| C5/C12: long/inexact SQL decimals | canonical `trim_scale` strings; exact RR via `div` |
| C6/C7: preview hides blockers; messages differ | TS mirrors SQL rule coverage + `ruleResults`; one message catalogue with params |
| C9: risk-version precedence | `private.active_risk_plan` everywhere |
| Generic BLOCKED copy | every issue carries `params`; UI renders exact sentences |

Engine/report versions: `engineVersion "1.1"`, `reportVersion "1.2"`. Stored 1.1 and legacy reports stay valid (`storedRiskSchema` = union 1.2 | 1.1 | legacy). Plans locked under 1.1 keep their reports.

### 6.2 Daily usage (`private.daily_usage(p_account_id uuid, p_now timestamptz, p_exclude_plan uuid default null) returns jsonb`)

All on strategy day `d = private.strategy_day(p_now)`:
- `plannedSlots` = count of `trade_plans` with `trading_day = d` (excluding `p_exclude_plan`) — unchanged V1 reservation semantics (closed/skipped plans do **not** release a slot).
- `plannedRisk` = sum of `nominal_risk` of those plans (V1 `riskConsumed` semantics for the daily risk cap).
- `unplannedTrades` = count of LIVE_FIRST/IMPORTED trades whose entry day is `d` (entry day = strategy day of effective `entered_at`, else of the first facts row `recorded_at`).
- `unplannedRisk` = sum of known risk basis of those trades; `unplannedRiskUnknown` = count without a basis.
- `riskUnknownTrades` = number of **distinct** LIVE_FIRST/IMPORTED trades without a risk basis that were entered on day `d` or are still open (the two counters above and below overlap, so they must never be summed for display).
- `realizedLoss` = sum of `max(0, -net_pnl)` over planned outcomes and unplanned closes whose strategy day of `exited_at` is `d`.
- `externalLoss` = sum of non-removed `external_loss_entries.amount` with `trading_day = d`.
- `legacyReportedLoss` = latest observation's `gross_loss_today` when that observation is from day `d`, else null.
- `openExposure` = sum over positions still at risk: today's plans with no outcome and no disposition (risk = `greatest(nominal_risk, actual_initial_risk if executed)`); executed planned trades from earlier days with no outcome (same); open unplanned trades of any day (known basis; unknown counted in `openRiskUnknown`).
- `lossTotal = greatest(coalesce(legacyReportedLoss, 0), realizedLoss + externalLoss)` — the `greatest` prevents double counting when a V1-style manual total already includes today's losses, and never under-counts versus V1.

`public.get_daily_risk_usage(p_account_id uuid) returns jsonb` (authenticated, owner check) exposes the same object for the TS preview and Today.

### 6.3 Rules in v1.2 (codes unchanged unless new)

Same 18 hard rules (`RISK_RULES`) and the same WARN codes, with these input changes:
- `MAX_TRADES`: `plannedSlots + unplannedTrades >= maxDailyTrades` → BLOCK.
- `DAILY_RISK_LIMIT`: cap configured and `plannedRisk + unplannedRisk + nominal > cap` → BLOCK.
- `DAILY_LOSS_LIMIT`: cap configured and `lossTotal + openExposure + nominal > cap` → BLOCK. `DAILY_LOSS_UNKNOWN` is no longer produced by 1.2 (the total is always known); when the observation is stale, `STALE_EQUITY` blocks as before.
- New WARN `UNPLANNED_RISK_UNKNOWN` when `riskUnknownTrades > 0`, with `params.n = riskUnknownTrades`: "{n} live-first trade(s) without recorded risk are not included in the daily risk totals."
- Everything else (RISK_LIMIT strict `>`, MIN_RR cross-multiplication with `rr_policy`, MINIMUM_QUANTITY, OFF_TICK, PRICE_GEOMETRY, DEAD_POOL, OUTSIDE_ACTIVE, DUPLICATE, STALE_EQUITY, STRATEGY_CONTRADICTION, NEWS_RESTRICTED/NEWS_UNKNOWN, CONTRACT_UNCONFIRMED, INSTRUMENT_MISMATCH, COSTS_UNKNOWN, `*_UNCONFIGURED`) is unchanged.
- Rule coverage parity: like `private.risk_report`, MAX_TRADES, DEAD_POOL and STALE_EQUITY are always evaluated even when input/geometry errors stop sizing; TS does the same.

### 6.4 Report 1.2 shape (`riskReportSchemaV12`, strict)

Superset of 1.1:
- `engineVersion: "1.1"`, `reportVersion: "1.2"`, `decision`, `status`, `issues[{code, severity, message, params}]` where `params` is a flat object of canonical strings/numbers (e.g. `{requested:"1", maximum:"0.75"}`), `ruleResults` (all 18 codes exactly once), `requestedRiskPercent`, `targetDistance`, `sessionEligible`, `calculations` (canonical strings: `budget, permittedRisk, stopDistance, stopTicks, stopPips, plannedRR, quantity, nominalRisk, plannedReward`).
- `limits: {maxRiskPercent, defaultRiskPercent|null, minRR, rrPolicy, newsPolicy, maxDailyTrades, dailyRiskCap|null, dailyLossCap|null, riskPlanVersion}` (self-describing; no join needed to explain).
- `instrument: {symbol, currency, tickSize, pipSize|null, tickValue, quantityStep, minimumQuantity, quantityUnit}`.
- `snapshot`: 1.1 fields (`accountObservationId, observationDay, equity, currency, instrumentVersionId, slotsUsed (= planned + unplanned), executedTrades (= unplannedTrades, a number), maximumDailyTrades, riskConsumed (= plannedRisk + unplannedRisk), grossLoss (= lossTotal)`) plus `plannedSlots, unplannedTrades, plannedRisk, unplannedRisk, unplannedRiskUnknown, realizedLoss, externalLoss, legacyReportedLoss|null, openExposure, openRiskUnknown`.
- Canonical numbers: `trim_scale()` on every numeric text in SQL; `Decimal#toFixed()` with trailing zeros stripped in TS (never exponent notation). `plannedRR` = exact 8-dp truncation `div(reward × 10^8, distance) / 10^8`, trimmed (e.g. `"3"`, `"2.995"`, `"2.99666666"`).
- `isRiskReportCurrent` extends to 1.2 (adds unplanned/realized/external/openExposure equality) and uses the **server time** passed by the page, never the browser clock (V1 finding C8).

### 6.5 Messages catalogue (`src/domain/risk-explain.ts`, single source for display)

`explainIssue(issue, report)` → `{code, severity, title, detail}`; for 1.1/legacy reports, missing params are reconstructed from the report plus the immutable `risk_plan_versions` row (`maxRiskPercent`, `minRR`, caps) and `instrument_versions` row, loaded by `riskPlanVersionId`/`instrumentVersionId`. Exact sentences (values formatted by §6.6):

| Code | Sentence |
|---|---|
| RISK_LIMIT | Requested risk {requested}% exceeds your configured maximum of {maximum}%. |
| MIN_RR | Planned RR {rr}R is below the required minimum of {min}R. (WARN policy: "Planned RR {rr}R is below your {min}R minimum. Your risk plan allows it with a warning.") |
| MAX_TRADES | Daily trade limit reached: {used} of {max} trades already used today ({planned} planned, {unplanned} recorded live). |
| DEAD_POOL | Trading is not permitted during Dead Pool (12:00–18:00 UTC−5). New plans can be locked from 18:00. |
| OUTSIDE_ACTIVE (WARN) | Outside the active kill zone (02:00–12:00 UTC−5). |
| DAILY_RISK_LIMIT | Remaining daily risk {remaining} is insufficient for this trade's {nominal} risk (cap {cap}). |
| DAILY_LOSS_LIMIT | Today's realized losses {loss} plus open risk {open} plus this trade's {nominal} would exceed your daily loss limit of {cap}. |
| STALE_EQUITY | Confirm today's account balance before locking (last recorded {observationDay}). |
| MINIMUM_QUANTITY | Your {budget} risk budget is too small for the minimum position size of {minQty} {unit} at this stop. |
| OFF_TICK | Prices must align to the {symbol} tick size of {tick}. |
| PRICE_GEOMETRY | For a {direction} trade, the stop must be {below/above} entry and the target {above/below} entry. |
| MISSING_STOP | A stop loss is required. |
| CONTRACT_UNCONFIRMED | Confirm that the {symbol} contract values match your broker. |
| INSTRUMENT_MISMATCH | {symbol} is valued in {instrumentCurrency}, but this account uses {accountCurrency}. |
| DUPLICATE | An identical plan (same instrument, direction, model, entry, stop and target) already reserves a slot today. |
| STRATEGY_CONTRADICTION | Blocked because you flagged a contradiction with your {strategy} rules. |
| NEWS_RESTRICTED | You reported a restricted news window. Your risk plan {blocks / warns about} trading in restricted news. |
| NEWS_UNKNOWN (WARN) | Economic news has not been checked. |
| DAILY_RISK_UNCONFIGURED / DAILY_LOSS_UNCONFIGURED (WARN, low priority) | No daily risk cap is configured. / No daily loss limit is configured. |
| UNPLANNED_RISK_UNKNOWN (WARN) | {n} live-first trade(s) without recorded risk are not included in the daily risk totals. |
| COSTS_UNKNOWN (note, collapsed) | Sizing uses the stop distance only; fees, gaps and slippage are not included. |
| SIZING_INVARIANT | Position sizing failed an internal safety check. Nothing was locked. |
| INVALID_INPUT | Field-level messages ("Entry price must be a positive number with up to 8 decimals."), never zod paths. |

Display order: all BLOCK issues first (engine order), then WARN; `COSTS_UNKNOWN` and `*_UNCONFIGURED` collapse into "n notes" by default. SQL stores the same sentences in `message` for 1.2 reports (audit), but the UI always renders from code + params.

### 6.6 Number display rules (`src/domain/format.ts`)

- **Policy and user inputs** (risk %, max %, min RR, caps, prices): exact value, trailing zeros stripped, padded to 2 dp minimum (`0.5` → `0.50`, `0.504` → `0.504`, `0.755` → `0.755`). Prices use the instrument's tick scale (`1.1` → `1.10000`).
- **Values compared against a threshold** (`formatAgainst(value, threshold, rule)`): start at `max(2, scale(threshold))` decimals; round toward the side that preserves the verdict (down for minimum rules such as RR; up for maximum rules such as risk % or money vs cap); add decimals (≤ 8) until the displayed comparison agrees with the engine verdict. Example: RR `2.995` vs min `3` → "2.99R"; `2.99666666` → "2.99R". Equality (`4.00` vs `4.00`) displays equal and passes.
- **R**: `formatR` → `+1.01R`, `-1.00R`, `0.00R`; non-zero |R| < 0.005 shows up to 4 dp (`+0.003R`, `-0.0002R`) — never `-0.00R`. One formatter everywhere (summary, tables, charts, AI fact display).
- **Money**: `formatMoney(value, currency)` with `Intl.NumberFormat` currency style, 2 dp, half-up for display only; long SQL-scale strings (`"98.00000000000000000000000000000000"`) render `$98.00`.
- **Money at risk and room left**: money at risk (a plan's nominal risk, an initial risk) is rounded **up** to the cent wherever it is shown (trade page, lock dialog, Plan vs reality, Today's plan rows and live cards: nominal 530.452 → "$530.46"), and the room left under a cap after locking is rounded **down** ("$469.99 left after locking" for 469.996), so neither looks safer than the engine's figure. Today's realized losses beside a daily loss limit round half-up like the day's result, and switch to `formatAgainst` only when half-up rounding would put the figure on the other side of the limit.
- **Planned RR on the trade page** is formatted against the minimum the check itself compared it with (`limits.minRR` of a 1.2 report, else the evaluating risk-plan version's `minRR`), so a plan locked under a 2.995R minimum reads "2.995R"; without a known minimum it is truncated to 2 decimals, which never shows a failing RR as passing.
- **Percent of account**: label "Planned risk" = requested `riskPercent`; "Risk at stop" = nominal ÷ equity (when shown, always labelled).

### 6.7 TypeScript contract (normative; `src/domain/risk.ts`)

```ts
export interface DailyUsage {            // exactly the JSON keys returned by private.daily_usage / get_daily_risk_usage
  day: string;                           // strategy day YYYY-MM-DD
  plannedSlots: number; plannedRisk: string;
  unplannedTrades: number; unplannedRisk: string; unplannedRiskUnknown: number;
  realizedLoss: string; externalLoss: string; legacyReportedLoss: string | null;
  openExposure: string; openRiskUnknown: number; riskUnknownTrades: number;
  lossTotal: string;                     // greatest(coalesce(legacyReportedLoss,0), realizedLoss + externalLoss)
}
export interface RiskPlan {
  id: string; version: string; maxRiskPercent: string; defaultRiskPercent: string | null;
  maxDailyTrades: number; minRR: string; rrPolicy: "BLOCK" | "WARN"; newsPolicy: "BLOCK" | "WARN";
  dailyRiskCap: string | null; dailyLossCap: string | null;
}
export interface Instrument {
  id: string; symbol: string; currency: string; quantityUnit: string; tickSize: string; pipSize: string | null;
  tickValue: string; quantityStep: string; minimumQuantity: string;
}
export interface RiskContext {
  now: string;                            // server time (ISO with zone)
  strategyVersionId: string; strategyVersion: string;
  observationId: string; observationDay: string; equity: string; currency: string;
  plan: RiskPlan; instrument: Instrument; usage: DailyUsage; duplicate: boolean;
}
export function evaluateRisk(raw: unknown, ctx: RiskContext): RiskReportV12;   // byte-for-byte parity with SQL report 1.2 except evaluatedAt/ids
```
The V1 fields `slotsUsed`, `riskConsumed`, `grossLoss` are removed from `RiskContext` (they are derived from `usage`); every caller and fixture is updated in the same change. Integers stay JSON numbers; every decimal is a canonical string (no trailing zeros, no exponent).

---

## 7. Evidence pipeline (P0)

### 7.1 Capture (client, `EvidenceStager`)

- **Ctrl/⌘+V** anywhere on Plan Trade, Edit Draft and Trade pages (unless focus is in a plain text field other than the journal composer) stages clipboard images (`ClipboardEvent.clipboardData.items` of `image/*`).
- **Drag & drop** onto the page (full-page drop overlay) or the composer/gallery drop zone.
- **File picker** (multi-select) and, on mobile, `accept="image/*" capture="environment"`.
- Immediate preview via object URLs; per item: label select (default by phase: draft → `PRE_ENTRY`; live → `MANAGEMENT`; after close → `EXIT`; the user can pick HTF/CONTEXT/ENTRY/OTHER), optional timeframe, optional caption, remove/replace before saving. Client checks: type png/jpeg/webp, ≤ 4 MiB (the server re-validates everything).
- Each staged image gets a client-generated `evidenceId` (UUID) for idempotent retries.
- Save: one request per image, sequential with progress, to `POST /api/trades/[id]/evidence`.

### 7.2 Upload route (server)

`routeUser(request, true)` (same-origin + auth) → trade ownership via the user's RLS client → `boundedBody(4 MiB + 64 KiB)` → `validateScreenshot` (existing magic-byte + full sharp decode, 40 MP, single frame) → trusted server uploads to `trade-evidence/{uid}/{tradeId}/{evidenceId}` (`upsert:false`; an existing object with identical sha256 is treated as a replay) → `register_trade_evidence` (service role) → on failure remove the object (`storage_cleanup_failed` logged when cleanup fails) → `201 {id, phase}`. Errors: 409 evidence limit, 413 size, 400 type/decode, 404 trade, 503 storage.

### 7.3 Delivery

`GET /api/evidence/[id]` (owner via RLS + storage policy, `private, no-store`, `nosniff`, `inline`); `?variant=thumb` returns a sharp-resized WEBP (fit inside 640×640, no upscaling). Legacy `GET /api/screenshots/[id]` gains the same `?variant=thumb`.

### 7.4 Reuse on duplicate

Duplicating a draft copies only the source trade's active evidence whose timing in the source was **Before entry** (for a source that is still a draft: all active evidence), and of a plan that ended without an entry only what was recorded before its end (`private.copyable_evidence`). Live and after-close evidence is never copied, because it would become "pre-entry" evidence of the new draft. Copies go to the new trade's path (legacy bucket → new bucket via download/upload), registered with `capture_method 'DUPLICATE'`, `copied_from` = source id, same sha256; the viewer shows "Copied from an earlier trade · originally recorded {time}". Revisions of the same trade need no copy (evidence belongs to the trade).

### 7.5 Gallery and viewer

Gallery grouped by timing band (Before entry / While live / After close), large thumbnails (≥ 240 px wide desktop, 2-up mobile), label + timeframe + time chip, "Selected for AI" indicator, select/deselect for AI (checkbox overlay; per-operation maximum enforced in UI and server). Fullscreen viewer: `←/→` previous/next, `Esc` close, caption, label, timing band, recorded time, relabel, remove (confirm). Legacy screenshots appear in the same gallery (label derived from role: `DAILY/H4/H1 → HTF`, others → `OTHER`; timeframe = role), removable but not relabelable.

---

## 8. Workflows

### 8.1 Planned

Plan Trade form (§14.2) → **Save draft** (`create_planned_trade`; the free deterministic check runs and is shown) → Trade page shows exact BLOCKED reasons or "Ready to lock" → **Edit draft** (new revision; evidence and thesis preserved) → optional AI (Analyze setup / Challenge my bias, cost shown, never automatic) → **Lock plan** (confirmation dialog listing what becomes immutable and what is reserved) → **Record entry** (an entry that differs from the plan, or entered at an Earlier time, is confirmed first, §8.5) → live journal → **Close trade** (always through a confirmation, below) → review.

Closes and entries are immutable, so neither is sent from a key press or a click alone. Close trade, Enter and Ctrl/⌘+Enter in the close form only open "Close this trade?" (focus starts on "Keep editing", so a second Enter returns to the form). It lists what will be recorded (exit price, exit time, fees) and the result worked out exactly as the database will (`src/domain/close-preview.ts`: outcome, net P&L, realized R; a database test compares the preview with what `close_planned_trade` / `close_live_trade` store); the close is sent only from the dialog's "Close trade", and a refusal stays in the dialog, then in the form. Without the trade's facts the dialog shows "Calculated when you confirm" with the R basis in words instead of inventing figures.

### 8.2 Live-first

**Record Live Trade** (§14.3: account, instrument, direction, entry price or "already open", entry time if known, optional size/stop/risk) → Trade page opens with the composer focused and the banner "No pre-trade plan was recorded before execution." → notes, screenshots, decisions, stop/target changes → **Close trade** (exit price, or net P&L when price math is impossible; confirmed in "Close this trade?" like a planned close, §8.1) → post-trade explanation (notes recorded after close are labelled After close) → review. Missing entry details can be completed once ("Add entry details").

### 8.3 Paid AI is never the default

Before any paid call the deterministic check must have run for the current revision. When the latest check is BLOCKED, AI buttons are secondary and labelled "Analyze blocked setup anyway · ≈ €0.02". No AI request is ever sent without an explicit click; no AI runs on page load. Live-first/imported trades never show "Analyze setup"/"Challenge my bias" (pre-trade tools); they get "Review this trade" after close, and the AI facts state that no pre-trade plan exists.

### 8.4 Daily loss input

The Settings "Today's gross realized losses" input is removed. Known losses are computed (§6.2) and shown on Today ("Realized losses today $50.00 · 1 closed trade"). External losses are explicit: **Add external loss** (amount, optional note; helper copy: "Losses from trades not recorded in Trading OS today, for example on another platform.") with remove (audited). Account values (balance/equity) are confirmed via **Update account values** (one click when unchanged: "Confirm unchanged"). When broker sync exists, synced trades become Trading OS trades and are therefore counted once; the external-loss helper copy warns not to enter losses of synced trades.

### 8.5 Plan vs reality

Trade page table for planned trades: Planned entry → Actual entry (signed slippage in ticks and pips), Planned stop → (the stop never changes the R basis), Planned size → Actual size (ratio; "Oversized" flag when above plan), Planned risk → Risk at stop (actual), Planned target → Actual exit, Planned RR → Realized R, Planned model → Model. Live-first trades show "No pre-trade plan recorded" instead of the planned column (no fabricated values).
Entry form: when quantity > planned quantity, show "Actual size {q} exceeds the plan's {p} ({ratio}×). This will be recorded as a size deviation." and require a confirming checkbox. The plan's price and size with "Now" record at once; a price or size that differs from the plan, or an "Earlier" time, first opens "Record this entry?", which shows the difference from the plan in ticks ("1 tick above the plan's 3482.24"), the size ratio and the time, and records only when confirmed.

### 8.6 Imported trades and connections (connection-ready, mock only)

Migration `0017_platform_connections.sql`:
```
public.platform_connections (id uuid pk, user_id, account_id, provider text check in ('CTRADER','MT5','MOCK'),
  label text (1..60), external_account_ref text (<= 40 chars, masked display reference, never a secret),
  created_at, request_key unique per user, fk accounts)
public.platform_connection_events (id bigint identity pk, connection_id uuid, user_id, account_id,
  status text check in ('PENDING','CONNECTED','SYNCING','SYNCED','ERROR','DISCONNECTED'),
  message text (<= 300, human, no secrets), synced_through timestamptz, recorded_at)
public.external_executions (id uuid pk, user_id, account_id, connection_id, external_id text (1..120),
  symbol text, direction, volume numeric > 0, entry_price numeric > 0, entered_at timestamptz,
  exit_price numeric, exited_at timestamptz, commission numeric(20,2), swap numeric(20,2), realized_pnl numeric(20,2),
  currency text, payload_hash text (sha256 hex), received_at, unique (connection_id, external_id))
public.trade_execution_links (id bigint identity pk, user_id, account_id, trade_id, external_execution_id,
  action text check in ('LINK','UNLINK'), method text check in ('AUTO_MATCH','USER','IMPORT_CREATED'), recorded_at)
private.platform_connection_secrets (connection_id uuid primary key, sealed bytea, created_at)  -- no grants; unused in V2
```
RPCs:
- `create_platform_connection(p_account_id, p_provider, p_label, p_request_key)` — authenticated; only `MOCK` is accepted (raises `'PROVIDER_NOT_AVAILABLE'` for `CTRADER`/`MT5` in V2), and the server only calls it for MOCK in developer mode.
- `disconnect_platform_connection(p_connection_id)` — authenticated.
- `ingest_external_execution(p_user_id, p_connection_id, p_execution jsonb, p_decision jsonb)` — **service_role only**; dedup by `(connection_id, external_id)`; identical `payload_hash` → no-op; a position first seen open and later seen closed (identity fields symbol, direction, volume, entry price and entry time unchanged; exit data newly present) appends an `external_execution_closes` row and, for an IMPORTED trade created from it, the unplanned close (`pnl_source 'IMPORTED'`); any other changed payload is recorded as a connection event warning and never overwrites; decision `{kind:'CREATE'}` creates an `IMPORTED` trade + position facts (`source 'IMPORT'`) + unplanned close when exit data is present (`pnl_source 'IMPORTED'`, `realized_r` only with a risk basis) + link `IMPORT_CREATED`; `{kind:'LINK', tradeId}` links to an existing planned trade after re-validating same account, same symbol and direction, not already linked; `{kind:'HOLD'}` stores the execution unlinked (ambiguous).
- `link_external_execution(p_trade_id, p_execution_id)` / `unlink_external_execution(p_trade_id, p_execution_id)` — authenticated; append-only.

TS (`src/domain/sync/`): `ExecutionSyncProvider` interface (`readOnly: true` capability, `fetchPositions(since)`), `normalizeExternalPosition` (zod; canonical decimals; rejects NaN/negative; symbol normalisation), `matchExecution(position, candidates)` → `{kind:'UNIQUE', tradeId} | {kind:'AMBIGUOUS', tradeIds} | {kind:'NONE'}` (candidates: same account, same symbol, same direction, planned trades LOCKED or LIVE without a link, locked before the external entry time, external entry within 30 minutes after lock and within `max(20 ticks, 25% of planned stop distance)` of the planned entry; exactly one → UNIQUE), `MockSyncProvider` (deterministic fixtures), `runSync(connection, provider, store)` orchestration. Ambiguous executions stay unlinked in an "Unmatched executions" list for user confirmation. A developer-only "Simulate sync" action exists when `TRADING_OS_ENABLE_MOCK_SYNC=true`.

Known V2 limits, documented with a proposed design in [V2_1_GAPS.md](V2_1_GAPS.md): a held or unlinked execution can only be linked to a planned trade (no import as a new trade, no dismissal), and `private.daily_usage` does not read platform executions, so the daily limits do not see executions that are held, unlinked or whose platform close was not recorded on the trade. This must be closed before `create_platform_connection` accepts any real provider. An imported trade gets a contract only when the account's latest version of the exact symbol fits the position's grid, so its risk basis may be unknown.

Settings → Connections UX per account: Manual (active), cTrader ("Read-only sync planned for V2.1"), MetaTrader 5 ("Bridge planned for V2.2"); states Connected / Syncing / Last synced {time} / Error {message} / Manual. Never claims connectivity that does not exist. Permission scope copy for the future cTrader connection: "Read-only: account, positions, deals, balances. Trading OS never requests trading permission."

---

## 9. Trading Accounts, context and aggregation (P1)

### 9.1 Concepts

- A **Trading Account** (`accounts` + latest `account_profiles` revision) is a broker/prop-firm/demo account. It is not the Trading OS login.
- **All Accounts** is an aggregation *context*, never a record. No table row, id or fake account represents it. Any code path that needs a concrete account (planning, recording, risk checks, AI budgets) must receive an explicit account id.

### 9.2 Context selection

- Cookie `tos_account` = `all` | `<uuid>` (httpOnly, SameSite=Lax, path `/`, 400 days, Secure on HTTPS). Query parameter `?account=all|<uuid>` overrides it for that request **and** is stored in the cookie, so drill-down links can switch context explicitly and the choice persists. The proxy stores it for a page load (a document navigation that is not a browser prefetch or prerender); Next.js removes its router headers before the proxy runs, so the router's fetches (client-side navigations and `<Link>` prefetches) are never stored there, and the shell stores the context of a client-side navigation after it happened, through the account action with the same ownership/active checks (`src/components/shell/context-sync.ts`). A prefetch therefore never switches the context; links that carry `?account=` are still not prefetched (the design system's table and chart links never prefetch them), so no page is rendered for an account the person may never open. The header shows the context of the page on screen in every tab, also after client-side navigations and after another tab changed the stored context.
- Server helper `getAccountContext()` (React `cache()`, in `src/lib/account-context.ts`) loads the user's accounts (RLS) with latest profiles and returns `{accounts, selected: {mode:'all'} | {mode:'account', account}, notice?}`. An unknown/foreign/archived id resolves to All Accounts with `notice:'ACCOUNT_UNAVAILABLE'` (shown once as "That trading account isn't available. Showing All Accounts.") — never a silent fallback to "the first account". When the stored cookie itself names such an account (archived on another device, or left by someone else's session), the context also carries `storedUnavailable`: the page renders All Accounts with the notice and the shell stores All Accounts once, so the notice does not return on every page (a failed store is not retried on the next render). For a router fetch the proxy renders with `?account=` without storing, it forwards the stored value in the header `x-tos-account-stored` (`all`, an id or `none`; a client-supplied value is dropped). A notice is shown only on the page it was rendered for (`src/components/shell/context-notice.tsx`), never again after a client-side navigation.
- Sign-out, password reset and account deletion remove both context cookies (`tos_account`, `tos_last_account`). A session can also end without them (signed out or reset on another device, revoked, expired), so every sign-in in a browser (the password sign-in, or a recovery link's code) keeps only `all` and the signed-in person's own account ids (`keepOwnAccountContext`, one RLS read per sign-in, none per request; when it fails, every id is dropped). The same person signing in again keeps their remembered context.
- In-app links to an active account's dashboard carry `?account=<id>` and are never prefetched (`accountDashboardHref`: the Accounts list and its row menu, Manage's back link, the trade header's account chip, the page after creating an account), so opening a dashboard makes it the context; archived accounts' links are plain. The dashboard's own Plan Trade / Record Live Trade carry the account too. An archived account's links on Review use the read-only `accountFilter` for the Journal and `/settings#ai` for AI settings (Settings → AI lists archived accounts from any context); where a settings change is what AI needs (off, limit reached), its fix link is "Restore in Manage" (`/accounts/<id>/manage`).
- The header selector shows the current context on every page: `Trading Account: All Accounts ▾` / `FTMO 100K ▾`; options grouped Active / Archived; a "Manage accounts" link.
- Read-only account filter `accountFilter=<account id>` (Journal and EDGE): narrows All Accounts to one account, archived ones included (they can never be the context), for history only. It combines with All Accounts only (dropped in an account context), only ever narrows a read (an id that is not one of the user's accounts matches nothing under RLS), and shows as a removable chip in words ("Account: Personal 12K · archived"), never as an id. The archived account dashboard's Journal and EDGE links use it.
- Plan Trade / Record Live Trade always show an explicit account field. Default: the selected account; in All Accounts, the most recently used active account (cookie `tos_last_account`), or the only active account. The form header repeats the account name and currency.

### 9.3 Aggregation methodology (All Accounts)

| Measure | Across accounts | Rule |
|---|---|---|
| Trade counts, win/loss/BE counts, win rate | yes | per-trade counts |
| Realized R (net R, expectancy, R curve, R drawdown) | yes, labelled | R is normalized by each trade's own initial risk, so per-trade R values are comparable across account sizes; label "R is per-trade risk units, not money". R drawdown is computed on the combined exit-ordered trade sequence. Trades without a known risk basis are excluded from R statistics with a visible count. |
| Money (P&L, fees, gross realized loss) | **only within one currency** | grouped by currency: "+$1,420.00 · +€380.00"; never converted (no FX) |
| Percent returns, balances, equity | **no** | shown per account only |
| Account contribution | per account | table of each account's trades, net R, net P&L (own currency), share of total R |

Sample-size protection (§13.8) applies to every aggregate.

### 9.4 Account metrics (deterministic, `src/domain/account-metrics.ts`)

Per account: currency; type/broker/platform; status; starting balance; **last recorded balance** and **last recorded equity** (user-reported, with date: "Equity · recorded Oct 16"); **realized P&L in Trading OS** (Σ net P&L of closed trades); **balance from trades** = starting balance + realized P&L (labelled "Starting balance + realized P&L recorded in Trading OS"; never called equity); today's P&L and this month's P&L (strategy-day/month of exit); cumulative R; max R drawdown; closed trade count; open (live) count; connection state ("Manual" in V2). Values not deterministically known are shown as "—" with a tooltip, never estimated.

Each account's live, closed and reviewed trades are read on their own (keyset pages of `trade_ledger`), up to `MAX_LEDGER_ROWS` (20,000); exactly 20,000 are added up in full. An account with more never gets a partial figure: every value computed from its trades (realized P&L, balance from trades, today and month P&L, cumulative R, max R drawdown, closed and live counts) is "—" with the reason, and so are the currency totals and the combined R that would include it. The Accounts page names such accounts in a notice ("Some results are not added up"); the dashboard shows "More trades than this page can add up" with links to EDGE and the Journal in place of results, charts, calendar and groups, and still lists live and recent trades. SQL totals for such accounts are V2.1 work ([V2_1_GAPS.md](V2_1_GAPS.md) §3).

---

## 10. Security, privacy, data rights

### 10.1 RLS and grants

Per §0.5 for every new table and view (`trade_ledger` is `security_invoker`). Tests assert, for every public table: RLS on, exactly one owner policy (plus documented exceptions), no INSERT/UPDATE/DELETE/TRUNCATE grant to `anon`/`authenticated`, the immutability trigger, and the TRUNCATE guard; and for every new function: `security definer`, empty search_path, no execute for `anon`/`public`, service-only functions not executable by `authenticated`.

Session cookies: every Supabase auth cookie the server writes (access and refresh token, PKCE code verifier) is HttpOnly, SameSite=Lax, path `/`, and Secure when the request came over HTTPS (`authCookieOptions` in `src/lib/cookie-security.ts`: the URL protocol in the proxy; the Origin header, else X-Forwarded-Proto, in server actions). No browser code creates a Supabase client or reads these cookies (a source scan in `tests/v2-proxy.test.ts`); `tests/v2-supabase-server-cookies.test.ts` pins the attributes through the real `@supabase/ssr`. The context cookies (§9.2) use the same rules.

### 10.2 Storage

`trade-evidence` bucket policies (§3.7). Uploads only via the trusted server after validation. Reads only via `/api/evidence/[id]` with the user's session (storage RLS applies a second time).

### 10.3 Service-role use (complete list)

Evidence upload/registration/cleanup and duplicate copies; AI ledger and AI start/authorize/finish RPCs (unchanged); connection ingest (mock, developer mode); the erasure purge (`purge_user_trading_data`, only after the server action re-authenticated the session user), erasure storage deletion and `auth.admin.deleteUser`. The secret key never reaches the client (existing `server-only` guards + the static source scan test).

### 10.4 Delete Trading OS account (`0019_account_erasure.sql` + server action)

Database:
- `create or replace function private.reject_mutation()` — DELETE is allowed only when the transaction-local setting `trading_os.erase_user_id` is non-empty and equals `to_jsonb(old)->>'user_id'`; UPDATE is never allowed; everything else raises the existing message. (`create or replace` keeps the OID, so all existing triggers pick it up.)
- `public.purge_user_trading_data(p_user_id uuid, p_confirm text) returns jsonb` (**`service_role` only**: execute revoked from `public`, `anon` and `authenticated`; no JWT check, because the database cannot tell a browser's own fresh sign-in from the re-authentication, so no access token of a user can call any purge function and only the trusted server erases): requires `p_confirm = 'ERASE ALL MY TRADING OS DATA'` (server constant sent only after the user typed `DELETE` and re-authenticated); errors `INVALID_INPUT`, `CONFIRMATION_REQUIRED`, `AI_REQUEST_IN_PROGRESS`, `PURGE_INCOMPLETE: <table>`; locks all the user's account rows; refuses with `'AI_REQUEST_IN_PROGRESS'` while any reservation of the user has no usage record and is younger than 30 minutes; collects storage paths (`setup_screenshots.storage_path`, `trade_evidence.storage_path`); sets the flag (`set_config(..., true)`); deletes every row with `user_id = uid` from every public table, in foreign-key dependency order **computed from the catalog** (children before parents; tables without `user_id`, such as `evaluator_versions`, are untouched), so future tables are covered automatically; clears the flag; verifies no public table still holds a row for `uid` (`'PURGE_INCOMPLETE: <table>'` → whole transaction rolls back); writes a de-identified receipt `private.erasure_receipts(id, erased_at, table_counts jsonb)` (no user id, no email); returns `{storagePaths:{legacy:[...], evidence:[...]}, deleted:{table:count}}`.
- Statement-level `BEFORE TRUNCATE` guard on every public table (TRUNCATE skips row triggers).
- `revoke insert, update, delete, truncate on all tables in schema public from service_role`, then re-grant the documented service inserts that the legacy server code still performs directly: `insert` on `setup_evaluation_passes` and `evaluator_versions`. V2 registers no legacy `setup_screenshots` row (that upload route was removed), so the service role keeps no insert on it.
- Grant hygiene under Supabase default privileges: `journal_analytics` → select only for authenticated; the V1 sequences (`setup_evaluation_events_id_seq`, `setup_risk_checks_id_seq`, `trade_events_sequence_seq`, `trade_tag_revisions_id_seq`) → no anon/authenticated privileges.
- Close V1 entry points that can create records outside the V2 trade model: revoke execute from `authenticated` on `lock_trade_plan`, `evaluate_trade_plan`, `import_locked_setup`, `create_risk_version`, `record_observation`, `record_setup_decision` (V2 wrappers call the underlying functions as their owner). `check_setup_risk` stays granted but is trade-aware since 0015 (locking only the latest revision of a DRAFT trade, linking the plan; a NULL `p_lock` is refused, and the deferred `plan_requires_trade` check of §2.1 rolls back any lock without a trade). `remove_setup_screenshot`, `save_daily_context`, `bootstrap_demo_account`, `save_setup_proposal`, `open/close_journal_trade`, `set_journal_disposition`, `tag_journal_trade`, `append_plan_note`, AI preference RPCs stay granted (no V2 invariant depends on blocking them).

Server action `deleteTradingOsAccount` (Settings → Danger zone):
1. `requireUser(true)`; the user typed `DELETE` exactly and re-entered the password; re-authenticate with a non-persisting client (`createClient(url, publishableKey, {auth:{persistSession:false}}).auth.signInWithPassword`) for the session user's email. The verified user must be the session user, and that verifier session is signed out again before anything is deleted: it only proves the password.
2. `purge_user_trading_data(session user id, constant)` (one atomic transaction) called through the **trusted server** (secret key, `trustedServer()`), the only caller that can execute it, so the typed DELETE and the password re-entry cannot be skipped by calling an RPC directly. 0019 also creates lookup indexes for every foreign key into a tenant table that lacked one (catalog-driven; a test fails if a future foreign key lacks an index), keeping the purge fast.
3. Trusted server deletes the returned storage paths in both buckets, then sweeps the `{uid}/` prefix in both buckets until empty.
4. `signOut({scope:'global'})`, `auth.admin.deleteUser(uid)`, clear the auth cookies and both context cookies (`tos_account`, `tos_last_account`), `redirect('/login?reason=account_deleted')`.
5. Any failure → "Deletion did not finish. Nothing was shared, and you can safely try again: completed steps are skipped." Every step is idempotent, so retrying converges. Operational log uses fixed event names only.

UI copy lists exactly what is deleted (trading accounts, trades, plans, journal, screenshots, reviews, AI history and usage records, settings, login) and states it cannot be undone; suggests "Export my data" first. Never test against a real account.

### 10.5 Export my data

`GET /api/export?part=<core|trades|ai|evidence-manifest|trades-csv>` (authenticated, same-origin not required for GET, `private, no-store`, `attachment`), each part read with the **user's session** (RLS) using keyset pagination; numerics as exact strings. Parts:
- `core`: profile (id, email), accounts + profiles, strategy versions (`written_rules` included), risk plan versions, instrument versions, observations, external losses (+ removals), configuration events, daily contexts.
- `trades`: trades, revisions, proposals, risk evaluations, plans, executions, outcomes, dispositions, position facts, unplanned closes, journal entries, lifecycle events, tags (V1 + V2), V1 trade events, human decisions, setup risk checks, locks, external executions and links.
- `ai`: all AI request/result tables, preferences, reservations, dispatches, usage records, resolutions (technical by nature, kept separate).
- `evidence-manifest`: every legacy screenshot and V2 evidence item (id, trade, label/role, timeframe, caption, filename, mime, size, dimensions, sha256, recorded time, timing band, removed time, download URL path). The timing band is computed exactly as the trade page computes it, including the end of a plan that ended without an entry (`planEndedAt` from the ledger's end columns, dispositions and the V1 decisions of skipped trades, read with the user's session), so a screenshot added after a skip is After close in both. Large accounts page it per table (`&table=trade_evidence|setup_screenshots`; each page carries the `manifest` items for exactly its rows, ≤ 3 MB per page).
- `trades-csv`: one row per trade from `trade_ledger` (formula-injection guarded like `tradeCsv`).
Settings → Data offers "Download my data (.zip)": the browser fetches the parts (and, if "Include screenshots" is ticked, each image through the authenticated evidence routes), builds a ZIP locally (store method, CRC32; `src/lib/zip.ts`), and verifies image sha256 against the manifest. This avoids server response-size limits and keeps all reads RLS-scoped. Export is clearly separate from deletion.

---

## 11. AI in V2 (advisory)

### 11.1 Presentation (all operations, P0)

- **Concise card** per result, designed for a 10–20 second read, built by pure summarizers (`src/domain/ai-summary.ts`) over the existing output shapes: first sentence (≤ 220 chars, word-boundary ellipsis) of the headline field, then at most 2 items per section. Section mapping:
  - Analyze Setup: "Setup" = `setupStructure`; "Strengths" = `confluences`; "Weaknesses" = `weaknesses`; "Invalidation" = `invalidation`; "AI observation" = `observations[0]`; "Evidence" = `evidenceStatus` in words.
  - Challenge My Bias: "Why your thesis might be wrong" = `counterArgument`; "Invalidation"; "Missing evidence" = `missingEvidence`; "Questions to answer" = `questions`.
  - Review Trade (V1): six dimension chips (Aligned / Deviation / Insufficient evidence) + "Lessons" (≤ 2). The trade's review card shows the newest completed review in its own format (timeline or V1); V2 starts no new V1 reviews.
  - Review Trade (timeline, §11.4): headline, thesis check, execution vs plan, live management, key lesson.
  - Weekly / Recent / Monthly: summary headline; "Went well" (≤ 2), "Needs attention" (≤ 2), "Focus next" (≤ 2); deterministic facts (sample size, net R) come from Trading OS, never from the AI.
- The deterministic **Risk Engine** status line always leads pre-trade cards ("Risk Engine · Blocked — Requested risk exceeds maximum"), visually separate from "AI interpretation · advisory".
- **View full analysis** opens a side sheet with every section and all citations.
- **Friendly source chips** (`resolveSourceChip(sourceId, facts, manifest, evidenceIndex)`): `proposal`/`originalPlan` → "Trade plan"; `currentThesis` → "Your thesis"; `strategy` → "Strategy ICT V1.0"; `deterministic` → "Risk Engine"; `riskVersion` → "Risk Plan V1.n"; `execution` → "Execution"; `tags` → "Your tags"; `evidence:<id>` → "{timeframe or label} chart" (e.g. "M5 chart", "Entry screenshot") opening the viewer; `event:<id>`/journal ids → "Live note · 09:45" / "Journal note" (scrolls to the timeline item); `trade:<id>` → "EURUSD long · Oct 14" (links to the trade); `period` → "Week of Oct 6"; `sample` → "Sample · 12 trades"; `edge` → "EDGE metrics"; `models` → "By model"; `sessions` → "By session"; `strategy:<id>`/`risk:<id>` → version names. Unknown or legacy ids fall back to a neutral "Source" chip; the raw id is visible only in Technical details. On periodic reviews a journal or event chip names its trade ("GBPUSD short · Sep 7 · Live note · 05:11") and opens that trade's timeline item, `/trades/<trade>#journal:<id>`; the trade page scrolls to and focuses `#journal:<uuid>` and `#event:<uuid>` items on a full load and on a client-side navigation (`src/components/trade/reveal.ts`). Older reviews with V1 facts know only the plan, so their chips open `/journal/<plan>#event:<id>`, which redirects to the trade (the item is revealed on a full page load; a client-side navigation opens the trade at the top). A V1 entry, close or plan-lock event opens the trade without an anchor, and a record that is not in the facts gets a chip without a link. V1 decision events read as the timeline titles them ("Decision: Skipped", "Taken despite a block").
- **AI history** per trade/review page: compact rows `Analyze Setup · Completed · 08:00` (+ top finding); every completed row opens "View full analysis" (the same sheet as the card, with the stored verdict, plan status or sample and net R); `Failed · {human reason}` rows show the accounting outcome in plain words, as the budget applies it: held until an accounting review, the outcome of that review once it settled (`ai_uncertainty_resolutions`: "Reviewed: the AI provider recorded no usage for this attempt, so nothing was charged and the held amount was released.", or the confirmed cost), or, for a hold without a usage record, that it counts toward its own month's budget until the monthly reset releases it; technical fields (error code, operation/contract version, provider/model, reservation, tokens, response id, facts JSON, the accounting review beside the original record) live in a collapsed "Technical details" element (kept in server HTML so existing UI tests still find them).
- **Stale revision marker**: "Based on draft revision 2 · current revision is 3" whenever a pre-trade analysis's proposal is not the latest revision; never presented as current.
- Live-first trades: no pre-trade AI tools; trade review facts state `planStatus: NO_PLAN_RECORDED`.
- **Pre-trade results after the draft**: once a planned trade is no longer an open draft (locked, live, closed, reviewed, skipped, cancelled or discarded) and has Analyze Setup or Challenge My Bias requests, a read-only "Pre-trade AI" section follows the Plan (before Execution): no buttons, a line saying why (locked, or no longer a draft), the latest card of each tool and their history. Each card is led by the Risk Engine verdict stored with its request, never today's verdict. A draft of an archived account keeps its analyses read-only inside the Plan. Trades without analyses show nothing.

### 11.2 Budget UX (P1)

- `AiBudgetSummary`: "AI usage this month · €0.74 of €5.00 · €4.26 left · resets Nov 1" + one status chip (On / Off / Limit reached / Paused — needs review / Unavailable). Per account (budgets are per trading account, unchanged). In All Accounts: one compact row per account.
- Every paid button shows an estimate: "≈ €0.02" (typical) with a tooltip "Typical cost based on measured runs; at most €0.06 is reserved and unused funds are released." `estimateAiCost(operation)` = `{typicalMicros, maxMicros}`: typical from a documented constant table of measured staging runs (REVIEW_TRADE 16,000 µ€; CHALLENGE_BIAS 15,800; ANALYZE_SETUP 18,500; WEEKLY 21,300; RECENT 28,900; MONTHLY 34,400; REVIEW_TRADE_TIMELINE uses REVIEW_TRADE's figure until measured), max = `reservationMicros(operationPricing(op), op)`.
- Detailed accounting (held amounts, dispositions, uncertainty, audit log, provider/model, multipliers) moves to Settings → AI → "Details".
- An archived account can still run AI when it is on, but its AI settings change only after it is restored: for Off and Limit reached the reason says so ("…It is archived, so restore it in Manage account first, then turn AI on in Settings → AI.") and the fix link is "Restore in Manage" (§9.2).

### 11.3 AI on trade evidence (`0018_trade_ai_timeline.sql`, part 1)

- `create or replace public.start_bias_challenge(...)`: unchanged signature; additionally, when the proposal belongs to a V2 trade (`trade_revisions`), the trade must be `PLANNED`, not discarded, have no plan link, and the proposal must be its **latest revision** (`'NOT_LATEST_REVISION'`).
- `create or replace public.authorize_bias_challenge(...)`: each `selectedEvidence` id must be either a non-removed legacy `setup_screenshots` row of the same proposal (unchanged) **or** a non-removed `trade_evidence` row of the same trade, registered before the request was created, with matching sha256. (Pre-lock tools only ever see pre-entry evidence because a trade without a plan link has no execution.)
- TS libs (`analyze-setup.ts`, `bias-challenge.ts`, loaders) accept V2 evidence: bytes downloaded from `trade-evidence` with the user session, length/sha256 verified; `selectedEvidence[].role` = timeframe when set, else the label; facts versions bump only if the existing schema rejects the value (then: new facts/contract versions, old ones still parse history).

### 11.4 Timeline-aware trade review (`0018_trade_ai_timeline.sql`, part 2; deliverable §22)

- Registry operation `REVIEW_TRADE_TIMELINE` (mini model, mini pricing profile, `version 'REVIEW_TRADE_TIMELINE_MINI_V1'`, `contract 'REVIEW_TRADE_TIMELINE_V1'`, max 4 images, `maxInputTokens 24000`, `maxOutputTokens 4000`, `tools []`, frozen). REVIEW_TRADE V1 remains for history (V2 has no entry point that starts a V1 review; stored V1 results still render).
- Tables `trade_timeline_reviews` (keyed by `trades.id`, any origin; `operation->>'id' = 'REVIEW_TRADE_TIMELINE'`) and `trade_timeline_review_results`, mirroring 0009 (RLS, revokes, triggers). Service-only `start_`, `authorize_`, `finish_trade_timeline_review` with: owned trade; trade closed (planned outcome or unplanned close); one in-flight per trade; evidence belongs to the trade (V2 or legacy via revisions), not removed, sha256 match; COMPLETED requires SETTLED usage.
- Facts `REVIEW_TRADE_TIMELINE_FACTS_V1`: `{version, tradeId, capturedAt, origin, planStatus: 'LOCKED_PLAN' | 'NO_PLAN_RECORDED', plan (null without a locked plan), strategy {version, rules} (no written prompt), riskVersion|null, deterministic|null, execution {entryAt, entryRecordedAt, entryPrice, quantity, plannedQuantity, oversize, exitAt, exitPrice, fees, netPnl, currency, realizedR|null, riskBasisSource, outcome}, timeline [{sourceId, kind, timing: BEFORE_ENTRY|WHILE_LIVE|AFTER_CLOSE, recordedAt, occurredAt|null, flags[], text, details}], evidence [{id, label, timeframe, timing, recordedAt, sha256, mimeType, bytes}], tags, sourceManifest, sourceRefs}`; timing from `classifyTiming` (§5.3); manifest kinds include `TIMELINE` entries with their timing. `PLAN_LOCKED` and the plan's own evaluation (`trade_plans.risk_evaluation_id`) are always `BEFORE_ENTRY` without flags (§5.4). V1 human decisions of the trade are timeline items of kind `HUMAN_DECISION` (Taken / Skipped, with the trader's reason) or `MANUAL_OVERRIDE` (taken despite a block), cited as `event:<id>`; the V1 AI verdict stored with a decision is left out as earlier AI output.
- Output `REVIEW_TRADE_TIMELINE_V1` (strict): `headline {text ≤ 240, sourceRefs 1..4}`; `thesisCheck {assessment: CONSISTENT | CHANGED | NOT_RECORDED | INSUFFICIENT_EVIDENCE, text ≤ 600, sourceRefs}`; `executionVsPlan {assessment: ALIGNED | DEVIATION | NO_PLAN | INSUFFICIENT_EVIDENCE, text ≤ 600, sourceRefs}`; `liveManagement {assessment: DISCIPLINED | REACTIVE | NO_LIVE_RECORDS | INSUFFICIENT_EVIDENCE, text ≤ 600, sourceRefs}`; `patterns [0..3] {text ≤ 300, sourceRefs}`; `keyLesson {text ≤ 300, sourceRefs}`; `limitations string[0..3] (≤ 200)`.
- Server validation (deterministic hindsight guard): `thesisCheck.sourceRefs` may cite only plan/strategy/riskVersion/deterministic sources and BEFORE_ENTRY timeline/evidence ids; `planStatus NO_PLAN_RECORDED` forces `thesisCheck.assessment ∈ {NOT_RECORDED, INSUFFICIENT_EVIDENCE}` and `executionVsPlan.assessment = NO_PLAN`; every sourceRef ∈ manifest; directive regex (`/(take|enter|execute) (the|this) trade/i`) rejected; failures persist FAILED with raw output (charged usage still accounted).
- Prompt rules: separate Trading OS facts from interpretation; never invent motives, timestamps or causality; treat AFTER_CLOSE text as hindsight explanation, never as pre-entry evidence; patterns only when supported by recorded items (examples: invalidation recognized but ignored; target changed without new recorded evidence; entry earlier than the stated setup; intervention-heavy management).

### 11.5 Periodic reviews

Output contracts unchanged; pages move to `/review/*`. Scope is explicit on every card: "FTMO 100K · Week of Oct 6–12 (UTC−5) · 8 trades". All Accounts context: choose an account per review (AI scope stays per account because budgets, consent and SQL scope recomputation are per account). Visible limitation: "Live-first and imported trades are not yet included in periodic AI reviews."; the review page counts the live-first and imported trades of the period or sample as "not included", and the SQL start functions check the exact sample against `trade_plans` / `trade_outcomes`.

New requests send compact V2 facts (`WEEKLY_REVIEW_FACTS_V2`, `RECENT_TRADES_FACTS_V2`, `MONTHLY_REVIEW_FACTS_V2`, `src/ai/periodic-facts.ts`); 0018 Part 3 lets the SQL start functions accept them beside the V1 facts, which stored history keeps:
- no written strategy (the rules object only), no stored manifest or `sourceRefs` list: the allowed source ids are enumerated once, in the response schema's citation enum, with one shared observation definition (`<OP>_CITATIONS_V3`);
- journal entries as rows `[id, kind, recordedAt, timing, text, extra]`, with the timing Trading OS computed (§5.3), so after-close text never poses as pre-entry evidence;
- UTC instants to the minute (`2026-10-27T08:32Z`; every timing label and flag is computed from the exact time first), decimals without trailing zeros, empty lists left out, and values every trade would repeat stated once (a plan's usual flags, report version 1.2, the strategy or risk version when the snapshot has only one); long texts are shortened explicitly (`textShortened`), never silently, and no record is left out.

Bounds (`src/ai/periodic-limits.ts`): a weekly review reads at most 20 trades and 70 records (journal entries and events), Recent Trades 10, 20 or 30 trades with at most 150, 120 and 120 records, a month at most 120 trades. Whether a sample within them fits is decided by the conservative pre-flight estimate of the whole request (`src/ai/request-estimate.ts`) before anything is written or reserved: a sample that does not fit is refused with its review's copy (Recent Trades names the largest smaller sample that fits, "…but the last 20 fit: choose 20 trades. Nothing was sent and no record was left out.", as does its refusal of a sample above its record bound), and a month that does not fit in detail (at most 30 trades and 90 records) is sent as its explicit deterministic summary, which uses only the counts of records, never their content. With typical journaling the last 30 trades fit (the seeded traders' 80–95 records estimate 28.8k–30.1k of the 32k tokens).

A review of the same period (or, for Recent Trades, any sample of the account) that is still running makes the run button wait with the reason ("A review of the week of Oct 26–Nov 1 is still running. Its result will appear in the history."); a request that meets one anyway gets `IN_PROGRESS` with that copy, sends nothing and logs no failure. Rows past their deadline no longer hold the button. A monthly review's "What improved" and "What degraded" carry the caveat "Change requires comparable earlier and later evidence. Record completeness alone does not establish improvement or degradation." in the summarizer (`CHANGE_EVIDENCE_NOTE`, `src/domain/ai-summary.ts`), and the full-analysis sheet renders a section's note; the history and card conversions (`resolveCardSources` in `src/lib/ai-history.ts`, `sectionModels` in `src/components/ai/model.ts`) do not pass the note on yet, so the app does not show it.

### 11.6 Legacy setup evaluator

The Astra NORMAL/DEEP evaluator (pricing profile valid until 2026-10-22) is not offered in V2. Its history stays readable under Technical details on trades that have it. Since that profile expired, the gate refuses the evaluator before any provider call; `POST /api/setups/[id]/analyze` remains for compatibility (§1.2).

### 11.7 Request gate and pricing

Every paid request goes through `budgetedAiRequest` (`src/ai/request-gate.ts`; outcome table in [AI_BUDGET_REVIEW.md](AI_BUDGET_REVIEW.md)). Before anything is reserved, the whole request is estimated locally and refused (`INPUT_LIMIT_EXCEEDED`) when it is above the operation's input limit. A reservation is released at zero cost only when no provider request of any kind was issued (a failed reserve or dispatch, or an adapter failure before its first request; the provider reports every request, the input count included, through `beforeContact`); a dispatched one is released with `{"generation":"NOT_SENT"}`, which SQL refuses once the pre-generation recheck recorded the generation commit (`ai_request_generations`, 0018 Part 4). Every failure after contact without usable usage, the count failures included, keeps the full reservation held as UNCERTAIN, as in V1 ([AI_ACCOUNTING_RESOLUTION.md](AI_ACCOUNTING_RESOLUTION.md)). The mini operations' pricing profile `GPT_5_4_MINI_EUR_2026_10_13` is valid until 2026-11-12 00:00 UTC; from then on every AI request is refused until the pricing is reviewed.

---

## 12. Code map (V2)

### 12.1 Domain (pure, no I/O, fully unit-tested)

| Module | Exports (normative names) |
|---|---|
| `src/domain/format.ts` | `stripZeros`, `formatDecimal`, `formatPrice(value, tickSize)`, `formatQuantity`, `formatPercent`, `formatMoney(value, currency)`, `formatSignedMoney`, `formatR`, `formatAgainst(value, threshold, rule:'min'|'max', passes:boolean)`, `scaleOf` |
| `src/domain/time-display.ts` | `TimeDisplay = {mode:'strategy'|'utc'|'local', zone?}`, `formatTime`, `formatDateTime`, `formatDay`, `formatRelative`, `strategyDayLabel` (fixed UTC−5 via offset arithmetic; local via `Intl` with the browser zone captured in cookie `tos_tz`) |
| `src/domain/risk.ts` | `evaluateRisk` (engine 1.1/report 1.2 parity with SQL), `RiskContext` (adds `usage`, `limits`, `instrument` fields), `proposalSchema` (unchanged 11 keys) |
| `src/domain/risk-report.ts` | `riskReportSchemaV12`, `riskReportSchema` (1.1), `legacyRiskSchema`, `storedRiskSchema` (union), `isRiskReportCurrent(report, context, observationId, now)` |
| `src/domain/risk-explain.ts` | `explainIssue`, `explainReport → {decision, blocking[], warnings[], notes[]}`, `RISK_COPY` |
| `src/domain/daily-status.ts` | `dailyStatusV2(ctx, usage) → {allowed, headline, tone, reasons:[{code, severity, message, action?}]}` (each BLOCK reason ⇒ the engine blocks a valid proposal; invariant test) |
| `src/domain/trade-state.ts` | `deriveTradeState(row, {now, checkCurrent}) → {lifecycle, draftCheck, label, tone, step, origin, nextAction, secondaryActions, editable}` |
| `src/domain/timeline.ts` | `classifyTiming`, `buildTimeline(inputs) → TimelineItem[]`, `groupByTiming` |
| `src/domain/ledger.ts` | `ledgerRow` (zod for `trade_ledger`), `LedgerTrade` |
| `src/domain/performance.ts` | `rMetrics(trades)` (identical math to V1 `metrics`), `moneyByCurrency`, `equityCurveR`, `drawdownSeries`, `dailySeries`, `calendarMonth(trades, month, mode)`, `distributionR`, `breakdown(trades, key)`, `accountContribution`, `sampleLabel` (V1 bands), `sampleCaveat` |
| `src/domain/account-metrics.ts` | §9.4 |
| `src/domain/plan-vs-reality.ts` | slippage (ticks/pips), size ratio, oversize, actual risk at stop, realized vs planned R |
| `src/domain/close-preview.ts` | the close result before it is recorded (outcome, net P&L, realized R), with the formulas of `close_planned_trade` / `close_live_trade` (§8.1) |
| `src/domain/partial-closes.ts` | partial closes journaled while live, `closeLegs` (split of the remaining position or the reason to ask for the average), the tick-rounded average exit (§3.6) |
| `src/domain/ai-summary.ts` | per-operation summarizers, `firstSentence`, `resolveSourceChip`, `estimateAiCost` |
| `src/domain/sync/*` | §8.6 |
| `src/domain/strategy-card.ts` | `strategyCard(rules, riskPlan) → readable sections` (models, sessions, minimum RR, policies) |

V1 modules `analytics.ts`, `session.ts`, `strategy.ts`, `ux.ts` stay (session/strategy untouched; `ux.ts` keeps functions still used, deprecated helpers removed only together with their tests' replacements).

### 12.2 Server data and actions

- `src/lib/account-context.ts`, `src/lib/workspace.ts` (risk context per account incl. `get_daily_risk_usage`), `src/lib/trades-data.ts` (ledger list/filters/search/pagination, trade detail with every timeline source, evidence index), `src/lib/today-data.ts` (rewritten), `src/lib/accounts-data.ts`, `src/lib/performance-data.ts` (keyset-load ledger rows for EDGE/calendar/account dashboards), `src/lib/evidence.ts` (storage helpers, thumbnail), `src/lib/export.ts`, `src/lib/erasure.ts`, `src/lib/sync-service.ts`, `src/lib/schema-gate.ts`.
- Server actions (`"use server"`, zod-validated, `{error?, success?, ...}` results, `unstable_rethrow` first, `revalidatePath`/`refresh()`): `src/app/actions/trades.ts`, `accounts.ts`, `journal.ts`, `context.ts` (set account context, theme, time display, developer mode), `settings.ts` (AI preferences reuse existing actions), `erasure.ts`.
- Route handlers per §1.2.
- **Server action convention (all V2 actions):** `export async function name(prev: ActionState<T>, form: FormData): Promise<ActionState<T>>`, usable with React `useActionState` and plain `<form action>`; client components may also build a `FormData` and call the action directly. Shared types in `src/app/actions/state.ts`: `type ActionState<T = undefined> = { status: 'idle' } | { status: 'success'; message?: string; data?: T } | { status: 'error'; message: string; fieldErrors?: Record<string, string> }` and `const idleState`. Structured inputs travel as JSON strings in a single form field (e.g. `details`). Contracts used by shared components:
  - `addJournalEntry` (`src/app/actions/journal.ts`): fields `tradeId`, `kind` (`NOTE|DECISION|STOP_CHANGE|TARGET_CHANGE|PARTIAL_CLOSE|LESSON`), `body?`, `details?` (JSON object), `requestKey` → `data: { id: string }`. The database's `ENTRY_NOT_LIVE` refusal (§3.6) becomes "Stop, target and partial-close entries can only be recorded while the trade is live." and is not logged as a failure.
  - `completeReview` (`src/app/actions/trades.ts`): `tradeId`, `requestKey?`, `saveTags?` plus the `setTags` fields (the tags form's unsaved changes). With `saveTags` the tags are saved first and the trade is marked reviewed only after that ("Tags saved and marked reviewed."); if the tags cannot be saved nothing is marked, and if the review then fails the message is "Tags saved, but the trade wasn't marked reviewed. …". A retry does not create a second tag set.
  - `relabelEvidence` (`src/app/actions/trades.ts`): `evidenceId`, `label`, `timeframe?`, `caption?` → no data.
  - `removeEvidence` (`src/app/actions/trades.ts`): `evidenceId`, `kind` (`V2|LEGACY`) → no data.
  Existing V2 actions (`ai.ts`, `connections.ts`, `erasure.ts`) already follow this shape with their own state types; new code uses `ActionState`.

### 12.3 Components

`src/components/ui/*` (primitives), `src/components/shell/*`, `src/components/charts/*`, `src/components/trade/*`, `src/components/evidence/*`, `src/components/today/*`, `src/components/journal/*`, `src/components/edge/*`, `src/components/accounts/*`, `src/components/ai/*`, `src/components/settings/*`. V1 components are deleted once unused (their tests are replaced by V2 equivalents with equal or stronger assertions; documented in the final report).

---

## 13. Design system

Calm, professional, dense-but-readable financial software. Not a neon terminal. Semantic colour is reserved for meaning (profit/loss, blocked, warning, live); the accent is for interaction only. State is never colour-only: every state also has a word and/or icon.

### 13.1 Tokens (`src/app/globals.css`, CSS custom properties; light default, dark via `[data-theme="dark"]` or `prefers-color-scheme: dark` when no explicit light choice)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f5f6f8` | `#0d1015` | page |
| `--surface` | `#ffffff` | `#141821` | cards |
| `--surface-raised` | `#ffffff` | `#1a1f2a` | menus, dialogs |
| `--surface-sunken` | `#f0f2f5` | `#0f1218` | inputs, insets |
| `--border` / `--border-strong` | `#e3e6eb` / `#cfd4dc` | `#252b36` / `#343c4a` | hairlines |
| `--text` / `--text-2` / `--text-3` | `#111827` / `#4b5563` / `#6b7280` | `#e7ebf1` / `#aab3c0` / `#7e8896` | ink |
| `--accent` / `--accent-hover` / `--accent-soft` | `#2f5bea` / `#2549c8` / `#eaf0ff` | `#6d93ff` / `#86a6ff` / `#1b2440` | interaction, focus |
| `--pos-text` / `--pos-soft` | `#0a6a37` / `#e7f5ed` | `#4cc483` / `#11261b` | profit text, approved |
| `--neg-text` / `--neg-soft` / `--neg-border` | `#b42318` / `#fdecea` / `#f4b4ab` | `#f08a72` / `#2c1512` / `#6b2a1e` | loss text, **blocked** |
| `--warn-text` / `--warn-soft` / `--warn-border` | `#a15c07` / `#fff6e0` / `#f5c26b` | `#f0b049` / `#2a2110` / `#6b5216` | warnings |
| `--live` | `#2f5bea` | `#6d93ff` | live dot (pulse, reduced-motion aware) |
| chart profit / loss (marks only) | `#0b6334` / `#e4694c` | `#2ea866` / `#b4432c` | validated with the dataviz validator (CVD ΔE ≥ 11 light/dark, contrast ≥ 3:1) |
| chart series 1..3 (categorical) | `#2a78d6`, `#eb6834`, `#1baf7a` | `#3987e5`, `#d95926`, `#199e70` | account/series identity, max 3 all-pairs |
| chart grid / axis | `#e1e0d9` / `#c3c2b7` | `#2c2c2a` / `#383835` | hairlines |
| `--color-on-scrim` (`text-on-scrim`) | `#ffffff` | `#ffffff` | text on the fixed dark scrim laid over a screenshot (the Journal's "+N more" badge); the scrim is the same in both themes, so its text is too. The default Tailwind palette is cleared (`--color-*: initial`), so `text-white` does not exist |

Profit/loss values in text always carry a sign (`+$480.00`, `−1.00R`) and use `--pos-text`/`--neg-text` (WCAG AA ≥ 4.5:1). Chart marks use the chart colours plus position (above/below zero) as the secondary channel.

Typography: system UI stack (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`); monospace only inside Technical details. Base 14px desktop / 15px mobile, line-height 1.5; scale 12 · 13 · 14 · 16 · 18 · 20 · 24 · 30. `font-variant-numeric: tabular-nums` in tables, axes and aligned columns; proportional figures for hero values. Spacing 4px grid (4–48). Radii 6 (controls), 10 (cards), 999 (pills). Elevation: hairline borders first, one soft shadow for raised layers.

CSS architecture: `@import "tailwindcss";` with tokens exposed via `@theme inline` so utilities like `bg-surface text-2` work; component classes in `@layer components`; no unlayered element selectors that beat utilities. V1 CSS is removed when its last consumer is gone.

### 13.2 Primitives (`src/components/ui`)

Button (`primary | secondary | ghost | danger | link`, `sm | md | lg`, `loading`, icon slot), IconButton, Badge/StatusPill (tones: neutral, positive, negative, warning, info, live, muted), Card (+Header/Title/Body/Footer), Stat (label, value, delta, hint), Callout (tone, icon, title, body, action), Tabs and SegmentedControl, Dialog / Sheet / ConfirmDialog, DropdownMenu, Popover, Tooltip (Radix from the installed `radix-ui` package), Field (label, hint, error with `aria-describedby`, required marker), Input, DecimalInput (string-preserving, inputmode decimal), Textarea (autosize), Select, Checkbox, Switch, RadioCards, Toast (aria-live, stacked), EmptyState, Skeleton, Table (+ responsive card mode), Disclosure, TechnicalDetails, Kbd, Stepper, Pagination, FilterChips, Avatar-less user menu.

### 13.3 Shell (`src/app/(app)/layout.tsx` + `src/components/shell`)

- Desktop ≥ 1024px: left sidebar (232px; collapsible to 64px icon rail) with brand, nav, and a footer menu (theme, time display, settings, sign out). Top bar: Trading Account selector · strategy clock ("09:42 UTC−5 · Active kill zone", live, next boundary in tooltip) · Search ⌘K · `+ Plan Trade` (primary) · `+ Record Live Trade` (secondary).
- Tablet 768–1023px: icon rail + top bar.
- Mobile < 768px: compact top bar (brand mark, account selector, search icon) + bottom tab bar (`Today · Journal · + · Accounts · More`) with safe-area insets; `+` opens the action sheet. The sticky top bar (`.app-topbar`, z-index 40, level with the tab bar) stays above every sticky layer inside a page (z-index 30 at most, such as the docked journal composer) and below overlays (50 and up).
- The layout loads the schema gate, user, accounts/context and a light palette index (accounts, live trades, last 50 trades) once per request.

### 13.4 Command palette and keyboard

`⌘K`/`Ctrl+K` (and `/`) opens the palette: actions (Plan Trade, Record Live Trade, Add external loss, Update account values), navigation (Today, Journal, EDGE, Accounts, Review, Weekly/Monthly review, Settings), Trading Accounts (switch context), live trades (open), recent trades (fuzzy match on instrument, account, date, tags), tags (open Journal filtered). Arrow keys + Enter; Esc closes; recent items first.
Global single-key shortcuts (ignored while typing in a field): `P` Plan Trade, `L` Record Live Trade, `J` focus the journal composer on a trade page, `?` shortcut help. `Ctrl/⌘+Enter` submits the composer/forms (on Close trade, and on Record entry when it differs from the plan, Enter and `Ctrl/⌘+Enter` open the confirmation instead of recording, §8.1, §8.5); `Ctrl/⌘+V` pastes screenshots (§7.1); `←/→/Esc` in the evidence viewer. No other shortcuts.

### 13.5 Accessibility

WCAG 2.2 AA contrast; visible 2px focus ring (`--accent`); skip link; landmarks; one `h1` per page; `aria-live="polite"` for async results and toasts; errors focused and linked with `aria-describedby`; dialogs trap focus and restore it; every chart has a table view and a text summary; hit targets ≥ 40px (≥ 44px on touch); `prefers-reduced-motion` disables pulses/transitions; no information by colour alone.

### 13.6 Charts (`src/components/charts`)

Hand-written SVG (no chart dependency), server-rendered geometry with a small client tooltip layer. Every chart answers a named trading question (in its subtitle), shows its sample size, has a "Table" toggle, a crosshair (line/area) or per-mark tooltip (bars/cells), hairline grid, 2px lines, ≤ 24px bars with 4px rounded data-ends, 2px surface gaps, direct labels only on endpoints/extremes, one y-axis (never dual-axis). Click on a point/bar/cell drills down (link to the filtered Journal or day/trade). Charts:
- Cumulative R (line + 10% area wash) — "Is the process compounding?"
- R drawdown (area below zero) — "Where am I giving profits back?"
- Daily net R / net P&L (diverging bars) — "Which days drive results?"
- Calendar heatmap (month; modes Net R, Net P&L per currency, Gross realized loss, Trade count) — "When am I winning or losing?"
- R distribution (histogram, 0.5R bins) — "How are outcomes distributed?"
- Breakdown bars (model, session, weekday, origin, account, risk %, strategy/risk version) — "Which conditions perform?"
- Account contribution (horizontal bars, share of net R) — "Which account contributes most?"
- Balance from trades (line per account, own currency) — account dashboard only.

### 13.7 Empty, loading and error states

Every list/chart has an intentional empty state that explains what will appear and the next action ("No closed trades yet. Record or plan a trade; results appear here after you close it."). Loading uses skeletons shaped like the content; refetch keeps the previous render dimmed. Route-level `error.tsx` renders inside the shell with a retry and a link to Today. `not-found.tsx` exists.

### 13.8 Small-sample protection

Use the V1 bands (`NO DATA`, `<10 VERY SMALL`, `<30 SMALL`, `<100 DEVELOPING`, `LARGER`) rendered in words: "3 completed trades — early sample; more data is needed before drawing conclusions." Win rate, profit factor and expectancy are visually de-emphasized (muted, "early" tag) below 10 trades; comparisons between groups show each group's N and never declare a winner below 30 per group ("Emerging tendency" at 10–29, "Insufficient evidence" below 10).

### 13.9 Technical details and Developer mode

`TechnicalDetails` is a collapsed disclosure at the bottom of a section: ids, versions, raw reports, manifests, hashes, provider/model, token usage, reservation ids, rule codes. Settings → Developer → "Show technical details expanded" (cookie `tos_dev=1`) opens them by default. Nothing technical is required to complete a core workflow.

### 13.10 Schema gate

If `trading_os_schema()` is missing or older than `2.0`, every app page renders "Database update required — this deployment expects Trading OS database version 2.0. No changes were made." and no server action may write (actions check the gate too). This protects any preview pointed at an un-migrated database.

---

## 14. Screens

### 14.1 Today

Answers within seconds: active session, can I trade, slots left, risk left, today's realized result, today's realized losses, selected account, live trades, today's trades.
- **Header**: date (strategy day) and session ribbon (current session highlighted, next boundary, Dead Pool shaded) — exact via `nextBoundary` helper added to `session.ts` (pure addition, parity-tested against `strategyClock`).
- **Trading status card** (per account in context; All Accounts shows one compact row per active account): headline "You can trade" / "Trading blocked: Dead Pool until 18:00" / "Daily trade limit reached"; reasons (structured, BLOCK first, each with an action: "Confirm account values", "Add external loss"); stats: Trades left `1 of 2`; Risk left (cap − used, or "No daily cap"); Today's result `+1.20R · +$120.00`; Realized losses today `$50.00` (+ external) with "Add external loss"; account values freshness ("Balance confirmed today" / "Confirm today's balance").
- **Live trades** (prominent, top when any exist): cards with instrument, direction, account, entry, live duration, risk (the initial risk rounded up to the cent, §6.6), last journal item; inline actions: Add note (inline composer), Paste screenshot (drop zone), Open, Close. The stop-move and partial-close summary counts only journal entries stored in the LIVE phase.
- **Plans waiting**: drafts (Ready to lock / Blocked / Draft) and locked plans waiting for entry. A blocked row shows its first reason with " (+N more)" and the actions of §2.4 (Edit draft; Recheck risk or Confirm account values, with Edit draft beside it, when no edit can clear the block); its risk money is rounded up to the cent.
- **All Accounts summary**: today's result and realized losses cover the same trades: every trade closed today in the context, archived accounts included (the detail line adds "· N on an archived account"); the losses add an archived account's realized and external losses of today from its daily usage. Realized losses beside a daily loss limit follow §6.6.
- Account names in chips and fact lines end in an ellipsis with the full name in a tooltip; the page header and the status card wrap a long name (also one without spaces), so Today never pans sideways on a phone.
- **Today's closed trades** list with R/P&L.
- **Today's context** (V1 daily context, renamed "Today's plan · notes"), optional and collapsible.
- Empty day: two large actions (Plan Trade, Record Live Trade) with one-line explanations.

### 14.2 Plan Trade (`/trades/new`) and Edit Draft (`/trades/[id]/edit`)

Progressive form, required first:
1. Trading Account (explicit), Instrument (account instruments; latest version per symbol; "Add instrument" link), Direction (segmented Long/Short), Model (OB first touch / OTE).
2. Entry, Stop, Target (decimal inputs with tick-scale hints), Risk per trade: preset chips `0.25% 0.50% 0.75% 1.00%` filtered to ≤ maximum, default = risk-plan default, plus "Custom" (validated ≤ maximum in the preview).
3. Thesis ("Why this trade? What would invalidate it?") — required.
4. Checks: News (Not checked / Checked · clear / Restricted window), "Contract values match my broker" (with the contract summary), "My setup contradicts a strategy rule" (unchecked default; explains it blocks).
5. Evidence: paste/drop/pick zone (staged; uploaded after the draft is saved).
Right column (desktop) / below (mobile): **live deterministic preview** (TS engine 1.2 with server usage): size, risk money, RR (formatted per §6.6), verdict with exact reasons, warnings collapsed. Primary: **Save draft** (runs the free server check and opens the trade). Edit Draft pre-fills the latest revision, shows "Revision n → n+1", keeps evidence (shown read-only with a link to the trade gallery), and warns when AI analyses exist for the current revision ("Saving creates revision n+1; existing AI analysis will be marked as belonging to revision n").

### 14.3 Record Live Trade (`/trades/live/new`)

Minimal, one screen, mobile-first: Trading Account, Instrument (or "Other symbol"), Direction, Entry price (or toggle "Already open — add price later"), Entry time (default "Now"; "Earlier" reveals a date-time field in strategy time), optional Size, Stop, Risk amount. Primary "Start live journal" → `/trades/[id]#journal` with the composer focused.

### 14.4 Trade workspace (`/trades/[id]`)

- **Header**: `EURUSD · Long` · account chip (links to the account's dashboard and makes it the context, §9.2) · state pill · origin badge · next-action button (§2.4; a blocked draft's line gives the first reason with " (+N more)") · overflow menu (Duplicate draft, Discard, Skip, Reopen review, Technical details).
- **Stepper** (planned) or **live-first banner**. A plan skipped in V1 says so above it ("Skipped before entry · 06:16") with the trader's V1 reason quoted and "Recorded in an earlier version of Trading OS."; "…, without a reason." only when none was stored.
- Sections (desktop two columns: main 8/12 = Plan, Execution, Result, Review; side 4/12 = Live journal + Evidence; mobile single column with Journal first when live):
  - **Plan**: draft view (revision n, last check with exact reasons, Edit/Check/Lock, AI tools with estimates) or locked plan card ("Locked 09:12 · Risk Plan V1.0 · ICT V1.0 · immutable"), thesis (Before entry), strategy card link. A draft whose contract version has been superseded leads with "The {symbol} contract was updated" (contract values read "Confirmed before the contract update"), by the same rule as Edit Draft. A blocked draft's caption says what can clear it: the risk that fits ("A risk of 0.20% or less fits the $20.00 of daily risk left"), that even the minimum size does not fit, the fields to change for a duplicate, or when a recheck can pass (18:00 UTC−5, the next trading day, an open position closing, values confirmed today); it says "Editing the draft won't clear…" only when no reason depends on the draft. Check history rows add " (+N more)".
  - **Pre-trade AI** (read-only, §11.1): after the Plan, on a planned trade that is no longer a draft and has Analyze Setup or Challenge My Bias results.
  - **Execution**: record entry form (Locked; confirmation when it differs from the plan, §8.5) / entry facts + Plan vs reality (§8.5) / live-first facts with "Add entry details". A live-first trade's field reads "Initial stop"; while it is live, the newest stop move journaled while live leads as "Stop" with "Moved hh:mm" ("At entry · moved hh:mm" at the entry price), as on Today.
  - **Live journal**: composer ("Add to trade journal…", paste/drop/attach, `Ctrl/⌘+Enter`), timeline grouped Before entry / While live / After close with exact times and flags. The kind chips are Note · Decision · Stop · Target · Partial · Lesson only while the trade is live; every other state offers Note · Decision · Lesson (§3.6), a draft adding "The stop and target are part of the plan: change them with Edit draft." (with a link to the editor, except on an archived account) and a locked plan "Stop moves, target changes and partial closes can be journaled once the entry is recorded."
  - **Evidence**: gallery + viewer + AI selection (§7.5).
  - **Result**: close form (Live; the exit field of §3.6, the exit time hint "Uses the server's time when it is recorded.", and the "Close this trade?" confirmation of §8.1) / outcome card (R, P&L, fees, outcome, calculation basis, "R based on locked risk" or "R based on risk recorded after entry").
  - **Review**: tags (grade, liquidity, MSS timeframe, custom tags), lessons, "Mark reviewed", AI review card + history. With unsaved tag changes the button reads "Save tags and mark reviewed" (`completeReview` with `saveTags`, §12.2), and leaving the page with unsaved tags asks first ("Discard your unsaved changes?").
  - **Technical details** (collapsed).

### 14.5 Journal (`/journal`)

Fast scan list (keyset pagination, 50 per page, with the exact RLS-bounded total: "Showing 50 of 312 trades") grouped by trade date (entry day if executed, else lock day, else creation day — stated in the group header tooltip). Row: thumbnail, instrument + direction, date/time, account, model (OB/OTE), planned risk %, realized R, P&L (own currency), state pill, Planned/Live-first/Imported badge, tags, AI-reviewed icon. Filters (URL state, chips): account (context; in All Accounts also the read-only `accountFilter`, §9.2), date range (presets + custom), result (win/loss/BE/open), state, origin, model, session, reviewed vs not, AI-reviewed, tags, instrument, currency (`currency=EUR`: one currency's trades, chip "Currency: EUR"; EDGE's per-currency daily P&L bars open it); search box (instrument, tag, note text). Row click → trade. Bulk: none. V1 bookmark keys are read only when the V2 key is absent: `status` (LOCKED → locked, TAKEN → live, CLOSED → closed and reviewed, SKIPPED, CANCELLED) and `outcome` (WIN, LOSS, BREAKEVEN → result); any other value is named in the unreadable-filters notice, `page` and `proposals` are ignored. A V1 `strategy=<name>` is named in the notice (V2 filters by version id), and V1 `from`/`to`, which meant lock dates, are read as V2 trade dates.

### 14.6 EDGE (`/edge`)

Filter row (date range, account context or, in All Accounts, the read-only account filter of §9.2 kept by every link of the page, model, session, origin, instrument) → headline stats (Net R, Expectancy, Win rate, Profit factor, Max R drawdown, Closed trades; money per currency) with sample caveat → charts (§13.6) → breakdowns with drill-down links (`/journal?model=OTE&weekday=Tuesday&from=...`) → calculation definitions. Calendar section with month navigation and mode switch; clicking a day lists that day's trades (sheet) with links to each trade and its evidence. All Accounts uses §9.3. The "Daily net P&L · <currency>" bars count, total and link only their own currency's trades (R summed over them, left out when none has a recorded risk); when a day's trades span currencies, each bar opens the Journal with `currency=`.

Filters a link carries without a control in the filter row (entry weekday, strategy version, risk-plan version, and result for closed results) apply, show as removable chips and are kept by every link of the page. V1 links keep their V1 meanings: `from`/`to` are exit days and narrow the range, `period=month` is This month, `strategy` and `risk` are version ids, `outcome` is the result, `weekday` the entry weekday, and `session=ASIAN_RANGE` is Asia. Two V1 options have no V2 equivalent, `period=last30` and `session=OTHER`: the page shows a warning that they are not applied, and only a raw V1 `/edge/export` URL still applies them (the page's own CSV link matches the page). Unreadable values, `result=open`, and a V1 range that contradicts the link's own range are named in the notice, and the CSV refuses them by name. The read limit is `MAX_LEDGER_ROWS` (20,000): exactly 20,000 matching trades are read in full, and the "Only the first 20,000 closed trades" notice appears only when more match.

### 14.7 Accounts (`/accounts`)

Summary table: Account (name, type, broker), Platform/connection, Currency, Value (last recorded balance/equity with date), Today, Month, Cumulative R, Trades, Status; currency-grouped totals only where valid; actions: New account, Manage, Archive. Archived accounts in a collapsed group. Opening an active account makes it the context (§9.2); an account above 20,000 trades shows "—" with the reason and is named in a notice (§9.4).

### 14.8 Account dashboard (`/accounts/[id]`)

Header (name, type, broker/platform, currency, status; actions Plan Trade and Record Live Trade, both carrying `?account=<id>` (accessible names "Plan Trade on <account>"), then Journal and Manage; an archived account shows only Journal and Manage) → value cards (last recorded balance/equity, starting balance, realized P&L, balance from trades) → charts (balance from trades, cumulative R, R drawdown, daily P&L) → calendar → recent trades / live trades → model and session performance → risk-plan history (§3.10) → quick links (Journal filtered, EDGE filtered, Manage). Clicking a chart point or calendar day drills into trades. A count never sits next to an R that leaves trades out: groups read "N = 13 · 1 without risk · Emerging tendency" with the sample line "35 closed trades · N counts trades with recorded risk" ("No recorded risk" when a group has none), daily bars "2 trades · −1.00R (1 of 2 with risk)" or "1 trade · No recorded risk", calendar days "2 closed trades · 1 without risk". Without closed trades one explanation ("No closed trades yet") replaces the charts, without buttons of its own; above 20,000 trades see §9.4.

### 14.9 Manage account (`/accounts/[id]/manage`)

Tabs: Profile (name, broker, platform, type, starting balance; Archive/Restore with confirmation — "Archiving hides the account from new trades; history stays."), Account values (update balance/equity; "Confirm unchanged"; history), External losses (add/remove today; list), Risk policy (current version card; create new version with default risk, maximum risk, trades/day, minimum RR + policy, news policy, daily risk cap, daily loss limit; immediate override with reason; clear explanation of versioning and that history keeps its original versions; scheduled versions labelled "Starts tomorrow", and versions that never governed a check "Replaced before it started" (§3.10); strategy minimum shown alongside with a warning when the risk-plan minimum is below the strategy's documented 3R), Instruments (list + add instrument version), Connection (Manual; future providers).

### 14.10 Review (`/review`)

Tabs Weekly · Recent trades · Monthly · History. Account scope explicit (selector inside the page when in All Accounts). Concise AI cards (§11.1), budget summary, estimate on the run button (which waits while a review of the same period is running, §11.5), periodic history list with "View full analysis" on every completed row. Trade-level reviews stay on the trade page; Analyze/Challenge stay in the plan section (read-only "Pre-trade AI" after the Plan once the draft is locked or ended, §11.1). An archived account's "Open in Journal" uses the read-only account filter and its AI settings links open `/settings#ai` (§9.2).

### 14.11 Settings (`/settings`)

Sections: General (theme light/dark/system, time display strategy/local/UTC), AI (per-account opt-in with consent, budgets, usage summary, details), Connections (per account overview), Data (Export my data), Security (change password — requires current password re-entry in V2), Danger zone (Delete Trading OS account, §10.4), Developer (technical details expanded; mock sync when enabled by env).

### 14.12 Auth and onboarding

Login/forgot/update pages restyled with the new system (copy stays truthful: invitation-only, no broker execution). `/update-password` accepts only PKCE recovery links (`?code=`); a link carrying session tokens is refused ("Trading OS no longer accepts this kind of recovery link…") and never adopted. A new password is set only on a session that a recovery link started within the last 15 minutes (`amr` entry `recovery`, checked after `getUser` and again on submission); a signed-in visitor without one is sent to Settings → Security, where the current password is required ([PASSWORD_RECOVERY.md](PASSWORD_RECOVERY.md)). The code exchange applies the sign-in rule of §9.2 to the context cookies. First run with no accounts: onboarding card "Create your first trading account" (name, type, broker/platform, currency, starting balance, current balance) → Today. Empty states as §13.7.

---

## 15. Copy and vocabulary

Use trader language. Default UI terms: Trade, Draft, Plan, Locked, Live, Closed, Reviewed, Live-first, Imported, Trading Account, All Accounts, Risk Plan, Strategy, Evidence/Screenshot, Journal, Before entry / While live / After close, Realized losses, External loss, Account values.
Never in default UI: Proposal, observation, setup_status, TRADE_BLOCKED / RISK_APPROVED, rule codes, NOT_EVALUATED, MANUAL_OVERRIDE (say "Taken despite a block"), raw enums (OB_FIRST_TOUCH → "OB first touch"; ASIA → "Asia"; ACTIVE_KILL_ZONE → "Kill zone"; DEAD_POOL → "Dead Pool"; JUDAS → "Judas"), UUIDs, hashes, provider/response ids, "contract version", "manifest", "reservation" (say "reserved for this request" inside AI details only).
Exact required strings: "No pre-trade plan was recorded before execution." · "No pre-trade plan recorded" · "Recorded after execution began" · "Analysis belongs to an earlier draft version" (shown as "Based on draft revision n · current revision is m") · "Analyze blocked setup anyway · ≈ €{x}" · "External realized losses today" (form title "Add external loss") · "Early sample — more data is needed before drawing strong conclusions."

---

## 16. Testing plan

Targeted tests during implementation; the complete verification once at the end (§16.3).

### 16.1 New/updated automated tests (Vitest, `tests/v2-*.test.ts`)

- Database (PGlite, all migrations): backfill mapping and counts; every V2 RPC happy path + ownership denial + idempotent replay + conflict; draft revision concurrency (`DRAFT_CHANGED`); lock only latest revision; live-first create/complete/close math (calculable, user-reported, risk basis variants, R null without basis); journal phase at creation in every lifecycle state; evidence registration limits/replay/phase; tags validation; external losses; risk policy v2 + precedence fix (C9 scenario); engine 1.2 boundaries (T1–T29 and S1–S6 from the precision audit) through `private.risk_report` with explicit `p_now`; daily usage composition; ledger view lifecycle parity with `deriveTradeState`; RLS/grants catalogue for every public table and function; storage policies for `trade-evidence`; erasure (two users, every table populated, flag scoping, UPDATE never allowed, completeness failure rollback, idempotent re-run, AI in-flight refusal, TRUNCATE guard); connections dedup/link/unlink/import-create.
- TS ↔ SQL engine parity: full 1.2 report equality (issues incl. params and order, ruleResults, calculations, snapshot) over the boundary set and ≥ 250 seeded random cases.
- Domain: format (all §6.6 examples), time display, trade state, timing classification (incl. back-dated entry), timeline assembly, plan vs reality, performance metrics (V1 metric parity), calendar buckets (UTC−5 exit day), money-by-currency (no cross-currency sums), account metrics, AI summaries/source chips/estimates, strategy card, sync normalisation/matching/mock pipeline, daily status invariant.
- Server: actions (validation, RPC args, error mapping, revalidation), upload/download routes (origin, ownership, limits, replay, cleanup), export parts (RLS client only), erasure orchestration order and failure handling (mocked), proxy matcher coverage of every `page.tsx` + account cookie behaviour, schema gate.
- UI (SSR `renderToStaticMarkup`): no raw UUID/rule code/enum in default HTML of key screens (regex scan), exact required strings, blocked reasons rendered, live-first banner, timing labels.
- Also pinned: a lock outside the trade model rolls back (`plan_requires_trade`, NULL `p_lock`), archived-account refusals of the V1 RPCs, duplicates onto a superseded contract, `ENTRY_NOT_LIVE` in every state, and that no user token (0, 60 or 240 s old) can call a purge function (`v2-trades-database`, `v2-integrity-*`, `v2-erasure-database`, `v2-erasure-service`); the close preview against the stored close (`v2-close-preview-parity`) and the partial-close averaging (`v2-domain-close`); session cookie attributes through the real `@supabase/ssr` (`v2-supabase-server-cookies`); the request gate's release-or-hold rule and contact reporting (`v2-ai-request-gate`, `v2-ai-release-database`); the seed's pricing before and after a profile expires (`v2-seed-ai-pricing`). Tests never depend on the real clock: they pin it (`vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true })` and `vi.setSystemTime`; PGlite follows the JS `Date`).
- Existing tests: keep passing; tests that pin V1 presentation are replaced by V2 equivalents with equal or stronger assertions (list in the final report). No deterministic-core test is weakened.

### 16.2 Browser acceptance (local Supabase-compatible stack, `scripts/local-stack/`)

Playwright-core driving installed Edge/Chrome, synthetic users only, desktop 1440×1000 and mobile 393×852: planned workflow, live-first workflow, analytics drill-downs, accounts, AI (mocked provider transport, no network), settings (export, delete synthetic account). Screenshots of major screens into `.local/screenshots/` (ignored) and selected ones into `docs/v2-screens/`.

### 16.3 Final verification (once)

Full suite, typecheck, lint (0 errors/warnings), production build, migrations from a fresh database (PGlite + local Postgres), migration from a representative V1 state (V1 fixtures created through V1 RPCs before applying 0015+), RLS/ownership, engine boundaries, risk-plan versioning, draft revisions, live-first, timeline phases, multi-account isolation, aggregation, erasure security, evidence, AI budget regressions, import dedup, matching, responsive/browser, keyboard/accessibility, secret scan.

---

## 17. Work breakdown (file ownership prevents collisions)

| Wave | Track | Owns |
|---|---|---|
| 1 | DB core | `supabase/migrations/0015_canonical_trades.sql`, `tests/v2-trades-database.test.ts`, `tests/v2-schema-catalog.test.ts`, the shared PGlite bootstrap helper `tests/helpers/pglite.ts` |
| 1 | Domain | `src/domain/{format,time-display,risk-explain,daily-status,trade-state,timeline,ledger,performance,account-metrics,plan-vs-reality,ai-summary,strategy-card}.ts`, `src/domain/sync/*`, `tests/v2-domain-*.test.ts` |
| 1 | Design system | `src/app/globals.css`, `src/components/ui/*`, `src/components/charts/*`, `src/components/shell/*` (static parts), `tests/v2-ui-primitives.test.ts` |
| 2 | Engine 1.2 | `0016_risk_engine_usage.sql`, `src/domain/risk.ts`, `src/domain/risk-report.ts`, `src/domain/session.ts` (`nextBoundary` addition only), `tests/v2-risk-*.test.ts` |
| 2 | Connections | `0017_platform_connections.sql`, `src/lib/sync-service.ts`, `tests/v2-connections-*.test.ts` |
| 2 | AI | `0018_trade_ai_timeline.sql`, `src/ai/*` (new modules + registry entry), `src/lib/{analyze-setup,bias-challenge,trade-timeline-review}*.ts`, `tests/v2-ai-*.test.ts` |
| 2 | Erasure + export | `0019_account_erasure.sql`, `src/lib/{erasure,export,zip}.ts`, export route, `tests/v2-erasure-*.test.ts`, `tests/v2-export-*.test.ts` |
| 2 | Data + actions | `src/lib/{account-context,workspace,trades-data,today-data,accounts-data,performance-data,evidence,schema-gate}.ts`, `src/app/actions/*`, evidence routes, `src/proxy.ts`, `tests/v2-actions-*.test.ts`, `tests/v2-routes-*.test.ts` |
| 3 | Screens | one agent per screen group: Today; Trade workspace (+ forms, journal, evidence); Journal; EDGE + calendar; Accounts (+ manage); Review + AI components; Settings + auth + onboarding + legacy redirects |
| 4 | Integration | local-stack browser acceptance, full verification, adversarial review, fixes, reports |
