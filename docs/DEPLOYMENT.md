# Private deployment and recovery runbook

Reviewed 2026-09-14. Private production is deployed and accepted; see [the production report](PRODUCTION_DEPLOYMENT.md) for its exact release, URL and verified Auth settings. **AI_ENABLED=false.**

## Architecture

```text
Browser (authenticated session, public Supabase configuration)
  → HTTPS → Vercel / Next.js (Node 24, server-rendered pages/actions/routes)
      → Supabase Auth: verify and refresh user
      → PostgreSQL: authenticated RPCs, owner RLS, immutable history
      → private Supabase Storage: validated upload, authorized image delivery
```

Normal database operations use the user's session. Screenshot upload uses a server-only Supabase secret after verifying authentication and loading the proposal through owner RLS. The server derives ownership and storage paths. Secrets never belong in client props, source, public environment values, or logs. The database owner and service role are trusted administrative boundaries.

Astra remains preserved and disabled at central configuration, route and provider boundaries. Enabling AI without a key gives an AI-only configuration state. Continue development and tests without live AI calls.

## Environment

| Variable | Classification | Value / purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | PUBLIC; required | Exact HTTPS project origin; build and runtime. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | PUBLIC; required | Same project's `sb_publishable_…`; build and runtime. Secret/service-role keys are rejected. |
| `SUPABASE_SECRET_KEY` | SERVER SECRET | Required for full screenshot upload functionality; use `sb_secret_…`. Missing value does not prevent ordinary user-scoped database operations. |
| `AI_ENABLED` | OPTIONAL; explicitly set | **`false`**. Only literal `true` enables AI. |
| `OPENAI_API_KEY` | OPTIONAL SERVER SECRET | Omit while AI is disabled. |
| `OPENAI_SETUP_MODEL` | OPTIONAL server setting | Existing default `gpt-6-astra`; unused while disabled. Verify provisioned model availability before future activation. |
| `OPENAI_SETUP_REASONING` | OPTIONAL server setting | Existing default `high`; unused while disabled. |
| `OPENAI_SETUP_DEEP_REVIEW` | OPTIONAL server setting | Existing default `true`; has no effect while AI is disabled. |
| `NODE_ENV`, `PORT` | Platform/runtime | Managed by Next/Vercel; optional local port override. |
| `.local/integration-users.json` | DEVELOPMENT ONLY file | Optional test credentials; never commit/deploy. |

No OpenAI key, application database password, Supabase management token or broker credential is required for normal use. A database connection credential is an operator requirement for CLI migrations/backups, not an application runtime secret. No server secret has a `NEXT_PUBLIC_` prefix.

## Deployment prerequisites

1. Establish a reviewed Git release with the pinned lockfile and all migrations. Direct Vercel CLI deployment can use this local release without a GitHub connection. Keep an off-host private source copy. See [current deployment status](PRODUCTION_DEPLOYMENT.md).
2. Select Vercel's **Next.js** preset, repository root, **Node 24.x**, install `pnpm install --frozen-lockfile`, build `pnpm build`, default Next output. pnpm is pinned to 11.19.0. [Vercel Node support](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
3. Configure the two public Supabase values, server-only secret, and `AI_ENABLED=false` in production. Omit OpenAI credentials. Protect previews or connect them to a separate test Supabase project. `.vercelignore` excludes local credentials, temporary data and caches.
4. Verify migration ledger 0001–0007, RLS, private screenshot bucket and disabled public signup. Provision only intended personal users and deliberately retained isolated test users.
5. Follow the [practical backup procedure](PRODUCTION_BACKUP.md) for database and private objects. The approved deployment instructions do not require a full restore drill before deployment. Rehearse recovery separately before relying on that recovery process. Do not assume the Free project includes paid backup/PITR features.
6. Select the exact HTTPS origin. Deploy only after explicit authorization, then adjust auth URL settings below. The approved deployment and hosted acceptance are recorded in the production report.
7. Before daily use, verify hosted HTTPS, cookie restoration/refresh, private response caching, signed-out direct URLs, synthetic plan/lock/entry/close, screenshot upload/view, CSV and logout/login. Confirm AI stays disabled in the hosted logs/runtime. Local tests cannot prove hosting configuration.

Each screenshot is capped at 4 MiB, with at most 64 KiB multipart overhead. That fits Vercel's documented 4.5 MB request/response limit. A sufficiently large CSV can exceed the response limit; export bounded date ranges as history grows. [Vercel function limits](https://vercel.com/docs/functions/limitations)

The simplest personal access model is disabled signup plus a strong personal password and controlled Supabase/Vercel administrative access. Deployment protection can add an entrance restriction where available; owner RLS remains mandatory. Landing/login/preview are public; private trading data requires authentication.

## Authentication URLs

For `https://<your-exact-domain>`:

- Set Supabase **Site URL** to `https://<your-exact-domain>` after deployment is authorized.
- If an auth email redirect is needed, allow exactly `https://<your-exact-domain>/login`. Keep `http://127.0.0.1:3000/login` only while local development needs it; avoid broad production wildcards.
- Current sign-in is password-based through a server action. Password recovery uses `/forgot-password` and `/update-password`; add the exact production `/update-password` redirect and follow [the recovery guide](PASSWORD_RECOVERY.md). There is no `/auth/callback`, OAuth or magic-link completion UI. Provision confirmed users in the dashboard.
- Keep **Allow new users to sign up** disabled; live status verified 2026-09-14. The production Site URL and exact `/login` redirect were configured after the hosted origin was assigned.

