# Local Supabase-compatible stack

A reproducible, loopback-only stand-in for the hosted Supabase project, so the real app can be run
and browser-tested end to end with **synthetic data only**. Nothing here contacts a hosted Supabase
project or OpenAI: keys are generated locally, users are `@example.test`, and `AI_ENABLED=false`.

```
Browser ──► Next.js app :3000 ──► gateway :54321 ──┬─► /rest/v1    ─► PostgREST :54330 ─┐
                                    (Node)          ├─► /auth/v1    ─► GoTrue emulation ──┼─► PostgreSQL 17 :54322
                                                    └─► /storage/v1 ─► Storage emulation ─┘   (.local/pgdata)
                                                                        └─ bytes in .local/storage/{bucket}/{path}
```

Everything the stack creates lives under the git-ignored `.local/` folder (plus the git-ignored
`.env.local`). The only tracked files are the ones in this directory.

## Prerequisites

- Windows 10/11 x64 with Node.js 24 (`node`, bundled `npm`) and the repo installed (`npx pnpm@11.19.0 install --frozen-lockfile`).
- Network access on first run: EDB PostgreSQL 17.6 Windows binaries (~330 MB zip, pinned SHA-256),
  PostgREST v13.0.8 (~15 MB, pinned SHA-256), and npm packages `pg` + `playwright-core` installed into
  the isolated `.local/tools` package (the repository `package.json`/lockfile are never touched).
- Microsoft Visual C++ 2015-2022 runtime (normally present; otherwise the copy inside the EDB archive is used).
- Microsoft Edge or Google Chrome installed (browser smoke test only).
- Not required: Docker, Supabase CLI, a separately installed `psql`.

## Quick start

```sh
node scripts/local-stack/start.mjs            # download/init if needed, apply migrations, start services
node scripts/local-stack/provision-users.mjs  # v2.owner@example.test + v2.other@example.test
node scripts/local-stack/env.mjs              # .env.local -> local gateway, AI_ENABLED=false
node scripts/local-stack/verify.mjs           # optional API conformance checks (auth/REST/storage/RLS/erasure privilege)
node scripts/local-stack/seed-v2.mjs          # optional V2 dataset (see "V2 dataset & screenshots")
node scripts/local-stack/stop.mjs             # stops everything (PostgreSQL included)
node scripts/local-stack/status.mjs           # confirm "Stack status: stopped"
```

To use the app manually after `start.mjs` + `env.mjs`: `npx pnpm@11.19.0 dev`, open
<http://127.0.0.1:3000/login> and sign in with a user from `.local/integration-users.json` (empty) or
`.local/seed-v2-users.json` (seeded). The V2 browser acceptance is `acceptance/run.mjs` (see "Browser acceptance").

## Commands

| Command | Purpose |
|---|---|
| `start.mjs [--restart] [--through=NNNN]` | Idempotent start: binaries, `initdb`, PostgreSQL, bootstrap, pending migrations, PostgREST, gateway (detached, hidden; logs/pids in `.local/logs`, `.local/pids`). Re-running applies only new migrations and restarts PostgREST when the schema changed. `--restart` also restarts PostgREST and the gateway (after editing gateway code). `--through=0014` stops after that migration version. |
| `stop.mjs` | Stops the app (if started by the smoke test), gateway, PostgREST, then `pg_ctl stop -m fast`. |
| `status.mjs [--json]` | Component health, applied/pending migrations, anon-exposed public tables, users file and `.env.local` consistency. |
| `reset.mjs [--hard] [--through=NNNN]` | Drops and recreates the `postgres` database, wipes `.local/storage` and the local mailbox, re-applies bootstrap + migrations, restarts services and re-provisions the synthetic users if they existed. Keys stay the same. `--hard` deletes and re-initializes the whole cluster. |
| `provision-users.mjs` | Creates/repairs the two confirmed synthetic users through the gateway admin API and writes `.local/integration-users.json` (`{"project":"http://127.0.0.1:54321","users":[{id,email,password},…]}`, the format `scripts/verify-*.mjs` read). `users[0]` = owner, `users[1]` = other. |
| `env.mjs [--force]` | Writes `.env.local` with the gateway URL, local `sb_publishable_local_…` / `sb_secret_local_…` keys, `AI_ENABLED=false`. Refuses to replace an `.env.local` that points elsewhere unless `--force` (which first renames it to `.env.local.backup-<time>`). |
| `verify.mjs` | 10 API-level checks through `@supabase/supabase-js` with throwaway `verify-<run>-a/b@example.test` users: password sign-in and `getClaims`, refresh rotation, admin API, RPC + owner RLS, storage (service-role upload; legacy `setup_screenshots` registration is closed to the service role and done as superuser), storage guards, the user-delete FK, PKCE recovery, sign-out, and the erasure privilege (no user token, however fresh its sign-in, can call a purge RPC; the trusted server erases one user). |
| `browser-smoke.mjs [--browser=edge\|chrome] [--reuse-app] [--headed] [--record-values] [--desktop=WxH] [--mobile=WxH]` | **V1** UI smoke with playwright-core + installed Edge/Chrome (headless). It drives V1 pages and the V1 upload route that V2 replaced or removed, so it works only against a V1 build (`bc5441c`); V2 uses `acceptance/run.mjs`. See below. |

### Ports

| Port | Service |
|---|---|
| 54321 | Gateway (`NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`) |
| 54322 | PostgreSQL 17.6 (loopback only, SCRAM passwords) |
| 54330 / 54331 | PostgREST API / admin (`/ready`, `/live`) |
| 3000 | Next.js dev server (`next dev`, or the one `screenshot.mjs --start-app` / `browser-smoke.mjs` start) |

### Files

