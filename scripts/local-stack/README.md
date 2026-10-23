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
node scripts/local-stack/verify.mjs           # optional API conformance checks (auth/REST/storage/RLS)
node scripts/local-stack/browser-smoke.mjs    # starts the app, runs the V1 UI smoke, stops the app
node scripts/local-stack/stop.mjs             # stops everything (PostgreSQL included)
node scripts/local-stack/status.mjs           # confirm "Stack status: stopped"
```

To use the app manually after `start.mjs` + `env.mjs`: `npx pnpm@11.19.0 dev`, open
<http://127.0.0.1:3000/login> and sign in with a user from `.local/integration-users.json`.

## Commands

| Command | Purpose |
|---|---|
| `start.mjs [--restart] [--through=NNNN]` | Idempotent start: binaries, `initdb`, PostgreSQL, bootstrap, pending migrations, PostgREST, gateway (detached, hidden; logs/pids in `.local/logs`, `.local/pids`). Re-running applies only new migrations and restarts PostgREST when the schema changed. `--restart` also restarts PostgREST and the gateway (after editing gateway code). `--through=0014` stops after that migration version. |
| `stop.mjs` | Stops the app (if started by the smoke test), gateway, PostgREST, then `pg_ctl stop -m fast`. |
| `status.mjs [--json]` | Component health, applied/pending migrations, anon-exposed public tables, users file and `.env.local` consistency. |
| `reset.mjs [--hard] [--through=NNNN]` | Drops and recreates the `postgres` database, wipes `.local/storage` and the local mailbox, re-applies bootstrap + migrations, restarts services and re-provisions the synthetic users if they existed. Keys stay the same. `--hard` deletes and re-initializes the whole cluster. |
| `provision-users.mjs` | Creates/repairs the two confirmed synthetic users through the gateway admin API and writes `.local/integration-users.json` (`{"project":"http://127.0.0.1:54321","users":[{id,email,password},…]}`, the format `scripts/verify-*.mjs` read). `users[0]` = owner, `users[1]` = other. |
| `env.mjs [--force]` | Writes `.env.local` with the gateway URL, local `sb_publishable_local_…` / `sb_secret_local_…` keys, `AI_ENABLED=false`. Refuses to replace an `.env.local` that points elsewhere unless `--force` (which first renames it to `.env.local.backup-<time>`). |
| `verify.mjs` | 9 API-level checks through `@supabase/supabase-js` with throwaway `verify-<run>-a/b@example.test` users. |
| `browser-smoke.mjs [--browser=edge\|chrome] [--reuse-app] [--headed] [--record-values] [--desktop=WxH] [--mobile=WxH]` | V1 UI smoke with playwright-core + installed Edge/Chrome (headless). See below. |

### Ports

| Port | Service |
|---|---|
| 54321 | Gateway (`NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`) |
| 54322 | PostgreSQL 17.6 (loopback only, SCRAM passwords) |
| 54330 / 54331 | PostgREST API / admin (`/ready`, `/live`) |
| 3000 | Next.js dev server (browser smoke) |

### Files

| Path | Content |
|---|---|
| `.local/stack.json` | Local secrets: Postgres superuser + `authenticator` passwords, HS256 JWT secret, publishable/secret keys. Generated once; reused by reset. |
| `.local/integration-users.json` | Synthetic user credentials (owner, other). |
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
1 hour, with `sub`, `aud`, `role`, `email`, `session_id`, `aal`, `amr`, `is_anonymous`. Refresh tokens
rotate, with GoTrue's 10-second replay tolerance and reuse detection.

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

`.local/integration-users.json` uses the format expected by `scripts/verify-*.mjs`. Note that several
of those scripts write reports to tracked `docs/*.json` files, and `verify-live.mjs` still calls the
unkeyed `append_plan_note(uuid,text)` that migration 0007 revoked (it fails exactly as it would on
the hosted project). Run copies under `.local/` if you need them without touching tracked files.

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
  `private.trade_phase` / `private.trade_lifecycle`. Insert-only: nothing is updated or deleted, no trigger disabled.
- AI facts, contracts, pricing and output validation come from the application's own modules under `src/` (loaded with
  Node's `--experimental-transform-types`; the script re-launches itself with it).

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
