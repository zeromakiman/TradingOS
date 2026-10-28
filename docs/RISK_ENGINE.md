# Deterministic Risk Engine (engine 1.1, report 1.2)

The Risk Engine decides whether a planned trade may be locked. It is deterministic, exact and authoritative: the SQL
function `private.risk_report_v12` (supabase/migrations/0016_risk_engine_usage.sql) runs on every check and again,
under the account lock, at every lock. `evaluateRisk` in `src/domain/risk.ts` is its TypeScript mirror for the live
preview in Plan Trade and Today. For the same proposal and context both produce the same report, byte for byte, except
`evaluatedAt` (`tests/v2-risk-engine-parity.test.ts`: the precision-audit boundaries T1–T29 and S1–S6 plus at least 250
seeded random cases). A browser verdict is never trusted, and AI never overrides a BLOCKED decision.

Design reference: [V2_ARCHITECTURE.md §6](V2_ARCHITECTURE.md). The V1 engine description is in git history (commit
`bc5441c`).

## Versions and history

- `engineVersion` stays `"1.1"`: the rules and sizing arithmetic of V1. `reportVersion` is `"1.2"`: the report carries
  the daily usage, the limits it was checked against, the instrument, `params` for every issue and a result for every
  rule.
- Stored reports keep the meaning they had when written. `storedRiskSchema` parses report 1.2, report 1.1 and the
  legacy 1.0 shape; a plan locked under 1.1 keeps its 1.1 report. Missing parameters of older reports are rebuilt for
  display from the immutable risk-plan and instrument versions they reference, never from today's settings.

## Inputs

- **Proposal** (`proposalSchema`, 11 keys): instrument version, direction (LONG/SHORT), model (OB first touch / OTE),
  entry, stop, target, requested risk percent, news check, contract confirmation, strategy-contradiction flag, thesis.
- **Context**: the server's time (never the browser clock); the strategy version; the latest account observation
  (balance/equity, its strategy day, currency); the **active risk plan**; the instrument version; the **daily usage**;
  and whether the proposal duplicates a plan locked today.

## Risk-plan precedence

`private.active_risk_plan(account, day)` picks, among the account's risk-plan versions effective on that strategy day
(`effective_day <= day`), the most recently created one. Every engine path, the TypeScript loaders and the
"current risk plan" shown in the UI use this rule (V1 audit finding C9). New versions start on the next strategy day
by default ("Starts tomorrow"); an immediate version requires a reason and is recorded as a configuration event.
Trades keep the risk-plan version they were checked and locked with.

## Selectable risk per trade

Plan Trade offers the presets 0.25%, 0.50%, 0.75% and 1.00%, filtered to the plan's maximum, plus the plan's default
risk when it is not a preset, plus **Custom**. The default selection is the plan's `defaultRiskPercent` (the maximum when
no default is set). Whatever is chosen is only a request: `RISK_LIMIT` blocks any requested percent strictly above the
plan's maximum, in the preview and on the server.

## Daily usage

`private.daily_usage(account, now)` (exposed to the owner as `public.get_daily_risk_usage`) computes, for the strategy
day of `now`:

| Field | Meaning |
|---|---|
| `plannedSlots`, `plannedRisk` | Plans locked that day and their nominal risk (closed or skipped plans keep their slot, as in V1) |
| `unplannedTrades`, `unplannedRisk`, `unplannedRiskUnknown` | Live-first and imported trades entered that day, their known risk, and how many have no risk basis |
| `realizedLoss` | Losses of planned outcomes and live-first closes exited that day |
| `externalLoss` | External losses recorded for that day (Manage account → External losses) |
| `legacyReportedLoss` | The V1 manual loss total, when the latest observation is from that day |
| `lossTotal` | `greatest(coalesce(legacyReportedLoss, 0), realizedLoss + externalLoss)` (no double counting, never below V1) |
| `openExposure`, `openRiskUnknown` | Risk still at stake: today's plans without outcome or disposition, earlier executed plans without outcome (the larger of planned and actual initial risk), open live-first/imported trades of any day |
| `riskUnknownTrades` | Distinct live-first/imported trades without a risk basis (the two "unknown" counters overlap and are never added) |

## Calculations (exact)

All arithmetic is exact: Decimal.js at 100 significant digits in TypeScript, `numeric` in PostgreSQL. The only
quotients that may not terminate are truncated: off-grid tick and pip counts to 20 decimals, the planned RR to 8
decimals, money budgets to cents.

```text
budget         = floor_cents(equity × requestedRiskPercent / 100)
permittedRisk  = floor_cents(equity × maxRiskPercent / 100)
stopDistance   = |entry − stop|          stopTicks = stopDistance / tickSize      stopPips = stopDistance / pipSize (null without pips)
quantity       = floor(budget × tickSize / (stopDistance × tickValue × quantityStep)) × quantityStep   (never rounded up)
nominalRisk    = quantity × stopTicks × tickValue          (a nominal risk above the budget raises SIZING_INVARIANT)
plannedReward  = |target − entry|        plannedRR = trunc8(plannedReward / stopDistance)
```

