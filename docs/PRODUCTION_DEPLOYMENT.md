# Private production deployment

This records the initial private deployment. The subsequent deployed password-recovery fix and its current release are documented in [Password recovery](PASSWORD_RECOVERY.md).

**READY FOR PERSONAL DAILY USE** — verified 2026-09-14 for the existing manual, full-position workflow. AI remains disabled.

## Production release

- Production URL: https://trading-os-six-brown.vercel.app
- Provider/project: Vercel, `maksim61910-7648/trading-os`.
- Deployed commit: `2f11e2c84abab43453e0e3fa3c9d19bc9bbf4fbc`.
- Deployment: `dpl_ENKQroyAb8xZABZV9RRLFQDqB5Co`; READY, production.
- Immutable deployment URL: https://trading-kaxani2jh-maksim61910-7648.vercel.app
- Root `.`, Next.js, Node 24.x, pnpm 11.19.0; install `pnpm install --frozen-lockfile`; build `pnpm build`.
- Supabase: existing `Trading OS`, project `txodopkdigulyqkdgheb`. No database reset, migration replay, domain purchase or new product feature.

Post-acceptance documentation commits do not change the deployed application. Use the explicit deployed commit above rather than assuming the latest documentation commit is deployed. [Verified provider configuration](PRODUCTION_CONFIG_VERIFICATION.json)

## Production environment and Auth

| Variable | Classification | Configured |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | PUBLIC | Existing Supabase HTTPS origin |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | PUBLIC | Existing project publishable key |
| `SUPABASE_SECRET_KEY` | SERVER SECRET | Vercel sensitive secret; private screenshot uploads |
| `AI_ENABLED` | OPTIONAL feature flag | Explicitly `false` |

These are the only application variables configured for production. `OPENAI_API_KEY` is absent. Public configuration is intended for the browser; server secrets are not. No OpenAI billing is required. The Vercel CLI transferred values locally without displaying them; local credentials and tooling were excluded from Git and hosting uploads.

Supabase Auth Site URL: `https://trading-os-six-brown.vercel.app`.
Exact allowed redirect: `https://trading-os-six-brown.vercel.app/login`.
No wildcard or invented `/auth/callback` route. Public signup remains disabled. Browser login, session restoration, refresh, sign-out and sign-in were verified with an existing isolated confirmed test user; personal password credentials were not requested or exposed.

## Hosted acceptance

All 15 requested acceptance requirements pass within the existing application's scope:

- Production loads and the actual Vercel build/TypeScript checks pass.
- Browser sign-in reaches TODAY; refreshed pages and a later sign-in restore persisted records.
- A browser-created synthetic proposal passes the deterministic preview and saved server risk check: 3.00R planned, $50 risk, 0.25 lots. Browser locking preserves the original and reserves the slot.
- Hosted Journal forms append a note, record actual entry and close the full position. Events remain visible; result is +1.90R after $5 fees.
- TODAY, JOURNAL, EDGE and a one-record CSV retrieve persisted results.
- Hosted screenshot upload and byte-for-byte delivery pass. The actual browser decodes the image. Browser soft removal creates one removal record, excludes it from future reviews and preserves private bytes and Journal history.
- Another user cannot read the private plan, proposal, image or account CSV, or upload to the foreign proposal. Signed-out private navigation redirects to login; image/CSV return 401. Public Storage object delivery is denied.
- Authenticated pages, screenshots and CSV return private/no-store headers and Vercel cache MISS, with nosniff and frame denial. Expired cookie metadata refreshes on hosted image and CSV routes.
- Production HTML and ten fetched browser JavaScript assets contain zero matches for the configured server secret or test passwords.
- AI shows its intentional disabled state; Analyze is disabled. A direct authenticated analysis API request returns DISABLED before provider execution. The three existing failed-evaluation events remain identical.
- A live read-only dashboard query reconfirmed migrations 0001–0007 and `setup-screenshots.public=false`.

[Eleven hosted HTTP/database check groups](PRODUCTION_SMOKE_VERIFICATION.json), [browser and Auth/database observations](PRODUCTION_BROWSER_VERIFICATION.json).

OpenAI calls: **0** during deployment and acceptance. Verification clients enforce an allowed-origin network guard and recorded zero attempted OpenAI requests. Production has AI disabled at the tested route/provider boundaries and no OpenAI key; the hosted disabled response and unchanged evaluation history confirm that path. This is configuration/code-path evidence, not an independent packet capture of Vercel's server network. The production error-log query returned no error logs during the acceptance window; it is not a comprehensive observability certification.

## Minimal deployment corrections and validation

1. The initial upload filter `supabase/` also excluded `src/lib/supabase`. Changing it to `/supabase/` preserves runtime files while excluding the seven root migration files. Runtime upload exclusions were checked as zero; the corrected hosted build passed.
2. Vercel Hobby rejected the preserved AI route's 800-second `maxDuration`. It is now 300 seconds, within the platform's reported limit. Provider integration, prompt, schema and history remain intact. Future AI activation must reassess multi-pass execution time against hosting limits.

Application dependencies and product behavior are otherwise unchanged. The approved baseline remains 325 passing tests. After the timeout setting change, 54 relevant AI-disabled/route/provider tests passed with live OpenAI blocked; the final Vercel production build and TypeScript check passed. Temporary acceptance tools had two read-only harness corrections (public login-page assertion and the removal table's screenshot key); no app defect or repeated synthetic trade was introduced.

Files changed for deployment: `vercel.json`, `.vercelignore`, `src/app/api/setups/[id]/analyze/route.ts`, `docs/DEPLOYMENT.md`, `docs/PRODUCTION_BACKUP.md`, this report and the production verification JSON reports. The release preparation refreshed secret-scan evidence. Operator tooling stays under ignored `.local/`.

## Isolated synthetic records retained

Only the existing isolated test user received a new synthetic account and trade. No personal trading account was modified.

- Account: `6b04e9fc-b23e-45c7-a4d2-26b3ea8b3894`, **Private production smoke · SYNTHETIC · 2026-09-14**.
- Proposal: `21633ff6-be1c-41a0-ba4a-9e3fc03c435c`.
- Closed plan: `2a40d399-df0b-4792-8b0d-cb5f6fa651a0`.
- Screenshot: `d4eee1c7-fb5f-4ca6-b684-408301c60075`, `production-smoke-synthetic.png`, soft-removed from future review and preserved privately.

These records are permanent acceptance evidence isolated from personal data; no cleanup is required for personal use. Do not bypass immutable-history protections to purge them. Earlier isolated audit fixtures also remain. The read-only dashboard verification query was saved privately by Supabase's SQL Editor. The test browser session was signed out after acceptance.

## Backup and remaining limits

Follow [the practical backup procedure](PRODUCTION_BACKUP.md): encrypted off-host PostgreSQL exports, a separate private screenshot byte/path/hash backup, and filtered EDGE CSV after active days. Free-plan automatic backup/PITR entitlement is not assumed. Database exports do not include screenshot bytes. No backup export or disaster-recovery drill was performed in this deployment; the user explicitly did not require the full drill before deployment.

Existing limitations remain: manual inputs and fixed UTC−5 strategy clock, full-position accounting, permanent actual-fill records, no broker execution or market/calendar feed, bounded CSV ranges for Vercel response limits, no new CSP rollout or automated screenshot backups. The source has a local committed release; no private Git remote was provisioned. Keep a private off-host source copy with backups.

There is no remaining AI-specific dependency blocking normal application use. Screenshot upload needs the separate Supabase server secret, which is configured. AI remains off until explicitly reauthorized; no further product phase was started.