| Path | Content |
|---|---|
| `.local/stack.json` | Local secrets: Postgres superuser + `authenticator` passwords, HS256 JWT secret, publishable/secret keys. Generated once; reused by reset. |
| `.local/integration-users.json` | Synthetic user credentials (owner, other). |
| `.local/seed-v2-users.json` | Credentials and showcase ids of the users `seed-v2.mjs` seeded (and the acceptance runner's seeded users). |
| `.local/mock-openai-scenarios.json`, `.local/logs/mock-openai.log` | The local OpenAI mock's failure scenarios (optional) and its request log. |
| `.local/acceptance/<run-id>/` | Browser acceptance results, screenshots and downloads. |
| `.env.local` | App configuration written by `env.mjs`. |
| `.local/logs/` | `postgres.log`, `postgrest.log`, `gateway.log` (method, path, status - never query strings), `app.log`, `auth-mail.jsonl` (recovery "emails"). |
| `.local/pids/` | `postgrest.pid`, `gateway.pid`, `app.pid`. PostgreSQL uses `.local/pgdata/postmaster.pid`. |
| `.local/storage/{bucket}/{path}` | Object bytes (path segments percent-encoded where Windows forbids characters). |
| `.local/screenshots/` | `v1-*.png` and `v1-smoke-report.json` from the browser smoke. |
| `.local/pg`, `.local/postgrest`, `.local/tools`, `.local/downloads` | Binaries, isolated npm tools, cached archives. |

Connect with the bundled psql (password from `.local/stack.json` → `postgres.superuserPassword`):
`.local\pg\pgsql\bin\psql.exe -h 127.0.0.1 -p 54322 -U postgres -d postgres`.

## What is emulated

**Database bootstrap** (`bootstrap.sql`, applied once before the migrations): roles `anon`,
`authenticated`, `service_role` (BYPASSRLS), `authenticator` (LOGIN NOINHERIT, member of the three);
Supabase statement timeouts for `anon` (3s) / `authenticated` (8s); `extensions` schema with
pgcrypto and uuid-ossp; Supabase default privileges on `public` and `storage`; `auth` schema
(`users`, `identities`, `sessions`, `refresh_tokens`, `flow_state`, `one_time_tokens`) with
`auth.uid()`, `auth.role()`, `auth.email()`, `auth.jwt()` reading `request.jwt.claim.*` or
`request.jwt.claims`; `storage.buckets` / `storage.objects` (RLS enabled, `path_tokens`, helper
functions `storage.foldername/filename/extension`); the CLI-shaped ledger
`supabase_migrations.schema_migrations(version, statements, name)`.

**Migrations**: every `supabase/migrations/^\d+_[A-Za-z0-9_]+\.sql$` in lexical order, each in one
transaction together with its ledger row, through the EDB `psql` with `ON_ERROR_STOP=1`. Applied
versions are never re-run (a warning is printed if an applied file changed). New files (0015+) are
applied by the next `start.mjs`, which then restarts PostgREST so the schema cache is fresh
(`notify pgrst, 'reload schema'` inside migrations is harmless).

**REST** `/rest/v1/*` → PostgREST v13.0.8 (`db-schemas=public`, `db-anon-role=anon`,
`db-max-rows=1000` like Supabase, HS256 secret). Key translation as in the Supabase CLI gateway: an
`Authorization` header that is not `Bearer sb_…` (a user/role JWT) passes through; otherwise
`apikey=sb_publishable_local_…` → anon JWT, `apikey=sb_secret_local_…` → service_role JWT. A missing
or unknown apikey → 401 (`No API key found in request` / `Invalid API key`). All other headers
(Prefer, Range, Accept incl. `application/vnd.pgrst.object+json`, Content-Profile) and response
headers (Content-Range, …) pass through.

**Auth** `/auth/v1/*` (GoTrue-shaped JSON, `X-Supabase-Api-Version: 2024-01-01` error codes):
`POST /token?grant_type=password|refresh_token|pkce`, `GET/PUT /user` (password change with
`same_password` / `weak_password` errors; other sessions revoked), `POST /logout?scope=local|global|others`,
`POST /recover` (PKCE or implicit), `GET /verify` (recovery links), `POST /verify` (recovery
token), `GET /settings`, `GET /health`, `GET /.well-known/jwks.json` (empty: HS256, so auth-js
`getClaims()` validates through `GET /user`), `POST /signup` → `signup_disabled`. Admin (service
role only): `POST/GET /admin/users`, `GET/PUT/DELETE /admin/users/{id}` (DELETE fails with 500
`Database error deleting user` while public tables still reference the user, like a real FK),
`POST /admin/generate_link` (type `recovery`). Passwords use scrypt. Access tokens are HS256,
1 hour, with `sub`, `aud`, `role`, `email`, `session_id`, `aal`, `amr`, `is_anonymous`. As in GoTrue, the PKCE
exchange of a recovery link starts a session whose `amr` is `[{"method":"recovery","timestamp":…}]` (a password grant
gives `password`), and refreshes keep it; `/update-password` accepts a new password only on such a session from the
last 15 minutes (docs/PASSWORD_RECOVERY.md). Refresh tokens rotate, with GoTrue's 10-second replay tolerance and reuse
detection.

**Password recovery locally**: no email is sent. Each link is appended to
`.local/logs/auth-mail.jsonl` and the gateway log, and is available to scripts with the secret key:
`GET http://127.0.0.1:54321/auth/v1/__local/mailbox?email=<address>` (header `apikey: <secretKey>`).
Opening the link redirects to `redirect_to?code=…` (PKCE, as used by `@supabase/ssr`) on
`http://127.0.0.1:*` / `http://localhost:*` only; other targets fall back to `http://127.0.0.1:3000`.

**Storage** `/storage/v1/*`: upload `POST|PUT /object/{bucket}/{path}` (raw or multipart, `x-upsert`,
content type, bucket `file_size_limit` → 413, `allowed_mime_types` → 415, duplicate → 409),
download `GET|HEAD /object/{bucket}/{path}` and `/object/authenticated/…`, `/object/public/…` (public
buckets only), `GET /object/info/…`, `DELETE /object/{bucket}` (`{prefixes}`) and single delete,
`POST /object/list/{bucket}`, `POST /object/copy`, `POST /object/move`, signed URLs
(`POST /object/sign/{bucket}/{path}`, `POST /object/sign/{bucket}` with `paths`, `GET /object/sign/…?token=`),
buckets (`GET/POST /bucket`, `GET/PUT/DELETE /bucket/{id}`, `POST /bucket/{id}/empty`). Every object
operation runs as SQL on `storage.objects` in a transaction with `role` and `request.jwt.claims` set
to the caller (anon / authenticated / service_role, the last bypassing RLS as in Supabase), so the
policies from `0005_private_screenshot_storage.sql` decide access. Errors use Supabase Storage's
legacy shape: HTTP 400 with `{"statusCode":"404","code":"NoSuchKey","error":"not_found",…}`.

## Browser smoke test (V1 UI)

This is the smoke test of the V1 UI, kept for rehearsing a V1 build (for example before an upgrade, with
`reset.mjs --through=0014`). V2 redirects `/analyze` to Plan Trade and removed the V1 upload route
`/api/setups/[id]/screenshots`, so against the V2 app it fails at its Analyze step; the V2 browser checks are
`acceptance/run.mjs` and `screenshot.mjs` below.

`browser-smoke.mjs` starts `npx pnpm@11.19.0 dev` (detached; Supabase variables are passed
explicitly so the app can only reach the local gateway, and the repo's
`scripts/no-openai-network.mjs` preload blocks OpenAI requests), waits for `/login`, then with Edge
(default) or Chrome headless:

1. Desktop (1440×900): login → create a demo account if none → Today → Settings (records account
   values only when Today asks for them) → Analyze: EURUSD LONG, entry 1.10000, stop 1.09800, target
   1.10600, risk 0.5, contract confirmed → **Run risk check** → save proposal → upload a generated PNG
   through `/api/setups/[id]/screenshots` → **Recheck risk** → lock (skipped with the reason during
   Dead Pool 12:00-18:00 UTC−5, or when the check is blocked) → setup page → Journal → EDGE.
2. Mobile (390×844): the same pages.
3. Isolation: the second user gets 404 from `/api/screenshots/[id]`, the not-found page for the
   owner's proposal, and no object from Storage; anonymous `/api/screenshots/[id]` → 401.
4. Password recovery through the UI with a throwaway user (deleted afterwards): `/forgot-password`
   → link from the local mailbox → `/update-password` (PKCE code exchange) → sign in with the new password.

It then stops the app it started and restores tracked files that `next dev` rewrites
(`next-env.d.ts`). Output: `.local/screenshots/v1-*.png` and `v1-smoke-report.json` (steps, risk
decision, browser console errors, Next dev-overlay issues, OpenAI-guard result). Locks are permanent
and use the real clock: two locks per strategy day, and identical repeated proposals are blocked as
`DUPLICATE`; run `reset.mjs` for a clean slate.

## Known differences from hosted Supabase

- Gateway, GoTrue and Storage are small emulations of the endpoints this app uses, not the real
  services: no Realtime, Edge Functions, GraphQL, image transformations (`/render/image`), signed
  upload URLs, `list-v2`, resumable uploads, email OTP/magic links, OAuth, MFA, phone auth, CAPTCHA,
  email change, anonymous sign-in, or rate limits other than one recovery email per minute per user.
- HS256 JWTs signed with a shared secret (no asymmetric signing keys/JWKS). Access tokens stay valid
  for PostgREST until expiry after sign-out, exactly like Supabase; `GET /user` rejects them.
- Passwords are scrypt hashes (bcrypt rows inserted by hand cannot sign in).
- Migrations run as the cluster superuser `postgres` (hosted `postgres` is a non-superuser that owns
  the objects); SECURITY DEFINER functions therefore run as a superuser locally.
- `public` default privileges mirror Supabase (ALL to anon/authenticated/service_role); the repo
  migrations revoke/grant per object, and `status.mjs` reports any public table still granted to anon.
- PostgREST v13.0.8 (latest v13); the Supabase CLI currently pins v16.4 and the hosted version may
  differ. `LOCAL_STACK_POSTGREST_VERSION=v14.18` (or another release with a Windows zip) selects
  another version; non-pinned versions are downloaded without a checksum.
- Locale: builtin `C.UTF-8` collation (hosted uses `en_US.UTF-8`), so text ordering is by code point.
  Timezone is UTC like hosted.
- `storage.buckets`/`storage.objects` are owned by `postgres` and simplified (no versions/prefix tables).
  Bytes live on NTFS at `.local/storage/{bucket}/{path}`, so a key cannot also be a "folder" of another
  key (`a` and `a/b`), and keys differing only by letter case share one file. The app's
  `{user}/{proposal}/{image}` keys are unaffected.
- Recovery links never redirect to non-loopback origins. In production mode (`next start`) the app
  requests its hosted recovery URL, which the gateway replaces with `http://127.0.0.1:3000`.

## Repository scripts

`.local/integration-users.json` uses the format expected by `scripts/verify-*.mjs`. Several of those scripts write
reports to tracked `docs/*.json` files by default:

- `verify-audit-live.mjs [--users=<file>] [--out=<file>] [--ai-enabled]` and `verify-audit-flows.mjs [--users=<file>]
  [--out=<file>]` run on V2 data (a planned trade with its locked plan and a V2 screenshot of `users[1]`; seed it
  first). Point `--out` under `.local/` for local runs. `--ai-enabled` is for a server running AI (the local mock): the
  legacy evaluator route must then refuse a request without a valid body (the check requires status 400 with the route's
  exact error message) and create no evaluation, instead of answering DISABLED.
  Checks that need V1-only rows (legacy screenshots, failed evaluator history) print SKIPPED when the user has none.
- `verify-live.mjs` (`test:live`) is the V1 live check. It calls `lock_trade_plan` and `evaluate_trade_plan`, which
  0019 revokes from `authenticated`, and the unkeyed `append_plan_note(uuid,text)` that 0007 revoked, so it fails on a
  V2 database exactly as it would on the hosted project.

## Troubleshooting

- **`Port … is already in use`**: another process owns 54321/54322/54330/54331/3000. `status.mjs`
  shows whether it is managed by this stack; `stop.mjs` stops managed processes.
- **PostgreSQL does not start**: see `.local/logs/postgres.log` and `.local/logs/pg_ctl.log`. A
  missing `VCRUNTIME140.dll` means the Visual C++ runtime is absent.
- **PostgREST exits immediately**: see `.local/logs/postgrest.log`; it needs `libpq.dll` from
  `.local/pg/pgsql/bin` on PATH, which `start.mjs` provides.
- **`stack.json is missing but pgdata exists`**: the database password is unknown; run `reset.mjs --hard`.
- **`bootstrap.sql changed` warning**: run `reset.mjs` to rebuild with the new bootstrap.
- **Sign-in fails after a reset**: users are recreated with new passwords; use the refreshed
  `.local/integration-users.json` and sign in again (old cookies are invalid).
- **App shows "Supabase configuration is incomplete" or talks to the wrong project**: re-run
  `env.mjs`; `status.mjs` checks `.env.local` against `.local/stack.json`. Exported shell variables
  override `.env.local` for `npx pnpm dev` (the smoke test sets them explicitly).
- **Gateway errors**: `.local/logs/gateway.log`; set `LOCAL_STACK_DEBUG=1` for stack traces from the CLI scripts.
- **Downloads fail**: delete `.local/downloads/*.part` and retry; checksums are verified after download.

## V2 dataset & screenshots

Browser acceptance for V2 (docs/V2_ARCHITECTURE.md §16.2) needs realistic data and repeatable captures. Two scripts
provide them; both use the running local stack only and synthetic users only.

```sh
node scripts/local-stack/start.mjs              # stack up; applies 0015–0019 (schema 2.0)
node scripts/local-stack/seed-v2.mjs            # v2.trader.a@example.test + v2.trader.b@example.test
node scripts/local-stack/screenshot.mjs --start-app --user=v2.trader.a@example.test --out=.local/screenshots/v2 login today journal edge dev/ui
node scripts/local-stack/screenshot.mjs --start-app --user=v2.trader.a@example.test --out=.local/screenshots/v2 --viewport=393x852 --theme=dark today
node scripts/local-stack/screenshot.mjs --start-app --user=v2.trader.a@example.test --out=.local/screenshots/v2 @todayBlocked @backdatedEntry @ftmo/manage
node scripts/local-stack/stop.mjs               # gateway, PostgREST, PostgreSQL
```

`--start-app` starts the app for that run exactly like `browser-smoke.mjs` (the local Supabase variables passed
explicitly, `AI_ENABLED=false`, the `no-openai-network` preload), stops it afterwards, and puts back the tracked files
`next dev` rewrites (`next-env.d.ts` then points at `.next/dev/types`), also when the run fails or is stopped with Ctrl+C.
Put all the paths of one viewport and theme into one run: each run starts the dev server once (the first request to
each route compiles it). `status.mjs` should report `Stack status: stopped` at the end.

Running `npx pnpm@11.19.0 dev` by hand instead (screenshot.mjs then captures from it) loses those protections: the app
reads `.env.local` and any exported variables, and `next dev` leaves the tracked `next-env.d.ts` modified. Restore it
before committing (`git checkout -- next-env.d.ts`); screenshot.mjs prints a note while it is in the rewritten form.

### `seed-v2.mjs [--users=a@example.test,b@example.test] [--reset-users]`

Creates (admin API) confirmed users at reserved domains only (`example.test`, `*.test`, …), signs in with the password
grant and gives each a deterministic dataset (variant = position in `--users`; same variant and day, same data):

| Account | Profile | Contents |
|---|---|---|
| FTMO 100K | USD · Evaluation · MT5 · broker FTMO | EURUSD, GBPUSD, XAUUSD, US100; Risk Plan V1.0 → V1.1 (scheduled, 3 trades/day, daily caps) → V1.2 today (immediate tightening, with reason) → V1.3 (starts tomorrow) |
| Personal 12K | EUR · Personal · cTrader | DE40, FRA40 (EUR contracts); V1.1 immediate risk cut after three DE40 losses; today a new DE40 version (0.01-lot steps) and EU50 via `create_instrument_version`; broker set through a profile revision |
| Demo 100K | USD · Demo · Manual | EURUSD, GBPUSD; V1.1 with minimum RR 2.5 as a warning |

About 90 days of weekday history: ~76 closed trades (≈40% winners, OB first touch and OTE, wins at target and partial,
losses incl. stop slippage, break-evens, 4 oversized fills, revised drafts whose first revision was blocked, skipped and
cancelled plans, discarded drafts), 16 live-first trades (risk basis reported, derived, completed later, unknown entry
time, symbol-only with reported P&L; 5 closed without R), ~210 journal entries in every timing band (one note recorded
after a later-reported earlier entry time: *While live · Recorded after execution began*), ~150 generated 1280×720 chart
screenshots (PNG/WebP/JPEG; one relabelled, one removed, one copied into a duplicated draft), tags, reviews (completed and
one reopened), external losses (one removed), daily notes. Today: a planned trade closed (exit logged now), a locked plan
waiting for entry, a draft blocked by the new maximum risk, a ready-to-lock draft with two screenshots, two live trades,
a live-first loss logged after it closed, an external loss, and a duplicated draft blocked by the daily trade limit.
AI history (no provider is called): Analyze Setup completed ×2 (one on a superseded revision; the other on the waiting
plan before its lock, or on the ready draft when seeded during Dead Pool) and failed, Challenge My Bias completed and
cancelled-at-dispatch, timeline trade review completed ×2 (planned, live-first) and rejected by the
hindsight guard, weekly review completed and refused; reservations are reserved, dispatched and settled (or cancelled)
through the real ledger with synthetic usage.

How it writes:
- **Now, through the RPCs as the user** (and the service-only `register_trade_evidence` and AI start/authorize/finish +
  reserve/dispatch/settle RPCs with the local secret key): everything whose time is "now", including RPCs that accept a
  past user-reported time (`close_planned_trade` / `close_live_trade` exit times, `record_live_trade` entry time).
- **History through superuser `psql`**, one transaction per user, with the session-local helpers in
  `fixtures/seed-v2-history.sql` (pg_temp: no schema change). The RPCs stamp `clock_timestamp()` and cannot backdate,
  so each helper performs exactly the inserts of the named RPC at an explicit past time, with the same validation.
  Drafts and locks are evaluated by `private.risk_report_v12` with `private.daily_usage` as of that moment (Dead Pool,
  slots, caps, stale equity apply; a lock the engine would block aborts the seed); stored phases come from
  `private.trade_phase` / `private.trade_lifecycle`, and stop moves, target changes and partial closes are written only
  while the trade is LIVE, as `add_journal_entry` requires (`ENTRY_NOT_LIVE`). Insert-only: nothing is updated or
  deleted, no trigger disabled.
- AI facts, contracts, pricing and output validation come from the application's own modules under `src/` (loaded with
  Node's `--experimental-transform-types`; the script re-launches itself with it).
- AI pricing is resolved once, before any user is touched (`seed-ai-pricing.mjs`, typed by `seed-ai-pricing.d.mts`):
  the seeded operations are priced at now while their reviewed profile is valid, as the app's gate does. From a
  profile's `validUntil` on (the gpt-5.4-mini profile ends 2026-11-12 00:00 UTC) the app refuses every new AI request
  until `src/ai/pricing.ts` is reviewed, while the seed prices its synthetic history at the profile's last reviewed
  instant and prints "AI pricing … expired …". Any other pricing error (unknown profile, model mismatch) stops the seed
  before anything is written.

Rules: a user that already has data is refused (nothing changes) unless `--reset-users`, which seeds a fresh
`local+r2@…` (`+r3`, …) instead of deleting anything. Credentials go to `.local/seed-v2-users.json` (git-ignored),
together with each user's **showcase**: the ids of its three accounts (`ftmo`, `personal`, `demo`) and of 20 trades that
each show one state or feature, printed at the end of the run and saved (`showcase.descriptions`) with a description of
what that user's trade shows (the waiting plan and the ready draft differ when seeded during Dead Pool): `todayClosed`, `todayWaiting`,
`todayReady`, `todayBlocked`, `todayPlannedLive`, `todayLiveFirst`, `todayLiveFirstClosed`, `todayDuplicate`,
`staleDraft`, `discardedDraft`, `backdatedEntry`, `liveFirstReviewed`, `hindsightRejected`, `skippedPlan`,
`cancelledPlan`, `oversizedFill`, `liveFirstWithoutRisk`, `reopenedReview`, `evidenceRelabelled`, `evidenceRemoved`.
Everything is relative to the moment of seeding, so "today" ages: seed again with `--reset-users` for a fresh today
(or `reset.mjs` for an empty database).
Locks use the real clock only where valid: during Dead Pool (12:00–18:00 UTC−5) today's waiting plan and ready draft are
written as of this morning, so the draft shows *Recheck needed*; early in the strategy day today's times are compressed
into the elapsed part. The seed refuses to start within a few minutes of 12:00 or 00:00 UTC−5 (a session change mid-run
would change what "today" means). The summary prints accounts, trades by lifecycle and origin, evidence, journal phases
and AI history.

### `screenshot.mjs --user=<email> --out=<dir> [--start-app] [--base=URL] [--viewport=1440x1000|393x852] [--theme=light|dark] [--allow-4xx] <path …>`

Signs in through the real `/login` page (playwright-core from `.local/tools`, installed Edge or Chrome, headless,
reduced motion), captures one full-page PNG per path as `<out>/<slug>.<w>x<h>.<theme>.png`, hides the Next dev
indicator (its issue count is recorded), prints browser console errors, failing subrequests and every page that did
not answer 2xx, writes `<out>/screenshot-report.<w>x<h>.<theme>.json`, and exits 1 when a requested page answers
HTTP >= 400, cannot be loaded, or sign-in fails. A 404 on a showcase trade or account means a broken route or an
ownership/context bug; while a screen does not exist yet, `--allow-4xx` still reports its 4xx pages but exits 0
(HTTP >= 500 always fails).
Without `--start-app` the app must already run at `--base` (default `http://127.0.0.1:3000`). `--base` accepts loopback
origins only (`127.0.0.1`, `localhost`, `[::1]`), because the script types a stored local password into the page.
`/login`, `/forgot-password` and `/update-password` are captured signed out. Widths below 768 px use a mobile context
(touch, 2× pixels). The theme is set through the app's `tos_theme` cookie and the browser colour scheme. Passwords come
from `SCREENSHOT_PASSWORD`, `.local/seed-v2-users.json` or `.local/integration-users.json`, never the command line.
Paths may omit the leading slash; in Git Bash either omit it or set `MSYS_NO_PATHCONV=1` (Git Bash rewrites `/today`
into a Windows path).
For a seeded user, `@name` stands for a showcase id of that user: a path starting with a trade name opens the trade
(`@todayBlocked` → `/trades/<id>`, `@todayBlocked/edit`), one starting with an account key opens the account
(`@ftmo/manage` → `/accounts/<id>/manage`), and elsewhere the id is substituted (`journal?account=@personal`). Files are
named after what was asked (`todayblocked-edit.1440x1000.light.png`); an unknown name fails before the browser starts
and lists the known ones. In PowerShell quote such arguments (`"@todayBlocked"`), because a bare `@` splats a variable.

## Local OpenAI mock (AI acceptance without a provider)

> **Local acceptance tooling only.** Never use it on Vercel Preview or production. Preview keeps `AI_ENABLED=false` until
> the real-provider acceptance that follows the independent audit. The mock never contacts OpenAI and costs nothing.

`mock-openai.mjs` is a Node preload. It replaces `globalThis.fetch` in every Node process of `next dev` and answers the
two calls `src/ai/provider.ts` makes, `POST https://api.openai.com/v1/responses/input_tokens` and
`POST https://api.openai.com/v1/responses`, from `mock-openai-generator.mjs` (pure and deterministic, no I/O). Every AI
flow then runs end to end through the real request gate, budget ledger, server-side validators and AI history against
the local stack: Analyze Setup, Challenge My Bias, the timeline-aware Review Trade, Weekly Review, Recent Trades and
Monthly Review. The mock also answers the schemas of V1 Review Trade (`review_trade_v1`) and the legacy setup evaluator
(`ict_setup_v2`), but V2 starts neither: V1 Review Trade has no entry point in V2 (its stored results still render),
and the legacy evaluator is refused before any provider call because its pricing review expired (Known limits).

### Start

Stack, `.env.local` and data as above (`start.mjs`, `env.mjs`, `seed-v2.mjs`), then from the repository root:

```sh
# Git Bash
AI_ENABLED=true OPENAI_API_KEY=sk-local-mock-local MOCK_OPENAI=1 \
  NODE_OPTIONS="--import=./scripts/local-stack/mock-openai.mjs" npx pnpm@11.19.0 dev
```

```powershell
# PowerShell (these variables stay set for the rest of this session)
$env:AI_ENABLED="true"; $env:OPENAI_API_KEY="sk-local-mock-local"; $env:MOCK_OPENAI="1"
$env:NODE_OPTIONS="--import=./scripts/local-stack/mock-openai.mjs"; npx pnpm@11.19.0 dev
```

- The exported variables override `.env.local` (which keeps `AI_ENABLED=false`). The relative `--import` path resolves
  against each process's working directory; from elsewhere use the absolute form
  `--import=file:///D:/Maxim/TradingOS/scripts/local-stack/mock-openai.mjs`, as `control.mjs` does for its own preload.
- `next dev` forwards `NODE_OPTIONS` to its server process, and every Node process of the chain (npx, pnpm, next, the
  server) loads the preload, so stderr shows one `[mock-openai] active (pid …)` line per process. **No such line means
  the mock is not loaded: stop the server.**
- AI must be ON for the account. The seeded FTMO 100K (EUR 10 budget) and Personal 12K (EUR 3) accounts are; Demo 100K is
  off and shows the "Off" status ("AI is off for this account. …"). On the seeded data a mock answer settles about EUR 0.004-0.021 (about
  2,900-20,600 input and 250-620 output tokens; per-flow figures under Known limits), so the AI budget summary shows
  plausible usage; each request reserves about EUR 0.04-0.07 first.
- The gpt-5.4-mini pricing profile is reviewed until 2026-11-12 00:00 UTC. From then on the app refuses every AI request
  ("AI pricing requires review before requests can run.") until `src/ai/pricing.ts` is reviewed, mock or not.
- As with any manual `next dev`, restore the tracked `next-env.d.ts` before committing.

### Guards (fail closed)

- Inactive unless `MOCK_OPENAI` is exactly `1`: the module then changes nothing and `fetch` stays the original.
- With `MOCK_OPENAI=1` the import throws, so the server cannot start, when `OPENAI_API_KEY` is set to anything that does
  not start with `sk-local-mock`, when it is unset and a `.env*` file Next.js would load defines a non-mock key, or on
  Vercel (`VERCEL` / `VERCEL_ENV` set). The messages never contain the key. `.env*` files are read with Next.js's own
  dotenv grammar (`KEY=value`, `KEY: value`, `export`, quoted values spanning lines, a value or `=` on the next line;
  every assignment counts), and every line that can assign the key must also be a single-line `OPENAI_API_KEY=` (empty)
  or `OPENAI_API_KEY=sk-local-mock…` assignment, optionally quoted or commented; any other form is refused. If you
  keep a key in `.env.local`, export `OPENAI_API_KEY=sk-local-mock-…` in the shell (it overrides the file) or remove it.
  `next dev` reloads `.env*` files when they change; without the exported mock key, a real key added to a file while
  the server runs would be loaded, but it is still never forwarded (bearer check below, logged as `blocked-key`) and AI
  requests fail as `INPUT_COUNT_UNAVAILABLE`, which holds budget. Always export the mock key as in the start command.
- Only `POST` to exactly `https://api.openai.com/v1/responses` and `/v1/responses/input_tokens` (default port, no query)
  with an `sk-local-mock` bearer key is answered. Every other request to `openai.com` or `*.openai.com` is rejected with
  `MockOpenAiBlockedError` and never forwarded: other paths, methods and subdomains, plain `http`, a real key, and
  Request- or URL-shaped objects of other fetch implementations that name OpenAI. Every other host (gateway, PostgREST,
  storage) reaches the original `fetch` with the same arguments.
- Next.js wraps whatever `globalThis.fetch` is when the server loads (`createPatchedFetcher(createDedupeFetch(fetch))`),
  and `router-server` restores that same function on HMR, so server actions and route handlers reach the mock. No file
  under `src/` imports it. `tests/v2-mock-openai.test.ts` asserts both, plus the guards in real Node processes.

### What it answers

- **`input_tokens`**: `{"input_tokens": n}` with n = ceil(UTF-8 bytes of the count body / 4). The app's own pre-flight
  estimate (`src/ai/request-estimate.ts`) is never below that figure and refuses an oversized request
  (`INPUT_LIMIT_EXCEEDED`) before anything is reserved, so such a request never reaches the mock; the
  `input_limit_exceeded` scenario below exercises a provider count above the limit. Exception: a
  `data:image/…;base64` URL is counted like
  OpenAI's high-detail image tiles (85 + 170 per 512 px tile after fitting into 2048 px and scaling the short side to
  768 px; an unreadable header counts 1,445) instead of by its base64 length. Counted as text, a single 60 KB seeded
  chart would be about 20,000 tokens and every screenshot request would exceed the 16,000-32,000 token operation limits.
