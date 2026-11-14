# Deployment, migration and recovery runbook (V2)

Status: **Trading OS V2 (branch `ui/claude-v2`) has not been deployed.** The private V1 production release and its
verified settings are recorded in [PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md) (historical). This runbook
describes what a V2 deployment needs; [V2_ARCHITECTURE.md](V2_ARCHITECTURE.md) is the design it implements.

Hard rules for every environment:

- **AI stays off on Vercel Preview and production (`AI_ENABLED=false`)** until the real-provider acceptance that
  follows the independent audit. V2 development and every automated test ran without a single paid AI call.
- **`TRADING_OS_ENABLE_MOCK_SYNC` is never set on Preview or production.** It enables a developer simulation of
  platform sync; production platform sync does not exist in V2. Before any real provider (cTrader, MT5) is accepted,
  the gap documented in [V2_1_GAPS.md](V2_1_GAPS.md) must be closed: the daily limits do not see platform executions
  that are held, unlinked or whose close was not recorded on a trade.
- Synthetic data only outside production. Never point a Preview at the production database, and never run test or
  acceptance scripts against a real account.
- Migrations are additive and applied once, in order. Never edit or re-run an applied file.
  V2 release note: 0015–0020 have so far been applied only to local development databases (0020, V2.1, lives on
  the `feature/v2-ui-improvements` branch only), and 0015 and 0017 were
  edited during development after such local applications (those databases were reset or patched to match; the
  committed files are final, and a fresh apply equals the patched catalog). No hosted database has applied any V2
  file. From the first hosted application on, the rule above holds and every change ships as a new migration.

## Architecture

```text
Browser (HttpOnly Supabase session and account-context cookies, Secure on HTTPS; display preference cookies)
  → HTTPS → Vercel / Next.js 16 (Node 24): proxy, server-rendered pages, server actions, route handlers
      proxy (src/proxy.ts): refreshes the session (getClaims), marks every response private/no-store,
                            redirects signed-out page requests to /login, applies ?account= (stored on page loads only)
      → Supabase Auth: verified user per request
      → PostgreSQL via PostgREST: owner RLS on every table, writes only through SECURITY DEFINER RPCs,
                                  immutability triggers, append-only history, the SQL Risk Engine decides at lock
      → private Storage: buckets `setup-screenshots` (V1) and `trade-evidence` (V2), validated server uploads,
                         reads through /api/evidence/[id] and /api/screenshots/[id] with the user's session
```

The service-role key is used only by the trusted server, for the complete list in V2_ARCHITECTURE.md §10.3: evidence
upload, registration, cleanup and duplicate copies; the AI ledger and AI start/authorize/finish RPCs; mock connection
ingest (developer mode, only when mock sync is enabled); the erasure purge (`purge_user_trading_data`, after the typed
DELETE and password re-entry), erasure storage deletion and `auth.admin.deleteUser`. It never reaches the browser.
Every other read and write uses the signed-in user's session.

## Environment

| Variable | Where | Value / purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | all | Exact HTTPS project origin (`http://127.0.0.1:54321` only for the local stack). Build and runtime. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | all | The same project's `sb_publishable_…` key. Secret and service-role keys are rejected at startup. |
| `SUPABASE_SECRET_KEY` | server only | `sb_secret_…`. **Required in V2**: screenshot/evidence upload, AI accounting, and account deletion use it. Never `NEXT_PUBLIC_`. |
| `AI_ENABLED` | server | **`false` on Preview and production.** Only the literal `true` enables AI; per-account consent and budgets still apply. |
| `OPENAI_API_KEY` | server only | Omit while AI is off. |
| `OPENAI_SETUP_MODEL`, `OPENAI_SETUP_REASONING`, `OPENAI_SETUP_DEEP_REVIEW` | server | Optional overrides; a model or reasoning value that differs from the reviewed operation registry is refused. Unused while AI is off. |
| `TRADING_OS_ENABLE_MOCK_SYNC` | local only | `true` shows the mock platform sync in Settings → Developer. **Never on Preview or production.** |
| `MOCK_OPENAI`, `NODE_OPTIONS=--import=./scripts/local-stack/mock-openai.mjs` | local only | The local mock AI provider (scripts/local-stack/README.md). It refuses to start on Vercel or with a non-mock key. |
| `NODE_ENV`, `PORT` | platform | Managed by Next.js/Vercel. A production build answers 404 for the developer gallery `/dev/ui`. |

