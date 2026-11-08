# V2.1 gaps

Known gaps of V2 (branch `ui/claude-v2`) that are documented here instead of being implemented, with today's behaviour
and a proposed design. Sections 1 and 2 concern the connection-ready mock pipeline of
[V2_ARCHITECTURE.md](V2_ARCHITECTURE.md) §8.6 (`0017_platform_connections.sql`, `src/domain/sync/*`,
`src/lib/sync-service.ts`); section 3 concerns the account screens of §9.4; section 4 concerns ledger reads ordered by
computed columns.

## Decision

Gaps 1 and 2 are not implemented in V2. Both need SQL: a new authenticated RPC (gap 1) and changed ingest rules or new
records (gap 2). `0019_account_erasure.sql` must remain the last V2 migration ([DEPLOYMENT.md](DEPLOYMENT.md)), so
both belong to a V2.1 migration. The only fix possible in TypeScript alone, recording the position as a live-first
trade, is unsafe (see 1.4). Gaps 3 and 4 concern large histories (about 15,000 trades and more per account). Gap 3's
per-account totals and gap 4's stored ledger columns need SQL as well, so they belong to V2.1 too; gap 3's bounded
chart payloads, a TypeScript change only, shipped in V2.

**Gap 1 includes a risk exposure that must be closed before any real provider is accepted:** the daily limits do not
see platform executions that are held, unlinked or whose close was not recorded on a trade (1.2; prerequisite in 1.5).

---

## 1. Held (or unlinked) executions can only be linked to a planned trade

### 1.1 Behaviour today

