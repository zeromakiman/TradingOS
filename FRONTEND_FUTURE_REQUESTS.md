# FRONTEND_FUTURE_REQUESTS

Frontend improvements identified during the `ui/opus-v2` redesign that were **deliberately not implemented**
because they would change protected behaviour, introduce a new trading calculation, or touch the
database / storage / routing architecture.

Nothing in this file has been built. It is a review list for GPT-6 Astra.

---

## 1. Structured reasons from `dailyStatus`

**Today.** `dailyStatus` returns `reasons: string[]`. The permission banner can therefore show *that*
new locks are restricted and *how many* conditions apply, but it cannot rank them: a Dead Pool session,
a stale account observation and an exhausted daily-slot count are all rendered at the same weight.

Returning `{ code, severity, message }[]` instead of plain strings would let the frontend put the
hard restriction first and present a recoverable one (for example "update today's account values")
as an action rather than a wall. The banner currently refuses to infer severity by matching on message
text, because that would put rule interpretation in the UI.

*Blocked by:* `src/domain/ux.ts` is covered by `tests/ux.test.ts` and is authoritative state logic.

---

## 2. Planned vs actual delta on Trade Detail

The sealed plan and the recorded execution now sit in visually distinct zones, but the comparison is
left to the reader. A third column — planned entry vs actual entry, planned RR vs realized R, and the
difference — would make execution quality visible on every trade at no extra data cost.

Not implemented because the difference is a **new derived trading value**, and any definition chosen in
the frontend could disagree with the EDGE definitions (fees, denominators, partial state).

*Would need:* an agreed definition in `src/domain/analytics.ts`, exposed like the existing metrics.

---

## 3. Per-day net R in the Journal

The Journal record list groups by strategy day. A net-R figure in each day header would be the natural
next step, but summing `realized_r` in the view would create a number with no owner: EDGE deliberately
scopes net R to completed trades in exit-time order, and a Journal day groups by **lock** date.
Two plausible numbers, one label, is worse than no number.

*Would need:* a day-scoped aggregate defined alongside the other EDGE calculations.

---

## 4. Screenshot thumbnail variants

`/api/screenshots/[id]` serves the full private image. The evidence grid renders each one at roughly
235px wide, so a trade with six charts downloads six full-resolution files — noticeable on mobile data.

A signed thumbnail variant (or a width parameter on the existing authorized route) would fix it.

*Blocked by:* screenshot storage and authorization architecture is protected.

---

## 5. Exact session boundaries for the ribbon

The session ribbon samples `strategyClock` at fifteen-minute marks and collapses the runs, so it can
never contradict the clock. Every current boundary falls on a fifteen-minute mark, so the ribbon is
exact today — but it would silently lose precision if a future session boundary did not.

Exporting the boundary table (or a `nextBoundary(instant)` helper) from `src/domain/session.ts` would
make the ribbon exact by construction, and would also allow an accurate "time remaining in session"
readout, which the UI does not currently compute.

*Blocked by:* session/timezone logic is protected.

---

## 6. Account context in the URL

Every navigation link carries `?account=<uuid>`. It works, and routing cleanup was explicitly excluded
from this pass. Moving the active account to a cookie or a route segment would make URLs shareable and
memorable, and would remove the `accountId` prop threaded through `Shell`.

*Blocked by:* middleware and routing are protected.

---

## 7. Planned RR in `journal_analytics`

The Journal page loads its rows, then issues a second query into `trade_plans.risk_result->calculations`
purely to display planned RR. Exposing `planned_rr` on the `journal_analytics` view would remove the
extra round trip on every page and every filter change.

*Blocked by:* database schema and migrations are protected.

---

## 8. Configurable sample thresholds

The low-sample visual state on EDGE reuses the existing `sampleLabel` bands (`NO DATA`,
`VERY SMALL SAMPLE`, `SMALL SAMPLE`) rather than inventing a threshold. If those bands should ever be
configurable per account, that is a domain change, not a presentation one.

*Blocked by:* analytics calculations are protected.