Checking an environment before a V2 deployment (Vercel CLI; the project has no Git integration):

```sh
vercel env ls preview       # AI_ENABLED must be false, TRADING_OS_ENABLE_MOCK_SYNC absent, no OPENAI_API_KEY
vercel env ls production
```

A Preview that was used for V1 AI acceptance may still have `AI_ENABLED=true` and a live key: set it to `false` and
remove the key before deploying V2 there.

## Migrations

| Migration | Purpose |
|---|---|
| 0001–0007 | V1 foundation: immutable records and owner RLS, risk evaluator, strategy/risk baseline, proposals and evidence, private screenshot bucket, outcomes and analytics, audit hardening |
| 0008–0014 | V1 AI: account budgets and reservations, trade reviews, pre-lock challenges, weekly/recent/monthly reviews, uncertainty resolution |
| **0015_canonical_trades** | The Trade model: `trades`, draft `trade_revisions`, plan links, lifecycle events, live-first position facts and unplanned closes, live journal entries, V2 evidence (`trade_evidence`, removals, labels; private `trade-evidence` bucket and policies), tag sets, external losses, trading-account profiles and instrument versions, versioned risk policy (`create_risk_policy_version`), the `trade_ledger` view (one row per trade, lifecycle derived), the planned and live-first RPCs (which delegate every risk, lock, fill and outcome decision to the V1 functions), `private.active_risk_plan` (risk-plan precedence), an insert-only backfill of every V1 plan and unlocked proposal into a planned trade, and the schema marker `trading_os_schema()`. Also: the deferred `plan_requires_trade` check (an API request that locks a plan without linking it to a trade rolls back with `PLAN_WITHOUT_TRADE`), V1 `save_setup_proposal`, `check_setup_risk`, `save_daily_context` and `set_account_ai_preferences` refusing archived accounts (AI can still be turned off; `check_setup_risk` also refuses a NULL `p_lock`), duplicates moved to the account's current contract version, and stop/target/partial-close journal entries only while the trade is live (`ENTRY_NOT_LIVE`) |
| **0016_risk_engine_usage** | Risk Engine 1.1 with report 1.2: `private.daily_usage` and `get_daily_risk_usage` (planned and live-first slots and risk, realized and external losses, open exposure), `private.risk_report_v12`; every engine path evaluates with the active risk plan and today's usage. Stored 1.0/1.1 reports keep their meaning |
| **0017_platform_connections** | Connection-ready, read-only platform model: connections, external executions deduplicated by `(connection_id, external_id)`, appended closes, connection events, append-only trade/execution links, overview views. Only the MOCK provider is accepted; ingest is service-only; a plan with a linked position cannot be skipped or cancelled (`linked_disposition_guard`) |
| **0018_trade_ai_timeline** | AI on V2 drafts (latest revision only, V2 evidence), the timeline-aware trade review (`trade_timeline_reviews`, results, service-only RPCs, the `trade_ai_activity` view, AI review counts in `trade_ledger`), periodic reviews accepting the compact V2 facts, and the zero-cost release of dispatched AI requests that never reached the provider (`ai_request_generations` records the generation commit; SQL then refuses a release) |
| **0019_account_erasure** | Owner-requested erasure (`purge_user_trading_data(p_user_id, p_confirm)`: executable by `service_role` only, called by the trusted server after the typed DELETE and password re-entry, so no user token can call it; one transaction, no AI request in flight, catalog-driven delete order, completeness check, de-identified receipt); statement-level TRUNCATE guards; service-role DML revoked except inserts on `setup_evaluation_passes` and `evaluator_versions` (V2 registers no legacy `setup_screenshots`); foreign-key lookup indexes; the V1 entry points that could bypass the trade model (`lock_trade_plan`, `evaluate_trade_plan`, `import_locked_setup`, `create_risk_version`, `record_observation`, `record_setup_decision`) revoked from `authenticated`. Last migration of V2.0 |
| **0020_trade_deletion_journal_models** (V2.1) | Deleted trades (`trash_trade`, `restore_trade`; hidden from every screen, still counted by `private.daily_usage`); `delete_trade_permanently` (typed `DELETE`, only from Deleted trades, refused while the trade counts toward the current strategy day's usage, has copies or an AI request of its account is in flight; AI spend records are never deleted) and `delete_trading_account` (typed name, every trade guard first, refused with AI history) through the owner-scoped `trading_os.delete_scope` flag; per-account custom models (`create_custom_model`, `revise_custom_model`, `delete_custom_model`, `set_trade_custom_model`) stored apart from the Risk Engine's `entry_model`; ledger columns `trashed_at`, `custom_model_id`, `custom_model_name`; schema marker `2.1`. Installs RLS, immutability and TRUNCATE triggers, FK indexes and revokes for its own tables; the erasure purge is unchanged and covers them. The trusted server removes a deleted trade's storage objects afterwards |

### Schema gate ("Database update required")

The app reads `public.trading_os_schema()` once per request. While it is missing (any database before 0015) or reports
a version older than `2.1`, every app page renders **"Database update required — this deployment expects Trading OS
database version 2.1. No changes were made."** with a sign-out button, and every V2 server action refuses to write.
Public pages still render. This keeps a V2 build that is pointed at an un-migrated database harmless.

The marker is created by 0015, so the gate distinguishes "before V2" from "V2", not each file: apply **0015 through 0019
together, in order, in one maintenance window**, before the V2 build serves traffic. A database stopped between 0015
and 0019 passes the gate but lacks the engine, connection, AI and erasure functions the app calls.

### Pre-deployment checks of the hosted project

V2 was verified on the local Supabase-compatible stack only. Before release, confirm on the hosted project (a staging
copy, with a synthetic user) what the local gateway emulates:

1. **Recovery sessions carry a timestamped `recovery` method in `amr`.** `/update-password` accepts only PKCE recovery
   links (`?code=`) and sets a new password only on a session whose `amr` claim has a `recovery` entry from the last 15
   minutes (V2_ARCHITECTURE.md §14.12, [PASSWORD_RECOVERY.md](PASSWORD_RECOVERY.md)). Request a recovery email, open
   its link and check that the form is offered and the password changes; if hosted GoTrue's PKCE exchange does not put
   `{method: "recovery", timestamp}` into `amr` (or an access-token hook rewrites it), every recovery is refused.
2. **PostgREST 11 or later.** Today and the command palette find open trades with anti-joins (`is.null` on an embedded
   resource: `trade_outcomes=is.null`, `trade_unplanned_closes=is.null`; V2_ARCHITECTURE.md §13.3), which older
   PostgREST versions reject. The local stack runs v13.0.8.

### Procedure

1. Back up the database **and both storage buckets** (see below); keep the copy off the project.
2. Compare the project's migration ledger with `supabase/migrations/`; files already applied are never re-run.
3. Rehearse on a separate restored copy (or the local stack: `node scripts/local-stack/reset.mjs --through=0014`, seed
   V1 data, then `start.mjs`): apply 0015–0020 in order, then run the app and the acceptance checks.
4. Apply 0015, 0016, 0017, 0018, 0019 and 0020 in order through a migration workflow that records the ledger. Each file ends
   with `notify pgrst, 'reload schema'`.
5. Verify: `select public.trading_os_schema()` returns `2.1`; the RLS/grants catalogue (`tests/v2-schema-catalog.test.ts`
   describes the expectations); the `trade-evidence` bucket is private; anonymous requests see no table; the
   pre-deployment checks above pass.
6. Deploy the V2 build with the environment above. Sign in with a synthetic test user on staging and run the smoke
   path: Today, Plan Trade → check → lock → entry → close → review, Record Live Trade → note → screenshot → close,
   Journal, EDGE, account dashboard, Settings → Export my data.

### Rollback

- **App**: redeploy the previous V2 build; schema changes are additive, so older V2 builds keep working.
- **Back to the V1 app**: not supported once 0019 is applied. 0019 revokes the V1 lock/evaluate/observation entry points
  from `authenticated`, so the V1 UI can no longer lock plans or record values; V2 also removed the V1 pages.
- **Schema**: there are no down migrations, and history is never rewritten. Repair forward with a new additive migration
  (0020+). Restoring the pre-migration backup is the last resort and loses everything recorded after it.

## Authentication URLs

For `https://<your-exact-domain>`: set Supabase **Site URL** to that origin; allow exactly
`https://<your-exact-domain>/update-password` for password recovery (see [PASSWORD_RECOVERY.md](PASSWORD_RECOVERY.md));
keep `http://127.0.0.1:3000/...` only for local development; avoid wildcards. Sign-in is password-based through a server
action; there is no OAuth, magic link or `/auth/callback`. Keep **Allow new users to sign up** disabled and provision
confirmed users in the dashboard. `/update-password` accepts only PKCE recovery links (`?code=`) and sets a new password
only on a session whose `amr` claim has a `recovery` entry from the last 15 minutes; verify on the hosted project that
a recovery link's session carries it (PASSWORD_RECOVERY.md; pre-deployment check 1 above) before release.

Changing the password (Settings → Security) verifies the current password with a separate sign-in, sets the new one on
that freshly verified session, keeps this browser signed in with it, and signs out every other session.

## Backup and recovery

Database backups do not include Storage object bytes. Keep encrypted, dated, off-host copies of:

- the database (schema, migration ledger, all rows including immutable versions, events and AI history);
- every object in `setup-screenshots` (V1) **and** `trade-evidence` (V2), with bucket and path, and the bucket policies;
- the source release, lockfile and deployment settings (credentials stored separately).

Back up before applying migrations and after active trading days. Settings → Export my data gives each user a ZIP of
their own records and screenshots (checked against recorded SHA-256 fingerprints); it is a personal copy, not a
database backup. Rehearse restores into a separate project; never test a restore over the only live project.

## Operational notes

- Every response is `private, no-store`. The Supabase session cookies are HttpOnly and SameSite=Lax; no browser code
  creates a Supabase client or reads them. The account context lives in HttpOnly cookies (`tos_account`,
  `tos_last_account`); theme, time display, sidebar and developer mode in preference cookies. Session and context
  cookies are Secure when the request came over HTTPS: the URL protocol in the proxy; the Origin header, else
  X-Forwarded-Proto, in server actions (`src/lib/cookie-security.ts`). `?account=` stores the context only on a page
  load; client-side navigations store it through the shell, and prefetches never do. Sign-out, password reset and
  account deletion remove both context cookies; a sign-in (password, or a recovery link) keeps only All Accounts and the
  signed-in person's own account ids, so a shared browser never carries the previous person's accounts.
- Unknown, foreign and malformed trade or account ids render the not-found state inside the app shell. Because those
  pages stream a loading skeleton first, the HTTP status is 200 with `noindex` (a "soft 404"; Next.js commits the
  status before a streamed page can call `notFound()`); nothing about the record is revealed (the page for another
  user's id is identical to the page for an id that does not exist, apart from the request id and server time). The
  skeletons are kept on purpose: a real 404 would cost either the instant skeleton on every trade and account
  navigation or an extra ownership query in the proxy before every such page load, for an app that is private and
  `noindex` anyway. Addresses that match no route answer 404 with the styled root not-found page, and signed-out
  requests for app pages go to sign-in. Legacy V1 addresses answer with real 307 redirects (an unknown legacy id with a
  real 404).
- Signing out, by any path, and deleting the account forget the browser tab's unsaved Plan Trade, Record Live Trade and
  Edit Draft entries and the command palette's recent entries, so a shared browser never shows them to the next person.
- Logs use fixed operational event names without tokens, passwords, request bodies or raw provider/database errors.
- Screenshots are capped at 4 MB each (PNG, JPEG, WEBP), 24 per trade, within Vercel's request limits.
- Strategy time is fixed UTC−5 (no daylight saving); Dead Pool is 12:00–18:00 strategy time.