Realized R (after the close) = net P&L after fees ÷ the trade's initial risk: the risk locked in the plan for planned
trades, the recorded risk for live-first and imported trades (reported, or derived from entry, stop and size). A trade
without a risk basis has no R and is excluded from every R statistic with a visible count. Moving a stop never changes
the denominator.

## Rules

The 18 hard rules (`RISK_RULES`) each appear exactly once in `ruleResults`. MAX_TRADES, DEAD_POOL and STALE_EQUITY are
evaluated even when input or geometry errors stop sizing.

| Code | Severity | Condition (engine 1.1 with report 1.2 inputs) |
|---|---|---|
| `RISK_LIMIT` | BLOCK | requested risk % > plan maximum (strict) |
| `MIN_RR` | BLOCK or WARN (`rrPolicy`) | planned RR below the minimum, compared by cross-multiplication |
| `MAX_TRADES` | BLOCK | `plannedSlots + unplannedTrades >= maxDailyTrades` |
| `DAILY_RISK_LIMIT` | BLOCK | cap configured and `plannedRisk + unplannedRisk + nominalRisk > cap` |
| `DAILY_LOSS_LIMIT` | BLOCK | cap configured and `lossTotal + openExposure + nominalRisk > cap` |
| `DEAD_POOL` | BLOCK | strategy time 12:00–18:00 (UTC−5) |
| `STALE_EQUITY` | BLOCK | the latest account observation is not from today's strategy day |
| `MINIMUM_QUANTITY`, `OFF_TICK`, `PRICE_GEOMETRY`, `MISSING_STOP` | BLOCK | sizing below the minimum, prices off the tick grid, stop/target on the wrong side, no stop |
| `CONTRACT_UNCONFIRMED`, `INSTRUMENT_MISMATCH` | BLOCK | contract values not confirmed; instrument currency differs from the account's |
| `DUPLICATE` | BLOCK | an identical plan already reserves a slot today |
| `STRATEGY_CONTRADICTION` | BLOCK | the trader flagged a contradiction with the written rules |
| `NEWS_RESTRICTED` | BLOCK or WARN (`newsPolicy`) | a restricted news window was reported |
| `SIZING_INVARIANT`, `INVALID_INPUT` | BLOCK | internal safety check; malformed input (field-level copy) |
| `OUTSIDE_ACTIVE`, `NEWS_UNKNOWN`, `UNPLANNED_RISK_UNKNOWN` | WARN | outside the kill zone; news not checked; live-first trades without risk not in the totals |
| `COSTS_UNKNOWN`, `DAILY_RISK_UNCONFIGURED`, `DAILY_LOSS_UNCONFIGURED` | note | sizing excludes costs; no daily cap configured |

`DAILY_LOSS_UNKNOWN` is not produced by report 1.2: the loss total is always known. Sessions use the fixed UTC−5
strategy clock (no daylight saving): Asia 18:00–01:00, Judas 01:00–02:00, active kill zone 02:00–12:00, Dead Pool
12:00–18:00, start-inclusive and end-exclusive.

## Report 1.2

`riskReportSchemaV12` (strict) holds: `engineVersion`, `reportVersion`, `decision`/`status`, `issues[]` (`code`,
`severity`, `message`, flat `params`), `ruleResults` (all 18 codes), `requestedRiskPercent`, `targetDistance`,
`sessionEligible`, `calculations`, `limits` (the risk-plan values checked against, with its version), `instrument`, and a
`snapshot` with the observation and every usage field (`slotsUsed`, `riskConsumed` and `grossLoss` keep their 1.1
meaning as planned + unplanned totals). `isRiskReportCurrent` decides from the stored report, today's usage and the
server time whether an approval is still current ("Recheck needed" otherwise); the lock re-evaluates regardless.

## Precision and display

- Every decimal in a report is canonical text: SQL `trim_scale`, `Decimal#toFixed()` without trailing zeros, never
  exponent notation. Integers stay JSON numbers. No `Number()`/`parseFloat()` of a decimal string in money, price, R or
  percent paths.
- Display never contradicts a verdict (`src/domain/format.ts`): values compared against a threshold are rounded toward
  the side that preserves the verdict (an RR of 2.995 against a minimum of 3 shows "2.99R"), policy inputs show their
  exact value padded to two decimals, prices use the instrument's tick scale, R is signed (`+1.01R`, `-1.00R`,
  `0.00R`, never `-0.00R`), money is per currency and never converted.
- Every issue renders from its code and `params` through `src/domain/risk-explain.ts`, the single message catalogue
  shared with SQL (which stores the same sentences for audit). The UI shows the exact blocking reasons in the primary
  view; warnings and notes are grouped below them.

## Locking

`lock_trade(trade, expectedRevision)` locks the trade, refuses a draft that changed since it was loaded
(`DRAFT_CHANGED`) or is no longer a draft, requires an active account, and locks the latest revision through the V1
lock path, which takes the account lock and evaluates again with the active risk plan, the latest observation, today's
usage and the server's `clock_timestamp()`. Only an approved evaluation writes the immutable plan (proposal, risk
report, version links, locked time) and links it to the trade; locking a trade that already has a plan returns that
plan (a replay). Locked plans are never edited: later decisions are journal entries, and entry and close facts are
recorded once.
