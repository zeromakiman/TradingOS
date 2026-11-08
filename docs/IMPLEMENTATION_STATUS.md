# Implementation status

## Current: Trading OS V2 (branch `ui/claude-v2`)

V2 is implemented on this branch and is in integration and verification; it has **not been deployed**, and it awaits an
independent audit before any real-provider AI acceptance. Design: [V2_ARCHITECTURE.md](V2_ARCHITECTURE.md). Deployment
and migrations: [DEPLOYMENT.md](DEPLOYMENT.md). Overview and local setup: [README.md](../README.md).

- **Database**: migrations 0015–0019 (canonical trades and backfill, Risk Engine report 1.2 with daily usage, platform
  connections, AI on trade evidence and the timeline-aware review, account erasure and privilege hygiene). 0001–0014
  are unchanged.
- **Domain**: trade lifecycle and next actions, timing classification (Before entry / While live / After close) and
  timeline assembly, exact formatting, risk explanations, daily status, performance and account metrics, plan vs
  reality, AI summaries and source chips, strategy card, sync normalisation and matching.
- **Screens**: Today, Plan Trade and Edit Draft, Record Live Trade, the trade workspace (plan, execution, live journal,
  evidence, result, review, AI), Journal, EDGE with calendar and drill-downs, Accounts with dashboards and management,
  Review with periodic AI reviews and history, Settings (theme and time display, AI, connections, export, security,
  account deletion, developer), sign-in pages, legacy V1 redirects.
- **AI**: off by default; verified locally with a mock provider only (no paid calls). Real-provider acceptance follows
  the independent audit.
- **Not in V2**: real broker or platform connectivity (cTrader in V2.1, MetaTrader in V2.2; V2 has the connection model
  and a mock provider), market data, multi-leg (partial-position) accounting, outcome amendments. Partial closes are
  journal records; the close still records one exit price, which the close form works out from the partial closes
  journaled while the trade was live when each has a price and an amount (V2_ARCHITECTURE.md §3.6).
- **Known gaps for V2.1**: [V2_1_GAPS.md](V2_1_GAPS.md) (held or unlinked platform executions and daily limits, imported
  trades without a contract, accounts above 20,000 trades and chart payloads of large histories, ledger reads ordered
  by computed columns).

The final V2 report and its verification records are added when verification completes.

## Historical: V1 (EDGE V1 milestone)

The following describes the V1 state at the EDGE V1 milestone and is kept as a dated record. It is superseded by V2.

EDGE V1 is implemented. Open http://127.0.0.1:3000/edge after signing in.

- Journal: explicit execution/closing flow, deterministic net realized R, completed-status filter, original plan and complete event history, manual structured tags.
- EDGE: core metrics, equity curve, sample labels, original version/model/session/weekday/order/after-outcome comparisons, shared filters and CSV export.
- Migration 0006 is installed. Previous migrations and AI history are preserved.
- AI remains off (`AI_ENABLED=false`); no OpenAI key is required for normal use and no live OpenAI calls occurred.
- 265 tests, lint, strict TypeScript and production build pass; ten dedicated-user live checks pass.

See [EDGE_V1_REVIEW.md](EDGE_V1_REVIEW.md) for formulas, data-model review, methodology, evidence and limitations, and [EDGE_LIVE_VERIFICATION.json](EDGE_LIVE_VERIFICATION.json) for live acceptance results.

Deferred at that time: broker execution/reconciliation, partial/multi-leg accounting, outcome amendments, MFE/MAE from market data, reliable percentage equity drawdown, and Review/experiments.