- **How an execution is held.** `runSync` calls `decisionFor(matchExecution(...))` for every new platform position
  (`src/domain/sync/run-sync.ts`). A UNIQUE match leads to LINK (AUTO_MATCH). NONE leads to CREATE (an IMPORTED trade
  with link method IMPORT_CREATED). AMBIGUOUS, when several planned LOCKED/LIVE trades qualify, leads to HOLD:
  `ingest_external_execution` stores the execution with no link, no trade and no warning (database test "holds
  ambiguous executions unlinked, without a trade or a warning").
- **Executions the trader unlinks** become unmatched too. `unlink_external_execution` appends an UNLINK row, and an
  execution counts as unmatched when its latest link row is not LINK.
- **Where held executions appear.** They are listed under Manage → Connection → "Unmatched executions"
  (`listUnmatchedExecutions`; 25 are shown, then "More executions are waiting; link these first to see the rest.").
  Each row offers exactly one action, **Link**, through `link_external_execution` (method USER). The choice is limited
  to planned trades (`linkCandidatesFor` over `loadLinkablePlans`) that:
  - belong to the same account;
  - have the same normalized symbol and direction;
  - are LOCKED, LIVE, CLOSED or REVIEWED;
  - were locked at or before the execution's entry;
  - are not linked yet.

  With no such trade, the row reads "No planned trade matches its instrument, direction and lock time. It stays here
  until one does." That rarely changes: a plan locked later can never qualify. Only an earlier plan whose own link is
  removed could.
- **What the trader is told.** Manage → Connection warns above the unmatched list that these positions do not count
  toward the daily limits ("Until a position is linked to a trade and its close is recorded there, it does not count
  toward this account's daily limits.") and links to External losses ("To count the loss of a closed position now, add
  it under External losses."; not on archived accounts).
- **Actions that do not exist.**
  - "Import as a new trade": `ingest_external_execution` creates IMPORTED trades only for a *new* external id. For a
    stored id it returns UNCHANGED, CLOSED or CHANGED and ignores the decision, so syncing again changes nothing.
  - Linking to a live-first trade: `guard_execution_links` rejects LIVE_FIRST trades, and `check_execution_link`
    accepts PLANNED trades only.
  - Linking to an imported trade: only IMPORT_CREATED links can point to one.
  - "Not mine / ignore": there is no dismiss action.
- **Effect on the data.** A held position appears in no trade-based view:
  - no Journal row and no EDGE statistic;
  - not in the CSV export (`/edge/export`, which reads `trade_ledger`);
  - **not in daily usage**, so the deterministic limits do not see it (1.2).

  When the platform later reports the position closed, the close is appended to `external_execution_closes`, but no
  trade is closed (database test "appends the close of a linked planned trade or a held execution without closing any
  trade"). The connection card says "{n} waiting for you" (`platform_connection_overview.unmatched_count`).

### 1.2 Risk exposure: the daily limits do not see platform executions

**What daily usage reads.** `private.daily_usage` (0016) reads only these tables:
- `trade_plans` (planned slots and risk, open exposure);
- `trade_executions` (actual risk of executed plans);
- `trades` of origin LIVE_FIRST or IMPORTED, with their effective position facts (trade slots, risk, open exposure);
- `trade_outcomes` and `trade_unplanned_closes` (realized loss);
- `external_loss_entries` that were not removed (external loss).

`external_executions` and `external_execution_closes` are never inputs.

**Held or unlinked executions.** These have no trade, so for them:
- no trade slot is taken (`unplannedTrades`, the MAX_TRADES input);
- no risk is added (`unplannedRisk`, the DAILY_RISK_LIMIT input);
- no open exposure is added (`openExposure`), and no unknown risk is counted (`openRiskUnknown`, `riskUnknownTrades`);
- the realized loss of the platform close is not added (`realizedLoss`, the daily loss limit input).

**Executions linked to a planned trade.** These count only through the planned trade's own recorded facts:
- the plan's slot and nominal risk, on the plan's trading day;
- its open exposure:
  - on the plan's trading day, until it has an outcome or a disposition;
  - on later days, only once its entry is recorded and while it has no outcome;
- its realized loss, once the trader records the close in Trading OS.

The platform's own close of a linked planned trade is stored but not applied. Until the trader records it, the loss
is missing from `realizedLoss`.

A plan with a linked platform position cannot be marked skipped or cancelled (decided in V2): the trigger
`linked_disposition_guard` on `trade_dispositions` (0017) raises `EXECUTION_LINKED` while an active link exists, for
`set_planned_disposition` and the V1 `set_journal_disposition` alike, and the trader unlinks first. Before it, the
local stack reproduced the gap (`set_planned_disposition` returned SKIPPED and the position's result counted in no
result or daily limit). The other order was already refused: a skipped or cancelled plan is not linkable.

Manage → Connection flags each listed planned link whose position closed on the platform while the trade is LOCKED or
LIVE ("Closed on the platform, but the trade is still open in Trading OS. Record the close on the trade: until then
this result is not in your results or daily limits."), and each whose plan is marked skipped or cancelled while linked, which only data from before the guard can show ("The
platform reports this position, but its plan is marked skipped, so the position counts in no result or daily limit.").

**The exposure.** With a real provider, a trader could leave a losing position held (ambiguous) or unlinked, or not
record the close of a linked planned trade, and still have the full daily loss budget and every trade slot. That
weakens the deterministic risk authority (V2_ARCHITECTURE.md §0.1). Any "ignore" action would make the gap permanent,
so the dismissal in 1.5 is constrained.

**Impact in V2: none.** V2 ships only the MOCK provider:
- `create_platform_connection` refuses CTRADER and MT5 (`PROVIDER_NOT_AVAILABLE`);
- the server calls it only for MOCK, with `TRADING_OS_ENABLE_MOCK_SYNC=true` (a developer simulation with sample
  positions, never set on Preview or production).

**Workaround until V2.1.** Record the loss of a platform position that is held, unlinked or whose platform close was
not recorded on its trade as an **External loss** on the day of the close (Manage → External losses). The helper copy
already covers it: "Losses from trades not recorded in Trading OS today, for example on another platform." If the
same position becomes a trade with a recorded close later that day, remove that External loss (removals are
audited), so the loss counts once. The note under the External loss form (`EXTERNAL_LOSS_SYNC_NOTE`, Manage and
Today) reads "Don't add losses already recorded on a trade in Trading OS (imported trades included): they are counted. A
synced platform position counts only once its close is recorded on a trade.", and Manage → Connection's pointer to
External losses adds "If you later record its close on a trade, remove that external loss."

### 1.3 What V2 ships around it

`src/lib/sync-service.ts` has `listUnmatchedExecutions` and `listLinkedExecutions`, both RLS-scoped and proven on
PGlite through the real service functions. Manage → Connection reads each list with one query, the account's linkable
plans once for all waiting positions (`loadLinkablePlans` + `linkCandidatesFor`, never one read per position), and the
lifecycles of listed planned links in one read (`loadTradeLifecycles`) (`src/components/accounts/connection-data.ts`),
and says when only the 50 most recent linked executions are shown. It shows each position's platform ticket and latest
platform notice, warns that waiting positions do not count toward the daily limits (1.1) and flags linked plans that do
not carry their position's result (1.2). An archived account's sync no longer stops at the first new position: the
position is deferred (not imported, fetched again by the next sync), the rest of the batch syncs, and the status says
how many were not imported and why (V2_ARCHITECTURE.md §8.6).

### 1.4 Why a TypeScript-only workaround is unsafe

Recording the position with `record_live_trade` creates a LIVE_FIRST trade, which can never be linked to the
execution (`guard_execution_links`). This causes three problems:

- The execution would stay "waiting for you" indefinitely.
- The same platform position would exist twice: once as an unlinked execution and once as an unrelated trade.
- The provenance needed for deduplication would be lost: the trade would not carry the external id, and a later sync
  could not recognise it.

V2_ARCHITECTURE.md §8.6 and master specification §45 require "deduplicate with stable external IDs" and "preserve
provider/platform provenance".

### 1.5 Proposed design (V2.1)

**Prerequisite for any real provider.** Close the exposure of 1.2 before `create_platform_connection` accepts CTRADER
or MT5. Every platform execution of a connected account counts toward daily usage **exactly once, by its own facts,
whatever its link state**:

- **Linked to a trade** (IMPORT_CREATED, AUTO_MATCH or USER): it counts through the trade's facts wherever the trade
  has them. Where the trade does not, it counts by the execution's own facts:
  - a linked plan whose entry is not recorded yet;
  - a platform close that is not recorded on the trade yet.
- **Held, unlinked or dismissed**: it counts by its own facts:
  - a trade slot on the strategy day of its entry;
  - open exposure while it is open. Without a stop and a contract its risk is unknown, so it counts in
    `openRiskUnknown` and `riskUnknownTrades`, like an unplanned trade without a risk basis;
  - its realized loss, `max(0, -realized_pnl)`, on the strategy day of its exit. This is the amount an imported close
    of it contributes (`close_imported_trade` takes the platform's realized P&L as the net P&L).

How to build it:
- `private.daily_usage` gets the executions as a new input, through `create or replace` in a new migration.
- The engine's inputs change, so it gets a new engine version label (V2_ARCHITECTURE.md §0.3). Stored reports keep
  theirs.
- The TS preview reads the same usage object, so the TS ↔ SQL parity tests cover it.

PGlite tests:
- a held losing execution reaches the daily loss limit and blocks the next lock;
- a held open execution takes a trade slot (MAX_TRADES);
- a linked or imported execution is counted once, never both as a trade and as an execution;
- a linked planned trade whose platform close is not recorded yet counts that loss;
- unlinking moves the count from the trade to the execution without dropping it;
- a plan with a linked platform position cannot be skipped or cancelled (done in V2: `linked_disposition_guard`, tested in
  `tests/v2-connections-database.test.ts`); keep it when executions count by their own facts.

**SQL** (a new migration after 0019; the erasure purge in 0019 is catalog-driven and covers it):

- `public.import_external_execution(p_execution_id uuid, p_request_key uuid) returns jsonb`. The function is security
  definer with `search_path = ''`, executable only by `authenticated` (V2_ARCHITECTURE.md §0.5 revoke and grant). It
  runs these steps:
  1. Lock the account row `for update`: imported trades count toward daily usage, the same order ingest uses.
  2. Lock the execution row `for update` and require `user_id = auth.uid()`; otherwise raise `EXECUTION_NOT_FOUND`.
  3. Require that `private.active_execution_link(execution)` is null; otherwise raise `EXECUTION_ALREADY_LINKED`.
  4. Refuse archived accounts with `private.require_active_account` (`ACCOUNT_ARCHIVED`), as ingest's CREATE path does.
  5. Replay by `trades(user_id, request_key)`: the same execution returns the same envelope with `replayed: true`. A
     different execution under the same key raises `IDEMPOTENCY_CONFLICT`.
  6. Create the trade from the execution's **effective** state: the first stored version plus its appended
     `external_execution_closes` row, if any. This reuses one shared private function,
     `private.create_imported_trade(connection, execution, close)`. The CREATE branch of `ingest_external_execution`
     is refactored to call the same function, so both paths produce identical records:
     - an IMPORTED trade (`request_key`);
     - `trade_position_facts` with source IMPORT, using the same contract-attachment rule as CREATE (see gap 2);
     - a `trade_execution_links` row LINK / IMPORT_CREATED, which the guard trigger already allows for IMPORTED trades;
     - `private.close_imported_trade(...)` when the effective state is closed with a platform P&L;
     - the existing "closed without a realized P&L" warning when it is closed without one.
  7. Return `{tradeId, executionId, accountId, replayed}`.
- Optional: `public.dismiss_external_execution(p_execution_id, p_reason)`, an append-only dismissal row that hides an
  execution the trader does not track as a trade from "waiting for you".
  - It stays visible under a "Dismissed" disclosure, with its realized P&L, and stays in Export my data.
  - It never counts as a trade: no Journal row and no EDGE statistic.
  - It **never removes the execution from daily usage**: the prerequisite above still counts it by its own facts.
    Nor does it remove the execution from any money total that counts it. Dismissing changes what is listed, never
    what the risk limits see.

**TypeScript**

- `src/lib/sync-service.ts`: `importPlatformExecution(executionId, requestKey)`, taking the user from the verified
  session, plus error copy for the new codes.
- `src/app/actions/connections.ts`: an `importExecution` action that revalidates the manage page and the new trade.
- Manage → Connection: on each unmatched row, a secondary **Import as a new trade** button next to Link, behind a
  confirm dialog: "Creates an Imported trade with no pre-trade plan. It can't be linked to a planned trade
  afterwards." With no candidate plan, the row offers Import as the primary action. Its copy replaces "It stays here
  until one does."

**Tests**

- PGlite:
  - owner only: another user gets `EXECUTION_NOT_FOUND`;
  - replay and conflict;
  - already linked; archived account;
  - open, closed with P&L and closed without P&L, the latter with the warning;
  - effective state taken from an appended close;
  - parity of records with ingest CREATE;
  - daily usage counts the imported loss;
  - erasure still covers every table.
- Service, action and screen tests, and a browser-acceptance step: a mock fixture with two qualifying plans gives an
  AMBIGUOUS hold, which is then imported.

---

## 2. Imported trades can have no instrument version (contract)

### 2.1 Behaviour today

When `ingest_external_execution` creates an IMPORTED trade, it attaches the account's **latest** instrument version
whose `symbol` equals the execution's symbol (latest `created_at`, then id). It attaches that version only when the
position lies on its grid: `mod(entry_price, tick_size) = 0`, `mod(volume, quantity_step) = 0` and
`volume >= minimum_quantity`. Otherwise `trade_position_facts.instrument_version_id` is null. The database test
"attaches the account's latest contract only to positions on its tick and size grid" covers off-step volume, off-tick
price, size below the minimum and an unknown symbol.

Further details:

- Only the latest version is tried. An older version whose grid fits is not considered.
- The match compares the stored instrument symbol with the execution's symbol, which `normalizeExternalPosition`
  normalizes. Links compare `private.normalized_symbol` on **both** sides. So an instrument saved as `EUR/USD` matches
  links but is never attached at import.

### 2.2 Consequences

- **P&L** is unaffected. An imported close uses the platform's realized P&L (`pnl_source` IMPORTED,
  `close_imported_trade`).
- **The risk basis cannot be derived**: it needs tick size and tick value. `actual_initial_risk` is null, and realized
  R exists only when the trader recorded a risk amount.
- **Open imported trades**: "Add entry details" (`complete_live_entry`) can record `riskAmount` (USER_REPORTED). When
  the platform close arrives, `close_imported_trade` uses it and R becomes available (the grid-step case of the test
  above). An instrument whose grid rejects the position cannot be attached afterwards: `check_position` refuses it.
- **Positions already closed when imported** are closed during import, with no risk basis, so `realized_r` is null. The
  risk basis can never be added afterwards: `complete_live_entry` raises
  `ALREADY_CLOSED: Entry details of a closed trade are immutable`, and closes are immutable. These trades count in
  EDGE's P&L per currency and trade counts, but are permanently excluded from R statistics ("closed trades without a
  recorded risk"). They also appear in the CSV with an empty `initial_risk` and `realized_r`.
- **Matching** is unaffected: it uses the planned trades' contracts.

### 2.3 Proposed design (V2.1)

1. **Symbol match.** Attach by `private.normalized_symbol(instrument.symbol) = private.normalized_symbol(execution.symbol)`.
   Among the account's versions of that normalized symbol, take the newest whose grid fits, not only the newest
   overall. This is a function-body change of the CREATE path; it applies to new imports only, and stored facts are
   never rewritten.
2. **Platform contract specification (cTrader V2.1).** Extend `ExternalPosition` with an optional, provider-reported
   contract (tick size, tick value in the account currency, volume step, minimum volume). This applies only where the
   official API provides it; per master specification §42 nothing is guessed. When no user-defined version fits,
   ingest creates an instrument version with a new `source 'PLATFORM'`. That requires extending the check on
   `instrument_versions.source`, in a new migration. The version is immutable and versioned like user versions, and
   never replaces the trader's own versions in pickers unless none exists.
3. **Platform stop at entry.** When the platform reports the stop-loss that was set when the position opened (not a
   later-moved stop), import it as `initial_stop` (source IMPORT). The risk basis is then DERIVED from platform facts
   rather than from hindsight. If the API exposes only the current stop, do not use it as the R basis: a moved stop
   would change R after the fact. Record it as a STOP_CHANGE journal entry with source IMPORT instead.
4. **No risk basis after close.** Keep realized R unavailable for trades closed without a recorded risk. A risk amount
   typed after seeing the result would let hindsight change R, and process quality must stay separate from P&L. The
   path stays "record the risk while the trade is open" (Today's live card and the trade page offer "Add entry
   details"). Optionally, Manage → Connection could warn when an open imported trade has no risk recorded yet.

**Tests**: PGlite cases for normalized-symbol attachment, the newest fitting version, PLATFORM versions (source check,
immutability, erasure coverage), the imported initial stop leading to a DERIVED basis and R, and stops moved after
entry never becoming the R basis. Also domain tests for the extended `normalizeExternalPosition` (strict zod, canonical
decimals).

---

## 3. Accounts with more than 20,000 trades

### 3.1 Behaviour today

The Accounts overview and the account dashboard add up an account's trades in TypeScript from one keyset read of
`trade_ledger`, at most `MAX_LEDGER_ROWS` (20,000) live, closed and reviewed rows per account
(`src/lib/accounts-data.ts`, `src/domain/account-metrics.ts`). Exactly 20,000 rows are added up in full. When more
exist, nothing partial is shown: every figure computed from that account's trades reads "—" with the reason, and so do
the currency totals and the combined R that would include it. The Accounts page names such accounts in a notice ("Some
results are not added up"); the dashboard replaces results, charts, calendar and groups with "More trades than this
page can add up" and links to EDGE and the Journal, which work by date range.

The ledger reads themselves are bounded (V2_ARCHITECTURE.md §9.4: per-account keyset streams, the lifecycle checked on
the rows read, the rest of the id range read in parallel), and so are the chart payloads: line charts above 300 points
keep marks, tooltips and table rows only for one point per run of ⌈count / 300⌉ plus the first, last and
deepest-drawdown points and draw min/max-decimated paths, and EDGE's daily bars show the last 120 trading days
(V2_ARCHITECTURE.md §13.6). Exit-ordered sorts parse each timestamp once (`instantComparer`; they parsed both on every
comparison, 12.8 s of a 17.8 s EDGE render at 19,900 trades). Measured on 2026-11-08 with a production build
(1440×1000, three runs per page, the same synthetic data before and after):

| Page | Trades | HTML before → after (transferred) | Load before → after |
|---|---|---|---|
| Account dashboard | 19,900 | 118.7 MB (12.4 MB) → 2.45 MB (0.37 MB) | 30.9–35.7 s → 4.6–5.2 s |
| Account dashboard | 15,000 | 89.4 MB (9.5 MB) → 2.46 MB (0.37 MB) | 19.2–25.2 s → 3.6–4.0 s |
| EDGE, one account | 19,900 | 94.6 MB (8.9 MB) → 2.64 MB (0.34 MB) | 35.4–38.8 s → 5.5–5.8 s |
| EDGE, one account, filtered | 19,900 | 33.0 MB (3.2 MB) → 2.58 MB (0.33 MB) | 12.9–17.3 s → 5.7–9.4 s |
| EDGE, All Accounts | 3 × 15,000 (20,000 read) | 97.8 MB (9.3 MB) → 2.90 MB (0.36 MB) | 39.5–40.2 s → 8.2–8.4 s |
| EDGE, All Accounts, filtered | 3 × 15,000 | 70.7 MB (6.8 MB) → 3.10 MB (0.38 MB) | 28.5–36.6 s → 7.4–7.9 s |

The browser finishes within about 0.2 s of the server; what remains is server time (reads, then metrics over up to
20,000 trades), above the 5 s budget for EDGE across accounts.

Every other page of these users loads in 1–13.5 s (Today 1.0–2.0 s, Accounts 2.5–4.9 s, Review 0.8–1.6 s, EDGE
filtered on one account 10.1–11.0 s, the trades CSV 7.8–13.5 s; the Journal is section 4).

### 3.2 Proposed design (V2.1)

- Per-account totals computed in SQL over `trade_ledger` (security invoker, so RLS still applies): realized P&L, today
  and month P&L by strategy day of exit, cumulative R, closed and live counts, and max R drawdown over the exit-ordered
  sequence. These replace the "—" for accounts above the limit.
- The same SQL totals for EDGE's headline metrics and breakdowns of a large scope, so EDGE across accounts at 20,000
  trades meets the 5 s budget (8.2–8.4 s today; the chart payloads are already bounded, §3.1).
- Tests: SQL totals equal the TypeScript metrics on the same trades (parity), at 20,000 and above.

---

## 4. Ledger reads ordered by computed columns

### 4.1 Behaviour today

`trade_ledger` derives the lifecycle, the entry, lock and exit times and most other columns per row through about a
dozen joins. A read that filters or sorts on such a column makes PostgreSQL compute every trade of the scope first,
and no index can help. V2 avoids that where it measured it (V2_ARCHITECTURE.md §9.4, §13.3, §14.1): keyset reads by
id with the lifecycle checked on the rows read, open trades found through the base tables' keys (`openTradeIds`),
drafts read with the plain `origin` and `plan_id` columns, the palette's newest trades found in `trades`, and All
Accounts read one account at a time. Two reads remain, measured on 2026-11-08 with a production build on synthetic users:

- **Journal.** Each of its three streams is sorted by a computed trade date (`entered_at`, `locked_at` or
  `created_at`): 4.55 s across all accounts or 1.38 s per account at 3 × 15,000 trades, plus 2.1 s for the exact
  total. The page takes 7.9–8.7 s for All Accounts at 45,000 trades (7.3–7.9 s filtered), over the 5 s budget;
  splitting by account gives no net gain. One account of 19,900 trades: 3.3–3.4 s.
- **Prepared statements.** PostgREST prepares its statements; after five runs on a connection PostgreSQL may switch to
  a generic plan, under which a ledger read filtered by a computed column measured 5 s and more. Against the 8 s
  statement timeout of `authenticated` (Supabase's default), such a read can fail under load. Every statement timeout
  the local stack logged during the measurements was such a read. The last list filtered that way, the account
  dashboard's live trades, now reads the open trades (`openLedgerRows`) too; only the Journal's sorted streams remain.

### 4.2 Proposed design (V2.1)

- A stored, indexed trade date and plain open-state facts that the ledger exposes without deriving them (a new
  migration after 0019, within the append-only rules of V2_ARCHITECTURE.md §0: recorded by the RPCs that already
  record each lifecycle event, never rewriting history), so the Journal's streams and every open-trade list become
  index range reads.
- Then the Journal sorts by the stored date and the open-trade lists read the open state, and no ledger read filters or
  sorts on a computed column.
- Tests: the stored columns agree with the derived ones (parity) for every lifecycle, origin and back-dated entry, and
  the erasure purge still covers every table.