- **`responses`**: `{id: "resp_mock_<n>", object: "response", model: <request model>, status: "completed",
  output: [{type: "message", role: "assistant", content: [{type: "output_text", text}]}], usage}`. In `usage`,
  `input_tokens` equals the count above, `output_tokens` = ceil(output text bytes / 4) capped at `max_output_tokens`,
  `cached_tokens` and `reasoning_tokens` are 0, and `total_tokens` is the sum. `<n>` restarts with each server process.
- **The output** is generated from the request's `text.format.schema` (`$ref`/`$defs`, `anyOf`/`oneOf`/`allOf`,
  `enum`/`const`, type arrays and nullable types, `required`/`additionalProperties: false`, item counts, string
  lengths, `pattern`, numeric bounds), with calm advisory English chosen per field. Per-contract post-processing keeps
  the server-side validators satisfied: `sourceRefs` come only from the schema's `canonicalCitation` enum (or the
  request's source manifest), relevant ids first; Analyze Setup's `evidenceStatus` follows the selected evidence; the
  timeline review's thesis check cites only pre-entry sources (hindsight guard) and `planStatus` decides
  `NO_PLAN`/`NOT_RECORDED`; the timeline review and Review Trade V1 compare the recorded entry price and fill size
  (above or below the planned quantity) with the locked plan the same way (`DEVIATION`/`ALIGNED`); the legacy evaluator
  gets pass-scoped ids, chart-only observed evidence, the structure shift read from the M5 chart (else another intraday
  or unlabelled chart), `htf_context` from the supplied daily/H4/H1 charts, a gap that names what is actually missing,
  a CONDITIONAL (INSUFFICIENT_EVIDENCE without a setup-timeframe chart) decision with a material finding and a
  reconciliation that accounts for every prior finding. It contains no trading directives, signals or price
  predictions. The same request body always gets the same output; variation comes from a hash of the body.

