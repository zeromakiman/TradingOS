# Trading OS

Private trading-process workstation: Today, deterministic planning and locking, private screenshots, an append-only Journal, full-position outcomes, and EDGE analytics/CSV. Next.js 16.3.4, React 19, strict TypeScript, Supabase Auth/PostgreSQL/Storage.

**AI remains disabled (`AI_ENABLED=false`). No OpenAI key or billing is required for normal usage.** The Astra provider, evaluator prompt/schema, migrations, and failed evaluation history remain preserved. No broker connection exists.

The pre-deployment audit includes **325 passing tests** (all original 298 plus 27 regressions), production-mode acceptance, two-user isolation, and real concurrency checks. See [audit findings and readiness](docs/PREDEPLOY_AUDIT.md) and [deployment/recovery instructions](docs/DEPLOYMENT.md). Deployment has not been performed.

## Local setup

Use **Node.js 24.x** and **pnpm 11.19.0**, pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
```

Copy `.env.example` to `.env.local`. Configure the Supabase URL, publishable key, and server-only secret key. Leave `AI_ENABLED=false` and `OPENAI_API_KEY` empty or omitted. Public configuration is needed at build time; restart/rebuild after changes.

For a fresh Supabase project, apply migrations **0001 through 0007 in order, once**. The existing Trading OS project already has all seven; do not rerun them or the older `docs/AI_INSTALL.sql` bundle. Follow the runbook's migration procedure.

Keep public signup disabled. Provision a confirmed application user through Supabase Authentication → Users, then sign in with that email/password. Supabase dashboard login and application login are separate. Normal application setup requires no machine-specific credential file.

```sh
pnpm dev
```

Open [Trading OS locally](http://127.0.0.1:3000/today). For production mode, stop the development server, run `pnpm build`, then `pnpm start`. The server needs network access to Supabase.

## Validation

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Tests install migrations in an isolated in-memory database and mock provider transport. A global test guard blocks OpenAI hosts. No external credentials or paid API requests are needed.

Optional live acceptance scripts create permanent **synthetic** history in isolated test accounts. They require a running local server, Supabase configuration, and the ignored `.local/integration-users.json` documented in the runbook. Broader legacy scripts also depend on existing synthetic fixtures; none are normal setup dependencies. Run lock acceptance outside Dead Pool using the real database clock. Do not run the opt-in paid AI acceptance script during AI-disabled development.

## Daily flow and limits

1. Sign in and choose/create a demo account. Record current balance/equity in Settings.
2. Prepare a plan; confirm contract specifications and news context. Run risk check, then lock an approved plan. Saving a screenshot proposal does not reserve a slot.
3. Add private screenshots. AI shows its disabled state; all original and failed evaluation history stays preserved.
4. Record actual entry, full exit and total fees in Journal. Append observations/tag revisions. Completed outcomes appear in EDGE and filtered CSV.

- Defaults: maximum 0.50% risk, two daily reserved slots, minimum 3R. Monetary risk/loss caps need explicit configuration.
- Strategy time is **fixed UTC−05:00**. Dead Pool is 12:00–18:00 strategy time (17:00–23:00 UTC), independent of local daylight saving.
- Skip/cancel preserves original reservations. Actual fills do not rewrite plans. Realized R uses net actual P&L divided by original locked risk.
- Account values, news and specifications are manual. Seeded instruments are USD-quoted EURUSD/GBPUSD demo contracts. No market feed, calendar, broker execution, or partial-position accounting is connected.
- Back up the database **and screenshot object bytes**. CSV only covers filtered completed outcomes. Follow [recovery guidance](docs/DEPLOYMENT.md#backup-and-recovery) before relying on long-term history.

Earlier phase reports are dated historical evidence. The pre-deployment audit and runbook describe the current state.

