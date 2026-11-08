# Trading OS V2 screens

Curated from the scripted browser acceptance run `20261108-165555-478b32` (2026-11-08, strategy clock 11:55 UTC−5, Kill zone; verdict PASS),
captured from the local Supabase-compatible stack with the dev server's local mock AI provider. Every account, trade,
screenshot and AI result shown belongs to synthetic users the run created at the reserved domain `example.test`
(seeded with `scripts/local-stack/seed-v2.mjs`); charts inside the screenshots are stamped "Synthetic chart".

Pass matrix of that run:

- Planned workflow: desktop PASS 18/18, mobile PASS 16/19 (1 clock-limited, 2 skipped)
- Live-first workflow: desktop PASS 10/10, mobile PASS 10/10
- Analytics drill-down: desktop PASS 8/8, mobile PASS 8/8
- Trading accounts: desktop PASS 10/10, mobile PASS 10/10
- AI (local mock provider): desktop PASS 10/12 (2 clock-limited), mobile PASS 10/12 (2 clock-limited)
- Settings, export and erasure: desktop PASS 8/8, mobile PASS 8/8
- UX criteria, keyboard and themes: desktop PASS 12/12, mobile PASS 14/14

Regenerate (stack and dev server running, see `scripts/local-stack/README.md` → Browser acceptance):

```sh
node scripts/local-stack/acceptance/run.mjs --publish-screens
```

Only a run whose verdict is PASS, covering every flow at both viewports and capturing every image below, replaces
this folder; any other run leaves it untouched.

## Today

**Today: session ribbon, trading status per account, live trades, plans waiting, closed today** · Desktop 1440×1000 · light theme · whole page

![Today: session ribbon, trading status per account, live trades, plans waiting, closed today](today-desktop.png)

**Today: session ribbon, trading status per account, live trades, plans waiting, closed today** · Phone 393×852 · light theme · whole page

![Today: session ribbon, trading status per account, live trades, plans waiting, closed today](today-mobile.png)

**Phone: Today's live trade card with the inline note composer (taps only)** · Phone 393×852 · light theme

