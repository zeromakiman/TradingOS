# Trading OS

A private trading workstation and live decision journal. The central object is the **Trade and its decision
history**: the plan written before entry, the deterministic risk check, the locked plan, what happened while the
position was live, the close and the review. "Simple on the surface, rigorous underneath."

Next.js 16.3.4 (App Router), React 19.2, strict TypeScript 7, Tailwind CSS 4, radix-ui, Supabase (Auth, PostgreSQL
with RLS and PostgREST RPCs, private Storage), Vitest 5, Biome 2.5. No broker connection exists: Trading OS records
plans, decisions and results and never places or changes a trade.

**This branch (`ui/claude-v2`) is Trading OS V2.** The authoritative design is
[docs/V2_ARCHITECTURE.md](docs/V2_ARCHITECTURE.md); deployment, migrations and rollback are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md); the deterministic risk engine is specified in
[docs/RISK_ENGINE.md](docs/RISK_ENGINE.md); known gaps planned for V2.1 are in [docs/V2_1_GAPS.md](docs/V2_1_GAPS.md).
V1 documents and verification records under `docs/` are kept as dated historical evidence.

## What V2 is

- **Trades with a lifecycle**, derived and never stored as a mutable status: Draft (Blocked / Ready to lock /
  Recheck needed) → Locked → Live → Closed → Reviewed, plus Skipped, Cancelled and Discarded. Origins: Planned,
  Live-first ("No pre-trade plan was recorded before execution.") and Imported (mock platform sync in V2).
- **Editable drafts** (every save is a new revision), a free deterministic risk check with exact blocking reasons, and
  **immutable locked plans**. The SQL Risk Engine decides at lock; the TypeScript preview mirrors it byte for byte.
- **Live journal**: timestamped notes, decisions, stop/target changes, partial closes and lessons on the trade page,
  with screenshots pasted (Ctrl/⌘+V), dropped or picked. Every item is classified Before entry / While live / After
  close from server time, so a post-trade note can never pass for pre-entry evidence.
- **Trading Accounts** as first-class records, with **All Accounts** as an aggregation context (never a fake account):
  R statistics combine across accounts, money stays per currency and is never converted.
- **Analytics**: Journal (filters, search, keyset paging), EDGE (headline statistics, cumulative R, drawdown, daily
  results, calendar, R distribution, breakdowns with drill-down), account dashboards. Small samples are labelled.
- **Advisory AI** (Analyze Setup, Challenge My Bias, timeline-aware Review Trade, Weekly / Recent / Monthly reviews)
  with concise cards, friendly source chips, strict citation validation and per-account budgets. AI never overrides a
  BLOCKED verdict and is never the default next action.
- **Data rights**: Export my data (a ZIP assembled in the browser from RLS-scoped reads) and Delete Trading OS
  account (typed DELETE and password re-entry, then one atomic purge run by the trusted server).

## Information architecture

| Area | Route | Purpose |
|---|---|---|
| Today | `/today` | Session ribbon, trading status per account, live trades, plans waiting, today's closed trades |
| Plan Trade | `/trades/new` | Draft with the live risk preview; Save draft runs the free server check |
| Record Live Trade | `/trades/live/new` | Minimal live-first form; "Earlier" entry times are typed in strategy time (UTC−5) |
| Trade | `/trades/[id]`, `/trades/[id]/edit` | Plan, execution, live journal, evidence, result, review, AI, technical details |
| Journal | `/journal` | Every trade, grouped by trade date, with filters and search |
| EDGE | `/edge` | Statistics, charts, calendar and breakdowns; every mark drills down to its trades |
| Accounts | `/accounts`, `/accounts/new`, `/accounts/[id]`, `/accounts/[id]/manage` | Account workspace, dashboards, profile, values, external losses, risk policy, instruments, connection |
| Review | `/review/weekly`, `/review/recent`, `/review/monthly`, `/review/history` | Periodic AI reviews per account and AI history |
| Settings | `/settings` | Theme and time display, AI, connections, export, security, danger zone, developer |
| Sign-in | `/login`, `/forgot-password`, `/update-password` | Public pages (invitation-only access) |

The header always shows the **Trading Account** context, the strategy clock (fixed UTC−5), Search (Ctrl/⌘+K) and the
two primary actions **Plan Trade** and **Record Live Trade**; phones get a bottom tab bar (Today · Journal · + ·
Accounts · More). A URL with `?account=all|<id>` switches the context when it is opened (prefetches never do). V1
routes (`/analyze`, `/journal/[id]`, `/edge/weekly|recent|monthly`, `/preview`) redirect to their V2 pages, and V1
bookmarks of `/journal` and `/edge` keep their filters.

## Local development

Use **Node.js 24.x** and **pnpm 11.19.0** (pinned in `package.json`; `npx pnpm@11.19.0 …` works without a global
install). Development runs against a local Supabase-compatible stack with **synthetic users only**; it never contacts a
hosted project.