[Supabase redirect configuration](https://supabase.com/docs/guides/auth/redirect-urls), [signup configuration](https://supabase.com/docs/guides/auth/general-configuration).

## Migration procedure

Apply once, in numeric order, through a Supabase-aware migration workflow and ledger:

| Migration | Purpose |
|---|---|
| 0001 | Immutable foundation, owner RLS, risk evaluator, transactional commands |
| 0002 | Strategy and risk baseline |
| 0003 | Idempotent bootstrap, persisted risk, provenance and indexes |
| 0004 | Proposals, evidence/evaluations and human decisions |
| 0005 | Private screenshot bucket and restrictive storage policies |
| 0006 | Execution/outcomes, dispositions/tags and analytics view |
| 0007 | Concurrent screenshot cap, provenance/finite-value constraints, keyed notes and risk-check index |

Trading OS already has all seven; **0007 was applied on 2026-09-12**. Do not rerun an applied file or the old AI install bundle. Files contain intentionally non-idempotent CREATE/ALTER statements; the ledger prevents replay. Preserve 0001–0006 unchanged.

Before future changes: back up, compare the applied ledger/source, test ordered installation on a separate restored database, check data compatibility and RLS/grants, then apply the additive change transactionally and refresh PostgREST schema. Record version/name/source when applying through SQL Editor. The optional loopback `scripts/migration-review.mjs` wrapper checks replay; keep this operator helper private and stop it after use. Existing hash differences are CRLF normalization only; exact variants are in `MIGRATION_CHECKSUMS.json`.

Use compatible reviewed builds for app rollback. Migration 0007 revokes unkeyed note calls, so old clients fail note submission safely until refreshed. Prefer additive forward repairs. Do not disable immutability or rewrite history to accommodate an old client.

## Testing and clean setup

Follow README: Node 24.x, pnpm 11.19.0, frozen install, `.env.example`, ordered migrations, confirmed user, `pnpm dev`. Required checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Automated tests require no private machine files, Supabase credentials or OpenAI calls.

Optional live scripts use this ignored file shape:

```json
{"project":"https://<project-ref>.supabase.co","users":[{"id":"<uuid-a>","email":"<test-a>","password":"<password-a>"},{"id":"<uuid-b>","email":"<test-b>","password":"<password-b>"}]}
```

Both users must be isolated confirmed test users in that project. Scripts create permanent synthetic history. `verify-audit-live.mjs` expects existing synthetic plans/evidence/failed history; `verify-audit-flows.mjs` creates its own account/proposals but also verifies an existing closed fixture; `verify-edge-live.mjs` requires the historical synthetic dataset recorded in its report. They fail missing prerequisites; they are not required to start a clean application. Never run these against personal trading accounts.

For local production acceptance with an enforced AI network guard, create `.local/` and start `node --import ./scripts/no-openai-network.mjs node_modules/next/dist/bin/next start --hostname 127.0.0.1`. This optional preload blanks the key, forces AI off and records attempted OpenAI calls without transmitting them. Do not invoke opt-in live AI acceptance.

## Backup and recovery

The current project is Free. Supabase documents logical exports and plan-dependent backup/PITR options. **Database backups do not include Storage object bytes.** [Supabase backup guidance](https://supabase.com/docs/guides/platform/backups)

Keep encrypted, dated off-host backups of:

- Database schema, migration ledger, application data, immutable versions/events and ownership/auth relationships. Use the documented Supabase CLI/database export workflow; verify which roles/schemas/auth records the chosen export includes.
- Every private screenshot's bytes and original bucket/path, plus metadata IDs, MIME type, size and hashes. Include removed evidence and bucket/policy configuration. A database dump alone does not copy objects.
- Source release, lockfile and deployment settings. Store credentials separately in a secure credential store.

Back up before schema changes and after active trading days, or select a managed schedule matching acceptable data loss. Keep multiple copies and verify readability. EDGE CSV is a useful copy of **filtered completed outcomes only**; it cannot restore proposals, events, governing versions, ownership or screenshots.

Rehearse restoration into a separate Supabase project using documented import ordering. Preserve user IDs/FKs; restore objects under original paths; compare table counts, locked risk, outcomes and screenshot hashes. Verify login, owner RLS, denied anonymous/foreign access and private bucket status before switching production configuration. Do not restore over the only live project to test recovery. **A complete off-project disaster-recovery drill was not performed in this audit.**

## Operational limits

Manual account/news/contract inputs remain authoritative inputs, and strategy time stays fixed UTC−5. Full-position accounting only; skip/cancel preserves reservations. Actual-fill mistakes cannot be overwritten through the current UI. No broker, market feed, calendar, partial closes, position adds or new AI capability was added.

Logs use fixed operational event names/statuses without tokens, passwords, request bodies or raw provider/database errors. Trade audit events are separate. Investigate repeated storage failures and verify orphan cleanup after an outage.

A nonce-based CSP, comprehensive assistive-technology certification, extended expiry soak testing, automated screenshot backups and a full restore drill remain documented limitations. They were not claimed as completed checks.