![Phone: Today's live trade card with the inline note composer (taps only)](mobile-today-live-note-mobile.png)

## Planned trade

**Plan Trade: live risk preview blocked with the exact reason, two staged screenshots** · Desktop 1440×1000 · light theme

![Plan Trade: live risk preview blocked with the exact reason, two staged screenshots](plan-trade-blocked-desktop.png)

**Trade workspace: blocked draft with the exact reason and Edit draft as the next action** · Desktop 1440×1000 · light theme

![Trade workspace: blocked draft with the exact reason and Edit draft as the next action](trade-draft-blocked-desktop.png)

**Trade workspace: planned trade live, journal with a note and a pasted screenshot** · Desktop 1440×1000 · light theme · whole page

![Trade workspace: planned trade live, journal with a note and a pasted screenshot](trade-planned-live-desktop.png)

**Trade workspace: planned trade live, journal with a note and a screenshot from the phone's picker** · Phone 393×852 · light theme

![Trade workspace: planned trade live, journal with a note and a screenshot from the phone's picker](trade-planned-live-mobile.png)

**Trade workspace: reviewed trade with its timeline (Before entry · While live · After close)** · Desktop 1440×1000 · light theme · whole page

![Trade workspace: reviewed trade with its timeline (Before entry · While live · After close)](trade-closed-timeline-desktop.png)

## Live-first trade

**Record Live Trade on a phone: the minimal live-first form** · Phone 393×852 · light theme · whole page

![Record Live Trade on a phone: the minimal live-first form](record-live-trade-mobile.png)

**Live-first trade: no pre-trade plan banner, live journal and close form** · Desktop 1440×1000 · light theme

![Live-first trade: no pre-trade plan banner, live journal and close form](trade-live-first-desktop.png)

**Phone: live-first trade timeline (While live · After close)** · Phone 393×852 · light theme

![Phone: live-first trade timeline (While live · After close)](mobile-live-first-timeline-mobile.png)

## Journal, EDGE and evidence

**Journal: every trade grouped by trade day, with origin, state, R and P&L** · Desktop 1440×1000 · light theme

![Journal: every trade grouped by trade day, with origin, state, R and P&L](journal-desktop.png)

**Journal: every trade grouped by trade day, with origin, state, R and P&L** · Phone 393×852 · light theme

![Journal: every trade grouped by trade day, with origin, state, R and P&L](journal-mobile.png)

**EDGE: headline statistics with sample caveat, money per currency and charts** · Desktop 1440×1000 · light theme

![EDGE: headline statistics with sample caveat, money per currency and charts](edge-desktop.png)

**EDGE calendar: a day opens the trades closed on it** · Desktop 1440×1000 · light theme

![EDGE calendar: a day opens the trades closed on it](edge-calendar-day-desktop.png)

**Evidence viewer: full screenshot with label, timing band and recorded time** · Desktop 1440×1000 · light theme

![Evidence viewer: full screenshot with label, timing band and recorded time](evidence-viewer-desktop.png)

## Trading accounts

**Accounts: each account in its own currency; totals only within one currency; R per-trade units** · Desktop 1440×1000 · light theme

![Accounts: each account in its own currency; totals only within one currency; R per-trade units](accounts-desktop.png)

**Account dashboard: values, results, charts, calendar and risk-plan history of one account** · Desktop 1440×1000 · light theme · whole page

![Account dashboard: values, results, charts, calendar and risk-plan history of one account](account-dashboard-desktop.png)

**Manage account: risk policy versions (scheduled version starts tomorrow)** · Desktop 1440×1000 · light theme · whole page

![Manage account: risk policy versions (scheduled version starts tomorrow)](account-manage-risk-policy-desktop.png)

## Review and AI (local mock provider)

**Review workspace · Weekly Review: concise default card, with friendly source chips** · Desktop 1440×1000 · light theme

![Review workspace · Weekly Review: concise default card, with friendly source chips](review-weekly-concise-desktop.png)

**Analyze Setup: concise default card led by the Risk Engine line, with friendly source chips** · Desktop 1440×1000 · light theme

![Analyze Setup: concise default card led by the Risk Engine line, with friendly source chips](ai-analyze-setup-concise-desktop.png)

**Review Trade: concise default card, with friendly source chips** · Desktop 1440×1000 · light theme

![Review Trade: concise default card, with friendly source chips](ai-review-trade-concise-desktop.png)

**Review Trade: full analysis side sheet with every section and citation** · Desktop 1440×1000 · light theme

![Review Trade: full analysis side sheet with every section and citation](ai-review-trade-full-desktop.png)

**AI failure: held reservation reported honestly; the account's AI pauses for review** · Desktop 1440×1000 · light theme

![AI failure: held reservation reported honestly; the account's AI pauses for review](ai-failure-accounting-desktop.png)

## Settings and keyboard

**Settings: general, AI budgets per account, connections, data, security, danger zone, developer** · Desktop 1440×1000 · light theme · whole page

![Settings: general, AI budgets per account, connections, data, security, danger zone, developer](settings-desktop.png)

**Command palette (Ctrl+K): actions, navigation, accounts and trades** · Desktop 1440×1000 · light theme

![Command palette (Ctrl+K): actions, navigation, accounts and trades](command-palette-desktop.png)

## Dark theme

**Dark theme: /today** · Desktop 1440×1000 · dark theme

![Dark theme: /today](today-desktop-dark.png)

**Dark theme: /trades** · Phone 393×852 · dark theme

![Dark theme: /trades](trade-live-mobile-dark.png)

**Dark theme: /edge** · Desktop 1440×1000 · dark theme

![Dark theme: /edge](edge-desktop-dark.png)

29 images, each under 480 KB (PNG). The run's full evidence (every step's screenshots, results.json and summary.md) stays in the git-ignored `.local/acceptance/<run-id>/`.