### Scenarios (failure paths)

`.local/mock-openai-scenarios.json` is re-read on every call; without the file every call is `"ok"`. Keys are json_schema
names (`analyze_setup_v1`, `challenge_bias_v1`, `review_trade_v1`, `review_trade_timeline_v1`, `weekly_review_v1`,
`recent_trades_v1`, `monthly_review_v1`, `ict_setup_v2`) or `"*"` (a name wins over `"*"`). Values are a scenario name
or `{"scenario": name, "delayMs": n}`; a top-level `"delayMs"` applies to every entry without its own.

```json
{ "weekly_review_v1": "refusal", "review_trade_timeline_v1": { "scenario": "hindsight_citation", "delayMs": 4000 }, "*": "ok" }
```

`delayMs` (0-600000) delays only the generation call, so the UI shows the request in progress. A delay above 180000
(for example 200000) outlasts the app's 180-second provider timeout and ends as `TIMEOUT_OR_NETWORK` (held, see
below); its log line reads `status=timeout note=during-delay-200000ms`. A file that is not valid JSON, or names an
unknown scenario or field, answers every generation call as a refusal and logs `note=invalid-scenario-file:…`.

| Scenario | Mock behaviour | `ProviderError` | Accounting | What the app shows |
|---|---|---|---|---|
| `ok` | Completed; valid generated output | – | Settled | Completed result |
| `refusal` | Content item of type `refusal`, with usage | `REFUSED` | Settled | Failed: "The AI provider declined the request." |
| `incomplete` | `status: "incomplete"` (`max_output_tokens`), truncated text; usage charges `max_output_tokens` | `INCOMPLETE` | Settled | Failed: "The AI provider returned an incomplete answer." |
| `invalid_json` | `output_text` is plain text, with usage | `INVALID_JSON` | Settled | Failed: "The AI response could not be read." |
| `schema_violation` | Valid JSON: first property removed, unknown property added | – | Settled | Failed with the flow's invalid-output code (`INVALID_ANALYSIS_OUTPUT`, `INVALID_CHALLENGE_OUTPUT`, `INVALID_WEEKLY_OUTPUT`, `INVALID_RECENT_OUTPUT`, `INVALID_MONTHLY_OUTPUT`, `INVALID_REVIEW_OUTPUT`; legacy evaluator pass `INVALID` / `INVALID_OUTPUT`) |
| `foreign_source` | One citation outside the allowed ids | – | Settled | Failed: invalid-output code; timeline review `FOREIGN_REVIEW_SOURCE`; V1 Review Trade `REVIEW_FAILED`; legacy evaluator `INVALID_OUTPUT` |
| `hindsight_citation` | Timeline review: the thesis check cites an after-close record. Other schemas: as `foreign_source` | – | Settled | Timeline review failed: `HINDSIGHT_CITATION` "The AI supported the thesis check with records made after entry." |
| `trading_directive` | First text field becomes "Take the trade at the next touch of the zone." | – | Settled | Failed: invalid-output code; timeline review `TRADING_DIRECTIVE`. App gap: V1 Review Trade and the legacy evaluator have no directive check and complete with that sentence |
| `http_500` | HTTP 500 `server_error`, no usage | `MODEL_ERROR` | **Held** (UNCERTAIN) | Failed: "The AI provider's usage could not be confirmed." and "The amount held for this attempt stays until an accounting review confirms the cost or releases it; nothing beyond it was charged." (code `ACCOUNTING_UNCERTAIN` in Technical details) |
| `http_429` | HTTP 429 `rate_limit_exceeded` | `RATE_LIMIT` | **Held** | as `http_500` |
| `http_401` | HTTP 401 `invalid_api_key` | `OPENAI_AUTH` | **Held** | as `http_500` |
| `http_403` | HTTP 403 model access | `MODEL_ACCESS` | **Held** | as `http_500` |
| `network_error` | The fetch rejects like a dropped connection | `TIMEOUT_OR_NETWORK` | **Held** | as `http_500` |
| `count_unavailable` | HTTP 503 from `input_tokens`; no generation call | `INPUT_COUNT_UNAVAILABLE` | **Held** | as `http_500` |
| `input_limit_exceeded` | `input_tokens` = 1,000,000; no generation call | `INPUT_LIMIT_EXCEEDED` | **Held** | as `http_500` |