```sh
npx pnpm@11.19.0 install --frozen-lockfile
node scripts/local-stack/start.mjs     # PostgreSQL + PostgREST + auth/storage gateway; applies migrations 0001–0019
node scripts/local-stack/env.mjs       # .env.local -> the local gateway, AI_ENABLED=false
node scripts/local-stack/seed-v2.mjs   # synthetic users with three accounts, ~93 trades, screenshots, journal, AI history
npx pnpm@11.19.0 dev                   # http://127.0.0.1:3000/login
```

Credentials of the seeded users are written to the git-ignored `.local/seed-v2-users.json`. `next dev` rewrites the
tracked `next-env.d.ts`; restore it before committing. Everything else (ports, files, the emulated APIs, known
differences from hosted Supabase) is in [scripts/local-stack/README.md](scripts/local-stack/README.md).

### Screenshots and browser acceptance

```sh
node scripts/local-stack/screenshot.mjs --user=<seeded email> --out=.local/screenshots/v2 today journal edge @todayBlocked
node scripts/local-stack/screenshot.mjs --user=<seeded email> --out=.local/screenshots/v2 --viewport=393x852 --theme=dark today
npx pnpm@11.19.0 run acceptance        # scripted V2 acceptance (planned, live-first, analytics, accounts, AI, settings, UX)
```

`@name` stands for the seeded showcase trades and accounts (`@todayBlocked`, `@ftmo/manage`, …). From Git Bash pass
app paths without a leading slash (or set `MSYS_NO_PATHCONV=1`).

### AI without a provider (local mock)

AI is off unless `AI_ENABLED=true`. For local acceptance of the AI flows, `scripts/local-stack/mock-openai.mjs` is a
Node preload that answers the two OpenAI calls the app makes with deterministic, schema-valid output: zero network,
zero cost. It fails closed: the server does not start with a key that is not an `sk-local-mock…` key or on Vercel, and
no request to OpenAI is ever forwarded.

```sh
AI_ENABLED=true OPENAI_API_KEY=sk-local-mock-local MOCK_OPENAI=1 TRADING_OS_ENABLE_MOCK_SYNC=true \
  NODE_OPTIONS="--import=./scripts/local-stack/mock-openai.mjs" npx pnpm@11.19.0 dev
```

Each Node process prints `[mock-openai] active (pid …)`; without that line the mock is not loaded, so stop the server.
Never use the mock, a real key, or `TRADING_OS_ENABLE_MOCK_SYNC` on Vercel Preview or production. The reviewed AI
pricing (`src/ai/pricing.ts`, gpt-5.4-mini) is valid until 2026-11-12 00:00 UTC; from then on every AI request is
refused, mock or not, until the pricing is reviewed.

## Scripts and tests

| Command | What it does |
|---|---|
| `npx pnpm@11.19.0 dev` | Development server on 127.0.0.1:3000 |
| `npx pnpm@11.19.0 lint` | Biome over `src`, `tests`, `scripts` (warnings fail), then the unused-export check below |
| `npx pnpm@11.19.0 typecheck` | `tsc --noEmit` |
| `npx pnpm@11.19.0 test` | Vitest: domain, engine parity (TypeScript ↔ SQL), database (PGlite applies every migration), actions, routes, UI (server-rendered markup) |
| `npx pnpm@11.19.0 build` | Production build |
| `npx pnpm@11.19.0 run acceptance` | Browser acceptance against the running local app |
| `node scripts/check-unused-exports.mjs` | Dead-code check: every exported value under `src/` needs a caller in the app or the scripts (tests never count; deliberate exceptions are listed with a reason in its `KEPT`, and an entry that no longer applies fails). Callers are resolved per module (imports, namespaces, re-exports, and the modules the seed loads by path), so a same-named identifier elsewhere does not count. Part of `lint`; `tests/v2-unused-exports.test.ts` also runs it with the suite |
| `npx pnpm@11.19.0 check` | lint, typecheck, test and build in sequence |

Tests need no credentials and never call a paid provider: `tests/no-live-ai.ts` blocks OpenAI hosts for the whole
suite, and AI tests use mocked transports and fixtures. Database tests run every migration in an in-memory PGlite
instance; `scripts/local-stack/` also verifies the migrations on real PostgreSQL 17.

## Deployment

Read [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) first. In short: apply migrations **0015–0019 in order** before deploying
V2 (until then every app page shows "Database update required" and nothing is written), keep `AI_ENABLED=false` on
Preview and production until real-provider acceptance after the independent audit, and never set
`TRADING_OS_ENABLE_MOCK_SYNC` outside local development. V2 has not been deployed.

## Principles that do not change

Deterministic risk authority (the SQL engine decides at lock; AI is advisory and never overrides BLOCKED), immutable
locked plans and append-only history, a fixed UTC−5 strategy clock, exact decimal arithmetic for money, prices and R,
owner RLS on every table, facts kept apart from interpretation, strict AI citation validation, AI cost controls, and
process quality measured separately from P&L.