The `ProviderError` code is stored on the usage row; failed requests show the reason from `src/lib/ai-history.ts` and
the accounting outcome from `failureAccountingText` in `src/components/ai/model.ts`. Every scenario that fails after
the app contacted the provider without usable usage is **held**, the count failures included: the input-count request
itself reaches the provider, and whether counting is billed is not established (docs/AI_BUDGET_REVIEW.md), so the
request gate releases a reservation at zero cost only when no provider request of any kind was issued.
**A held (UNCERTAIN) reservation pauses AI for the whole account** (status "Paused — needs review": "AI requests for
this account are paused until an accounting review confirms the cost or releases the hold.") until it is resolved. Run
those scenarios last, or on an account you do not need (for example Personal 12K, or a fresh user from
`seed-v2.mjs --reset-users`). On the local stack only, the superuser (psql, see Files) can release them; the history
row then reads "Reviewed: the AI provider recorded no usage for this attempt, so nothing was charged and the held amount
was released.":

```sql
select private.resolve_ai_uncertainty(gen_random_uuid(), u.reservation_id, 'NO_PROVIDER_USAGE_CONFIRMED',
  'Local mock-openai failure scenario; no provider was called.', '.local/logs/mock-openai.log', '{}'::jsonb)
from public.ai_usage_records u
where u.disposition = 'UNCERTAIN'
  and not exists (select 1 from public.ai_uncertainty_resolutions x where x.reservation_id = u.reservation_id and x.decision <> 'KEEP_UNCERTAIN');
```

### Log

`.local/logs/mock-openai.log` (the folder is created when missing) gets one line per intercepted call:

```
2026-10-24T09:00:00.112Z POST /v1/responses/input_tokens schema=analyze_setup_v1 model=gpt-5.4-mini bytes=9908 scenario=ok status=200
2026-10-24T09:00:00.131Z POST /v1/responses schema=analyze_setup_v1 model=gpt-5.4-mini bytes=9972 scenario=ok status=200
2026-10-24T09:00:07.540Z GET api.openai.com/v1/models schema=- model=- bytes=- scenario=blocked status=blocked
```

Each line has the time, method, endpoint, json_schema name, model, request bytes, scenario, HTTP status and sometimes
`note=` (invalid scenario file, malformed request, or a generator error answered as a refusal). Calls that end without
an HTTP status are logged too: `blocked`, `network-error`, `timeout` (the app's provider timeout fired, for example
during `delayMs`: `note=during-delay-<n>ms`), `aborted` (the caller aborted the request) and `error` (the request body
could not be read). Keys, headers, prompts, facts and outputs are never logged.

### Known limits

- The legacy setup evaluator (`ict_setup_v2`, gpt-6-astra) is served for all three stages, but the app itself refuses
  that operation since its pricing review expired (`AI_PRICING.validUntil` 2026-10-22), before any provider call; V2
  links it from nowhere (`POST /api/setups/[id]/analyze` is kept for compatibility). The mini operations' pricing
  (`MINI_PRICING.validUntil`) expires on 2026-11-12 00:00 UTC, after which every AI flow is refused the same way.
- Token counts are estimates, not OpenAI's tokenizer, and reasoning tokens are always 0. The mock counts
  ceil(bytes / 4); the app's pre-flight estimate counts dense facts (ids, timestamps, decimals) higher and refuses a
  request above the operation's input limit before anything is written or reserved, so an oversized sample never
  reaches the mock and holds no budget (Recent Trades names the largest sample that fits; a month falls back to its
  deterministic summary; a week is refused whole, saying what it holds). The V2 facts carry no written strategy and are written compactly (docs/V2_ARCHITECTURE.md
  §11.5): on the seeded traders (80-95 records in their last 30 trades), the last 30 trades of Recent Trades estimate
  28,800-30,100 of the 32,000-token limit (the mock counts up to about 79 KB, about 20,000 tokens), so Recent 30 is
  usable in acceptance; a weekly review's count body is about 20 KB and a monthly one about 39 KB. Analyze Setup and
  Challenge My Bias count about 3,000 tokens plus
  1,105 per selected 1280×720 screenshot, against 16,000.
- Settled charge per mock answer (gpt-5.4-mini pricing; mock answers on the local stack between 2026-10-28 and
  2026-11-08, `ai_usage_records`): Analyze Setup 3,100-5,700 input tokens, EUR 0.005-0.008; Challenge My Bias about
  2,900, EUR 0.004; Review Trade (timeline) 3,200-7,300, EUR 0.004-0.008; Weekly Review 4,700-6,600, EUR 0.007-0.008;
  Recent Trades 10,700-20,600, EUR 0.012-0.021; Monthly Review 8,900-12,900, EUR 0.011-0.015. Output is 250-620 tokens.
  Each request first reserves its maximum (EUR 0.040 for Challenge My Bias up to EUR 0.067 for Recent Trades and
  Monthly Review).
- Real Structured Outputs would never return `schema_violation` or `foreign_source` outputs. Those scenarios test the
  server-side validators.
- Repeating an identical request body returns the identical output.

Tests: `npx pnpm@11.19.0 exec vitest run tests/v2-mock-openai.test.ts`.

## Browser acceptance

`acceptance/run.mjs` is the scripted browser acceptance of V2 (master specification §60 and §64,
docs/V2_ARCHITECTURE.md §16.2). It drives the **running** app (default `http://127.0.0.1:3000`, loopback origins only)
with playwright-core from `.local/tools` and an installed Edge or Chrome (headless, as `screenshot.mjs` does), signs in
through the real `/login` page as fresh synthetic users it creates for the run, and asserts behaviour through what a
user sees. Controls are found through roles, accessible names and visible text, never CSS classes or test ids; the
only class it reads is the design-system variant (`btn-primary`, `btn-secondary`) of controls found that way, to tell
the primary action of a blocked draft from the secondary ones. Every step records pass/fail with its evidence and
screenshots.

### Before a run

- Stack running (`start.mjs`) and `.env.local` from `env.mjs`.
- The dev server started with the local mock AI provider **and** the mock platform sync, for example (Git Bash,
  repository root):

  ```sh
  AI_ENABLED=true OPENAI_API_KEY=sk-local-mock-local MOCK_OPENAI=1 TRADING_OS_ENABLE_MOCK_SYNC=true \
    NODE_OPTIONS="--import=./scripts/local-stack/mock-openai.mjs" npx pnpm@11.19.0 dev
  ```

  Without the mock the AI flow fails at its first request (nothing reaches OpenAI either way); without
  `TRADING_OS_ENABLE_MOCK_SYNC=true` the Connections step fails. The runner never starts, stops or restarts the server.

### Run

```sh
node scripts/local-stack/acceptance/run.mjs                                   # every flow at 1440×1000, then 393×852
node scripts/local-stack/acceptance/run.mjs --flows=planned,live-first --viewport=mobile
npx pnpm@11.19.0 run acceptance --publish-screens                             # full run, then refresh docs/v2-screens/
```

| Option | Meaning |
|---|---|
| `--flows=a,b` | `planned`, `live-first`, `analytics`, `accounts`, `ai`, `settings`, `ux` (default: all, always in this order) |
| `--viewport=desktop\|mobile\|both` | 1440×1000, 393×852 (touch, 2× pixels) or both (default) |
| `--out=<dir>` | Output folder (default `.local/acceptance/<run-id>/`) |
| `--base=<url>` | App origin, loopback only (default `http://127.0.0.1:3000`) |
| `--browser=edge\|chrome`, `--headed` | Browser choice (`LOCAL_STACK_BROWSER_PATH` overrides) and a visible window |
| `--publish-screens` | After a passing full run, copy the curated screenshots into `docs/v2-screens/` and rewrite its `README.md` index |

The verdict (`results.json` → `verdict` and `verdictReasons`, also the exit code) is **pass** only when no step failed,
no §60 criterion failed (including 7, 11 and 18, which are judged over every screen of the run and belong to no single
step) and, in a full run of every flow at both viewports, every one of the 20 criteria has evidence; a clock-limited
step does not fail a run. Otherwise it is **fail** (or **interrupted** after Ctrl+C) and the reasons are listed. A full
run at both viewports took 16–17 minutes outside Dead Pool and 26 minutes during it (two more seeded users), most of it
`seed-v2.mjs` (25–55 s per seeded user, nine or eleven users) and the dev server compiling routes on first use.

### Users

Every run creates its own users at the reserved domain (`acc-<run-id>-<key>@example.test`), so nothing depends on a user
that existed before the run and a run can be repeated at any time:

| Key | Kind | Used by |
|---|---|---|
| `planned-<viewport>`, `live-<viewport>` | empty (gateway admin API); `live-*` gets one account through `create_trading_account` | first-run onboarding and the planned flow; the live-first flow |
| `history` | seeded (`seed-v2.mjs`), shared by both viewports | analytics and UX checks (read-mostly) |
| `mutable-<viewport>` | seeded, only during Dead Pool | the planned flow continues on its locked plan (see below) |
| `accounts-<viewport>`, `ai-<viewport>`, `settings-<viewport>` | seeded | the flows that change data |
| `erase-<viewport>` | seeded | deleted through Settings → Danger zone |

Passwords are kept in `<run>/users.private.json` and `.local/seed-v2-users.json` (both git-ignored) and never printed.
Seeded users stay in the local database after the run (synthetic data; `reset.mjs` clears everything). The runner waits
when `seed-v2.mjs` would refuse to start (within a few minutes of 12:00 or 24:00 UTC−5).

### Flows

| Flow | What it proves (master specification §64) |
|---|---|
| `planned` | Onboarding creates a Trading Account; Plan Trade with a risk above the maximum shows the exact BLOCKED sentence in the live preview; on the desktop a chart is pasted (a real Ctrl+V key press answered with a `paste` event carrying PNG bytes) and another dropped (`DataTransfer` drop), on the phone one is added through "Choose files" and one through "Take photo" (the system pickers); Save draft opens the trade as Blocked with the reason in the Plan section and "Edit draft" as the next action (and, AI being off for a new account, no paid AI tool); Edit draft saves revision 2 of the **same** trade; Ready to lock; the optional AI step (consent for the new account in Settings → AI, then "Analyze setup · ≈ €…" on the ready draft against the mock, its card led by "Risk Engine · Approved", Lock plan still the next action); Lock plan (the dialog lists what becomes immutable); the locked plan's edit page shows no editor, and the owner's own session calling `revise_trade_draft` and `discard_trade_draft` directly is refused with `DRAFT_NOT_EDITABLE` while the trade keeps its revisions; Record entry (pre-filled); a live note with a screenshot without leaving the trade (pasted with Ctrl+V on the desktop, attached through "Attach screenshots" and the system picker on the phone); Close: Enter in the exit price (a tap on the phone) only opens "Close this trade?", nothing is recorded until it is confirmed there, and `close-preview` requires the confirmation's net P&L and realized R to equal what the close then recorded; a lesson after close lands in After close only; tags and Mark reviewed; the timeline bands |
| `live-first` | Record Live Trade with account, instrument, direction and entry price only; "No pre-trade plan was recorded before execution." and "No pre-trade plan recorded"; no stepper and no pre-trade AI tools; a timestamped note, a screenshot (dropped onto the composer on the desktop, "Take photo" on the phone) and a Decision while live; close with the platform's net P&L (no size, so P&L can't be calculated), confirmed in "Close this trade?", which shows the reported +$42.50 (Win) and the exit first; an explanation after close is listed under After close and never as Before entry evidence; with grade B picked but not saved, "Save tags and mark reviewed" saves the tags and marks the trade reviewed: the tags form reads saved and editable again, and B is still set after a reload |
| `analytics` | Journal (grouping, search, origin filter, row → trade); EDGE headline statistics with the sample caveat, money per currency, every chart with its table view; statistic → trades (Net R by model → OTE trades); calendar day → trades → trade; trade → evidence viewer (Escape closes); All Accounts → account → day → trade → evidence by clicking only; a trade locked under Risk Plan V1.0 still shows V1.0 while the account's active plan is newer |
| `accounts` | All Accounts is a context (selector option "Aggregate of every trading account", no table row, no stored account); an account dashboard in its own currency, opened from the Accounts list, which makes that account the context (the header names it) and offers Plan Trade and Record Live Trade once each on it (`?account=<id>`); switching context with the header selector and seeing it on Journal, Today, EDGE, Review and Settings; account-scoped EDGE and Journal; money never added across currencies; New account (GBP), whose dashboard opens as the context and offers Plan Trade and Record Live Trade once each, on the new account; Archive; archived accounts are not offered by Plan Trade or Record Live Trade, `?account=<archived>` falls back to All Accounts with a notice, and `record_live_trade` and `create_planned_trade` called directly with the user's own session must refuse it with `ACCOUNT_ARCHIVED` (no trade is stored on it) |
| `ai` | Budget summary per account; on a blocked draft the primary action is Edit draft and AI is only "Analyze blocked setup anyway · ≈ €…" (secondary, nothing sent on load); Analyze Setup, Challenge My Bias, the timeline-aware Review Trade, Weekly Review, Recent Trades and Monthly Review against the mock (each request is matched to a `status=200` line of `.local/logs/mock-openai.log`); concise cards with friendly sources; each "View full analysis" sheet carries the card's title, every item the card shows in full (the card shows first sentences) and something the card leaves out (another section, item or the AI's limitations); the Review history lists the run's Monthly, Recent Trades and Weekly reviews first as compact rows; usage grows in the budget; one failure (`weekly_review_v1: http_500` in `.local/mock-openai-scenarios.json` for a single request, then restored) is reported as held for review and pauses that account's AI |
| `settings` | Theme and time display; a new risk-plan version that starts tomorrow; a profile revision, "Confirm unchanged", an external loss added and removed; the Connections copy (cTrader and MT5 planned, read-only scope) and the mock platform (connect, Simulate sync, imported trades in the Journal, disconnect keeps them); Export my data: the ZIP is downloaded and checked (every part belongs to the user, every table holds exactly the user's stored rows, no other user's id or email anywhere, one CSV row per trade, every screenshot present with its SHA-256); Delete Trading OS account on the `erase-*` user: one of its accounts is first chosen in the header selector on Settings, so both context cookies (`tos_account`, `tos_last_account`) hold its id, and they still do right before the deletion; a wrong password gets the server's own answer ("That password is not correct. Nothing was deleted." in an alert), and once the form is idle again every tenant table, the login, the storage objects and the stored files are compared with the moment before the attempt; then DELETE + password deletes it, the browser lands on `/login?reason=account_deleted`, sign-in fails, and superuser SQL finds no row in any tenant table, no auth user, no storage object or file, one new de-identified erasure receipt, another user's rows unchanged, and neither context cookie left in the browser |
| `ux` | The next action of every state above the fold; core actions never inside a collapsed disclosure; the command palette (Ctrl+K, `/`, Enter, Escape); the `?`, `P` and `L` shortcuts; the skip link and a visible focus ring of at least 2 px; the Tab order of Plan Trade; Escape closes dialogs and menus and returns focus (polled, the time it took recorded); closing the seeded live trade only opens "Close this trade?" and going back records nothing (on the desktop Enter in the exit price opens it with focus on "Keep editing", Escape closes it and focus returns to the exit price; on the phone Close trade and Keep editing are tapped): the price typed is kept and the trade stays live; the editor of the seeded draft blocked for two reasons (both listed, a risk preset clicked or tapped without saving, the page within the screen width); on the phone a live note from Today's live card with taps only; Today at a glance; the dark theme tokens on key screens; on the phone only (`long-account-names`), the shared `history` user's FTMO account renamed to a 100-character name and its Personal account to one without spaces through `update_account_profile`: Today (All Accounts, both names whole in its text), the seeded live trade (its header's account chip inside the screen), Plan Trade for both accounts ("‹ Today" on one line beside the account chip), Personal's own Today, dashboard, Manage, Review and AI history, the Journal's and EDGE's account filter chip for Personal (`?account=all&accountFilter=`), and Settings fit 393 px with the tab bar on the screen, then the seeded names are put back; last on the phone, every phone screen the run reached fits 393 px |

### The real clock

Locks and risk checks use the server's clock, which the runner never fakes. During Dead Pool (12:00–18:00 UTC−5) the Risk
Engine blocks every lock, so revision 2 of the new draft stays Blocked with only the Dead Pool sentence: the runner
records that step as **clock-limited** (the expected deterministic behaviour, not a failure), seeds a `mutable-*` user
whose plan `seed-v2.mjs` locked before Dead Pool, and continues the planned flow there (immutability, entry, live note,
close, review); the optional AI step and the lock itself are then skipped. For the same reason Challenge My Bias (it
needs a draft that passes the current check) is clock-limited during Dead Pool, and Analyze Setup runs as "Analyze
blocked setup anyway". Run outside Dead Pool (from 18:00 UTC−5, for example) to also exercise the lock of a new draft,
Analyze Setup on it and Challenge My Bias; the summary lists every clock-limited step.

The runner never takes the app's word for the clock. Every Dead Pool answer is first checked against the strategy clock
for the moments that bracket the check (`deadPoolExpectation` in `rules.mjs`, with one minute of slack around 12:00 and
18:00 UTC−5): a Dead Pool block outside 12:00–18:00, a "Ready to lock" inside it, or a lock that succeeds inside it
fails the step ("the Risk Engine does not allow a lock during Dead Pool"). Only a refusal the clock explains is
clock-limited, including a lock refused because Dead Pool began between the check and the lock.

### Phones (393×852)

The phone pass uses a touch screen (`hasTouch`, `isMobile`, 2× pixels, coarse pointer): controls are tapped, the new-trade
actions come from the tab bar's "+" sheet, and screenshots reach Plan Trade and the live journal the way a phone offers
them ("Choose files", "Attach screenshots" and "Take photo" open the system picker, which the runner answers with the PNG
through Playwright's `filechooser` event) instead of Ctrl+V or a drag. Nothing relies on hover. Criteria 3 (Ctrl+V)
and 4 (drag and drop) are therefore judged on the desktop only.

When a page is laid out wider than the phone, the browser widens its layout viewport and pans the visible part inside
it, and a touch can land beside the control it aims at. Such a missed tap **fails its step** (and every criterion the
step evidences) with an error naming the screen and both widths, and a `-tap-missed` screenshot of that moment; the
control is then activated with a synthetic click only so the rest of the step, and the steps after it, can still be
judged. The screen is scanned after every navigation (`goto`, and `arrive` after links, redirects and shortcuts), right
before every tap, at every screenshot and at the end of every step. Each scan measures the layout against the 393 px
device width (`innerWidth` grows with the content on phones, so it is not used) and names the most deeply nested element
reaching furthest right (fixed bars such as the tab bar only stretch to the widened layout, so they are never named). The
summary's "Phone width" section lists every screen that pans sideways, and the last step of the phone pass (`ux` →
`phone-width`) fails while any does. The `ux` flow also opens the editor of the seeded draft blocked for two reasons
(a longer verdict in its sticky bar than the planned flow's own draft has outside Dead Pool) and taps a risk preset
there, so that screen is measured and tapped whatever the clock says.

### UX criteria (master specification §60)

Each step names the criteria it evidences; a passed step records its sentence of evidence, a failed one records the
failure, and `uxCriteria[]` gives every criterion pass (evidence and no failure), fail (any failure) or not-run:

| # | Judged by |
|---|---|
| 1 | The next action above the fold in every state: planned flow (Blocked → Edit draft, Ready to lock → Lock plan, Locked → Record entry, Live → Add to journal, Closed → Write review) and the `ux` flow on seeded trades (also Recheck needed → Recheck risk, Reviewed → Reopen review) |
| 2, 3, 4 | Live notes from the trade page and from Today's live card without leaving them; Ctrl+V on Plan Trade and in the live composer (desktop); `DataTransfer` drops on Plan Trade and on the composer (desktop) |
| 5, 6, 19 | Edit draft keeps the trade id and adds revision 2, and the editor of a draft blocked for two reasons takes a click or tap and fits the screen; the exact blocking sentence in the preview and in the Plan section; a locked plan has no editor, its edit URL refuses, and the owner's direct `revise_trade_draft` and `discard_trade_draft` calls are refused with `DRAFT_NOT_EDITABLE` without a new revision |
| 7, 11 | Every scan of every flow, viewport and theme: no raw internals in the visible text; the header's Trading Account selector on every app screen |
| 8, 9 | Live-first with four fields; post-close notes only under After close (planned lesson, live-first explanation), never Before entry, the thesis or pre-entry evidence |
| 10 | The AI flow, where AI is on: on a blocked draft the primary action is Edit draft; paid AI only as the secondary "Analyze blocked setup anyway · ≈ €…", nothing sent on page load (mock log). (The planned flow's new account has AI off, so it proves nothing here and records nothing for 10.) |
| 12, 14, 20 | All Accounts as a selector context without a stored row, money per currency; statistic → trades, day → trades → trade → evidence; Risk Plan V1.0 kept on a historical trade while the account's plan is newer |
| 13, 15 | Core actions are visible controls (never inside a closed disclosure); both trade flows end Reviewed through labelled controls only |
| 16 | Every AI card's visible length is bounded; the full analysis opens only in its sheet, which holds every item of the card in full plus what the card leaves out |
| 17 | Pre-filled account, contract, entry and size; no manual daily-loss total anywhere in Settings |
| 18 | Phone steps done with taps (note from Today's card, note and picker screenshot on the trade, camera button on live-first) and Today and the trade page fitting 393 px in every phone scan |

Any missed phone tap fails the criteria its step evidences. Criteria 7, 11 and 18 are judged over every screen of the
run, so they can fail a run without any failed step; the verdict counts them.

### Output

`.local/acceptance/<run-id>/` (git-ignored):

| Path | Content |
|---|---|
| `results.json` | `runId`, `base`, `browser`, `clock` (start and end), `verdict` and `verdictReasons`, `users` (keys, emails, ids; no passwords), `steps[]` (`flow`, `viewport`, `id`, `title`, `status` = pass/fail/skipped/clock, `ms`, `evidence[]` of `{ok, message, detail}`, `screenshots[]`, `error`), `matrix` (flow × viewport), `uxCriteria[]` (the 20 criteria of §60 with verdict pass/fail/not-run and their evidence), `scans[]` (per screen, viewport and theme: raw-internal hits, the context selector's text, `overflowPx` against the device width and the widest element), `warnings[]` (console errors, page errors such as hydration mismatches, failing requests, dev-overlay issues, native dialogs, missed taps), `notes[]` |
| `summary.md` | Verdict with its reasons, pass matrix, UX criteria table, failures (steps with their screenshots, failed criteria, and in a full run criteria that never ran), clock-limited steps, every step, the visible-text scan, phone width and warning summary |
| `screens/<viewport>/<flow>/NN-<name>.png` | Screenshots of the steps (`-failure` on a failed step, `-tap-missed` at a missed phone tap, `.dark` in the dark theme) |
| `curated/` | Documentation candidates (device pixels; long phone pages at CSS pixels; each fitted under 480 KB) and their `index.json` |
| `downloads/export-<viewport>.zip` | The exported archive that was inspected |
| `seed-<key>.log`, `users.private.json` | Seed output and the run's synthetic credentials |

The visible-text scan runs after every navigation, before every phone tap, at every screenshot and at the end of every
step: `document.body.innerText` (closed Technical details are not rendered, so they are not part of it) must contain no
UUID, hex hash of 40 or more characters, provider id (`resp_…`), rule code, SNAKE_CASE backend enum, raw JSON or prompt
text. It also records whether the header's Trading Account selector is shown and how far a phone screen is wider than
the device; criteria 7, 11 and 18 are judged over every screen of the run. A navigation that fails inside the browser
itself (for example `net::ERR_NETWORK_IO_SUSPENDED` while Windows suspends network I/O) is retried twice and reported as
a `network` warning; an HTTP error from the app is never retried. A form's "leave this page?" question (`beforeunload`)
is answered with leave, since the runner leaves pages on purpose; any other native dialog is reported and dismissed.

`--publish-screens` replaces the PNGs in `docs/v2-screens/` with the published selection (29 images: Today, the planned
and live-first trade workspaces, the phone live note, Journal, EDGE with the calendar day, the evidence viewer, Accounts,
an account dashboard and its risk policy, Review, AI cards concise and full, an AI failure, Settings, the command
palette and three dark-theme screens) and rewrites its `README.md`: the run, its pass matrix and every image inline,
grouped by area. It does so only after a run whose verdict is pass, that covered every flow at both viewports and
captured every published image; any other run (failed, interrupted, partial, or missing an image) leaves
`docs/v2-screens/` exactly as it was and says why in its notes and log. Captures wait for the images in view
(screenshot thumbnails load lazily) and hide toasts and the dev indicator.

### Side effects

- AI: only the dev server's mock is ever called. The failure scenario writes `.local/mock-openai-scenarios.json` for one
  request and then restores the previous content (or removes the file again); if someone else changed the file
  meanwhile, it is left as found. The file is shared by every user of the dev server, so avoid other AI checks during
  that request. The held reservation stays on the run's own `ai-*` user (release it with the SQL under "Scenarios" if
  needed).
- The operating-system clipboard is never touched (a headless browser on Windows could share it with the desktop).
- Only the run's own users are changed; exactly one per viewport (`erase-*`) is deleted, through the app. The planned
  flow's direct `revise_trade_draft` and `discard_trade_draft` calls on the locked plan are expected to be refused; the
  `ux` flow changes a risk preset in the editor of the shared `history` user's blocked draft without saving it, and on
  the phone renames two of that user's accounts for its `long-account-names` step and renames them back (new profile
  revisions; the history keeps the long names).

### Pure rules and tests

`acceptance/rules.mjs` (options, strategy clock, scan patterns, phone width, criteria verdicts, summary), the published
selection and README index of `acceptance/curate.mjs`, and the ZIP reader in `acceptance/fixtures.mjs` are covered by
`tests/v2-acceptance-runner.test.ts` (`npx pnpm@11.19.0 exec vitest run tests/v2-acceptance-runner.test.ts`).
