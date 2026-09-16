# Trading OS pre-deployment audit

Audit completed 2026-09-14 against the actual Next.js production build and the Trading OS Supabase project. Scope: UX V1.1 plus migrations 0001–0007. **GO FOR PRIVATE DEPLOYMENT**, subject to the normal deployment prerequisites in [the runbook](DEPLOYMENT.md). No deployment was performed.

There are no unresolved critical/high findings or known code blockers for private personal use. This conclusion is bounded by the verified manual/full-position workflow; it is not a hosted-environment or disaster-recovery certification. AI stayed disabled and the local production process ran with an empty OpenAI key. No paid API credits were used.

## Findings by severity

| ID | Severity | Finding and resolution |
|---|---|---|
| — | CRITICAL | None identified. |
| — | HIGH | None remaining; no exploitable cross-user data access or risk-reservation bypass found. |
| M1 | MEDIUM — fixed | The screenshot cap could be bypassed by concurrent uploads. Migration 0007 serializes registration and soft removal on the proposal row, enforces eight active images/4 MiB metadata, and the route cleans rejected objects and returns 409. Real nine-upload race: eight 201, one 409. |
| M2 | MEDIUM — fixed | Image/CSV routes were outside session-refresh matching. Proxy now refreshes and propagates cookies there, while route handlers retain JSON authentication failures and private caching. Real expired cookie metadata refreshed successfully on both routes. |
| M3 | MEDIUM — fixed | Note retries could append duplicate audit events. Client submission keys, a unique index and a keyed RPC make exact concurrent retries return one event; changed reuse is rejected. The unkeyed RPC is retained but access revoked. |
| M4 | MEDIUM — fixed | Same-owner/account provenance did not fully bind evidence decisions to their own proposal, or an outcome to its own execution/plan. Composite foreign keys now enforce those relationships. This was a defense against malformed privileged records, not a demonstrated tenant escape. |
| M5 | MEDIUM — fixed | PostgreSQL special numeric/timestamp values were not fully constrained in execution/outcome tables. Additive finite-value checks prevent NaN/Infinity even through privileged inserts. Normal RPC inputs were already bounded decimal strings. |
| M6 | MEDIUM — fixed | Several infrastructure/malformed-upload failures could be misclassified or reveal raw error details. Routes now distinguish outage/unauthorized/missing records, return safe messages, and log fixed operational categories. Tests cover failed DB reads/writes, storage upload/cleanup, malformed bodies, stale auth and CSV failures. |
| M7 | MEDIUM — fixed | Dismissing the unsaved-changes dialog unmounted it before native focus restoration. Closing it before unmount restores focus to the invoking link on Escape and Keep editing. Action-form errors are now associated with their fieldset and receive focus. Verified in the actual browser. |
| M8 | MEDIUM — fixed | Migration 0007 made the unqualified PostgREST evidence relationship ambiguous, breaking screenshot history after schema refresh. The loader now selects the complete relationship explicitly. Live acceptance requires actual page content so streamed errors cannot pass on HTTP status alone. |
| L1 | LOW — fixed | Added the common proposal/risk-check index and explicit Node 24 engine. Added deployment exclusions; replaced stale setup/readiness documentation. |
| L2 | LOW — accepted | No nonce-based CSP. React escaping, validated inputs, same-origin writes, nosniff and frame denial are present. A complete CSP rollout is deferred. |
| L3 | LOW — accepted | EDGE fetches history in 500-row batches then calculates in memory. Appropriate for personal use; multi-page reads are not a database-wide snapshot during concurrent writes. Very large hosted CSV exports need bounded date filters. |
| I1 | INFORMATIONAL | Free-project backup entitlement must not be assumed. Database exports exclude Storage bytes; manual/off-host object backup and a separate restore rehearsal are operational prerequisites for long-term reliance. A complete restore drill was not performed. |
| I2 | INFORMATIONAL | Actual fills are permanent, full-position records; partial accounting/correction workflows remain outside scope. Manual equity/news/loss/contract inputs and fixed UTC−5 semantics remain deliberate limitations. |
| I3 | INFORMATIONAL | No hosted deployment, full assistive-technology certification, or long-duration token-expiry soak was performed. The real refresh path and production-mode browser sanity checks passed locally. |

One live upload run encountered a temporary storage 503. It returned a safe retry message; the repeated race passed completely. Two initial new race fixtures had identical trade geometry and were correctly blocked as duplicates; distinct-price fixtures then verified the last-slot race. An old CSV assertion expected an exact cache header; it was updated to accept the stronger private/no-store header from session refresh. These were investigated rather than treated as application passes.

## Security and RLS

Live catalog verification: **32 application tables, all with RLS and immutable update/delete guards; zero unvalidated constraints; seven applied migrations**. Catalog review also verified empty `search_path` on security-definer functions, no anonymous execution of application security-definer RPCs, authenticated read grants only, and `journal_analytics` with `security_invoker=true`.

Below, **Owner** means `user_id = auth.uid()`. **Denied** means authenticated direct table writes have no grants; callers cannot bypass the intended RPC by making a raw REST insert/update/delete. Authorized RPCs validate owner/input and append records transactionally. An absent write policy is intentional. Anonymous table access is denied throughout.

| Table | RLS | SELECT | INSERT | UPDATE | DELETE | Notes |
|---|---|---|---|---|---|---|
| accounts | Yes | Owner | Denied | Denied | Denied | Root owner, auth FK |
| account_observations | Yes | Owner | Denied | Denied | Denied | Immutable observed values |
| strategy_versions | Yes | Owner | Denied | Denied | Denied | Historical strategy |
| risk_plan_versions | Yes | Owner | Denied | Denied | Denied | Effective-day version |
| instrument_versions | Yes | Owner | Denied | Denied | Denied | Contract specification |
| risk_evaluations | Yes | Owner | Denied | Denied | Denied | Trusted version/observation refs |
| trade_plans | Yes | Owner | Denied | Denied | Denied | Atomic immutable reservation |
| trade_events | Yes | Owner | Denied | Denied | Denied | Ordered events; keyed notes |
| configuration_events | Yes | Owner | Denied | Denied | Denied | Configuration audit |
| daily_contexts | Yes | Owner | Denied | Denied | Denied | Context revisions |
| chart_assets | Yes | Owner | Denied | Denied | Denied | Legacy evidence metadata |
| plan_chart_assets | Yes | Owner | Denied | Denied | Denied | Owner/account composite refs |
| ai_analysis_attempts | Yes | Owner | Denied | Denied | Denied | Preserved legacy attempts |
| trade_reviews | Yes | Owner | Denied | Denied | Denied | Preserved schema |
| strategy_experiments | Yes | Owner | Denied | Denied | Denied | Preserved schema |
| experiment_reviews | Yes | Owner | Denied | Denied | Denied | Preserved schema |
| bootstrap_requests | Yes | Owner | Denied | Denied | Denied | Idempotent bootstrap |
| setup_proposals | Yes | Owner | Denied | Denied | Denied | Immutable proposed parameters |
| setup_locks | Yes | Owner | Denied | Denied | Denied | Proposal-to-plan link |
| setup_risk_checks | Yes | Owner | Denied | Denied | Denied | Indexed proposal history |
| setup_screenshots | Yes | Owner | Denied | Denied | Denied | Validated server registration |
| setup_screenshot_removals | Yes | Owner | Denied | Denied | Denied | Soft evidence removal |
| setup_evaluations | Yes | Owner | Denied | Denied | Denied | Service-only evaluation writes |
| setup_evaluation_screenshots | Yes | Owner | Denied | Denied | Denied | Same-proposal evidence FK |
| setup_evaluation_events | Yes | Owner | Denied | Denied | Denied | Failed history retained |
| setup_evaluation_passes | Yes | Owner | Denied | Denied | Denied | Provider pass history |
| setup_human_decisions | Yes | Owner | Denied | Denied | Denied | Same-proposal evaluation FK |
| trade_executions | Yes | Owner | Denied | Denied | Denied | One finite actual entry |
| trade_outcomes | Yes | Owner | Denied | Denied | Denied | Same-plan execution; finite outcome |
| trade_dispositions | Yes | Owner | Denied | Denied | Denied | Append-only skip/cancel |
| trade_tag_revisions | Yes | Owner | Denied | Denied | Denied | Manual tag revisions |
| evaluator_versions | Yes | Authenticated shared read | Denied | Denied | Denied | Global immutable prompt/schema; no tenant data |

Both isolated users were exercised against **all 31 tenant tables**, in both directions, with cross-owner reads and attempted direct writes. Foreign plan/setup URLs disclosed no private record; image/upload/close/lock/disposition/removal operations rejected foreign IDs. Next.js may stream a not-found page with HTTP 200 and its not-found marker; absence of foreign data was checked as well as status. APIs return explicit 401/404 rather than relying on that HTML status behavior. Evidence: [41 live groups](PREDEPLOY_LIVE_VERIFICATION.json).

Composite ownership/account foreign keys prevent tenant forgery. Public commands use `auth.uid()` and locks; server-only operations load a permitted record before deriving ownership. No SQL built from arbitrary client text, no dangerous filename-derived paths, no public service key, and no open redirect was identified. Sensitive data loaders/actions authorize server-side; navigation/proxy checks do not replace data authorization. Server Actions retain Next's same-origin checks; mutating routes validate Origin.

Actual configured secret values and isolated-user passwords were searched across eligible source/docs and the production browser bundle: **zero matches**. `.env.local` and `.local/integration-users.json` are ignored. Logs use fixed operational event/status fields rather than raw payloads/errors. Infrastructure/auth logs remain separate from immutable trade events. [Secret verification](PREDEPLOY_SECRET_VERIFICATION.json)

## Storage, auth and AI-disabled behavior

The screenshot bucket is private and limited to 4 MiB objects. Owner access requires registered metadata; foreign listing is empty, foreign/anonymous downloads fail, and direct authenticated uploads/writes are denied by restrictive policies. The server generates user/proposal/random-ID paths, validates MIME/signature/decoder, dimensions/frame limits and bounded request bytes. Display is authorized, private/no-store and nosniff. Failed registration cleans up its upload; cleanup failure logs an operational category for investigation.

Soft removal excludes evidence from future analysis but preserves bytes and metadata for history. Removed images remain privately accessible to their owner. Concurrent nine-upload acceptance, replacement after soft removal, missing images, dangerous filename input and foreign IDs were tested. [Live flow evidence](PREDEPLOY_FLOW_VERIFICATION.json)

Signed-out/stale sessions cannot obtain private pages, JSON or CSV; redirects happen before private rendering. Browser session restoration, sign-out/re-login and real Supabase cookie refresh on image/CSV paths were checked. Auth outages return safe failure states; the database RLS remains authoritative. Public signup is disabled.

The build, startup, login, planning, risk, locks, notes, Journal, screenshots, events, analytics and export all worked with **AI_ENABLED=false and OPENAI_API_KEY empty**. Analyze returns a neutral disabled state without creating evaluation records. Existing failed evaluation history remained identical. Provider/prompt/schema and migrations were not deleted. Enabled-with-missing-key and invalid model configuration are AI-only failures covered by tests. No remaining AI-specific dependency blocks normal usage; screenshot upload still needs the separate Supabase server secret.

## Risk, outcomes, analytics and time

Reviewed JavaScript Decimal calculations against authoritative PostgreSQL NUMERIC commands. Independent integer arithmetic covered 400 long/short sizing/RR boundaries. Existing tests cover invalid stop/target geometry, minimum RR, risk percent/budget, quantity floor/ticks, stale governing versions/observations, reason ordering, monetary caps, reserved risk and unknown inputs. Account row locks serialize daily reservations; identical retries replay, changed reuse rejects, blocked checks create no plan/slot. Same-proposal double lock and two distinct contenders for the last daily slot passed live. No AI output participates in these decisions.

Actual entry/full close validates prices, quantity, fee precision, tick/step and timestamp ordering. The original plan/risk denominator is immutable; net actual P&L includes round-trip fees. Independent mixed long/short ledger `[1.90, 0.96, -1.02, 0]` yielded net 1.84R, expectancy 0.46R, average winner 1.43R, average loser -1.02R and drawdown 1.02R. Database/browser tests confirm fees and denominator; duplicate close returns the existing outcome without another event, changed/invalid closes fail, and closed rows cannot be overwritten.

Independent and existing analytics fixtures cover zero/one trade, all wins/losses/breakevens, +/-1e60 outcomes, fee mixes, timestamp ties, streaks, profit factor undefined states, cumulative curve/drawdown, expectancy, session/weekday/sequence, OB/OTE, historical strategy/risk versions and filtered CSV. Finite values are verified for supported inputs; no NaN/Infinity reaches those UI fixtures. Exact timestamp ties have stable display ordering and unknown economic sequence, avoiding invented trade order.

Live three-trade form flows produced +2R, -1R and 0R, correct EDGE metrics and filtered CSV; historical synthetic fixtures verified all four sessions, weekdays and version/date filters. The browser additionally produced **+1.90R = $95 net / $50 original risk**, with $5 fees. [10 EDGE acceptance groups](EDGE_LIVE_VERIFICATION.json)

Session boundaries are fixed UTC−5: Asia 18:00–01:00, Judas 01:00–02:00, Active 02:00–12:00, Dead Pool 12:00–18:00. Tests cover 00:59, 01:00, 01:59, 02:00, 11:59, 12:00, 17:59, 18:00, cross-date conversion and Madrid DST transitions. Local display timezone never changes risk policy. A real Dead Pool run blocked locks on Sep 12; an Active run permitted/serialized them on Sep 13. No live clock override was used.

## Performance, dependencies and reproduction

Journal reads are paginated (50 rows), with batched related data; list views do not load every screenshot's bytes. EDGE uses 500-row keyset batches; charts and breakdowns operate in memory for personal history. Common ownership/version/history paths are indexed; 0007 adds the missing proposal/risk-check index. No material N+1 query or unnecessary full-resolution list payload was found. Trusted administrator corruption and unbounded future multi-user workloads are outside normal RPC/input bounds.

Pinned dependencies were retained; no blind major upgrades. Direct dependency uses were inspected (UI utilities, Supabase, Decimal/Zod, image decoding, AI schema validation). The 2026-09-13 full dependency audit reports **0 known vulnerabilities**, including development dependencies. [Registry audit](DEPENDENCY_AUDIT.json)

A clean copied source tree with no `.env.local` or credential file installed successfully from the frozen lockfile using Node 24.19.0/pnpm 11.19.0, passed all 325 tests, and built with all Supabase/OpenAI variables empty. Its nested temporary location caused a workspace-root warning, not a build failure. Normal production build with configured Supabase and an empty OpenAI key also passed. Documentation now supplies complete setup/migration/user/env/run/check instructions; opt-in live fixture files are explicitly separate.

## Verification totals and limits

| Check | Result |
|---|---|
| Automated suite | **325 / 325**, 16 files; original 298 retained, 27 new audit regressions |
| Lint | Pass, 0 errors / 0 warnings; 31 non-blocking template-style informational suggestions |
| Strict TypeScript | Pass |
| Production build, Supabase configured / no OpenAI key | Pass |
| Clean frozen install / tests / credential-free build | Pass |
| Real two-user security / storage / disabled AI | **41 groups passed** |
| Real retry / final-slot / upload / session-refresh flows | **9 groups passed** |
| Real entry/close / EDGE / filtered export / historical fixtures | **10 groups passed** |
| Browser acceptance | See [browser evidence](PREDEPLOY_BROWSER_VERIFICATION.json) |
| OpenAI requests attempted by guarded production runtime | **0**; see [network evidence](PREDEPLOY_AI_NETWORK.json) |

Injected failures were tested without causing a deliberate outage to the real Supabase project. The real temporary storage failure independently exercised the safe operational failure path. Browser checks are sanity acceptance, not an automated accessibility certification or every-device matrix. Supabase outages still make persistence unavailable; the application reports that state safely. No claim is made that remote persistence works offline.

## Files changed

Application/configuration: `src/proxy.ts`; `src/lib/operational-log.ts` (new); `src/lib/setup-data.ts`; `src/lib/route-security.ts`; `src/app/api/setups/[id]/screenshots/route.ts`; `src/app/api/screenshots/[id]/route.ts`; `src/app/actions.ts`; `src/app/setup-actions.ts`; `src/app/journal-actions.ts`; `src/components/forms.tsx`; `src/components/unsaved-changes.tsx`; `src/app/journal/[id]/page.tsx`; `package.json`; `.vercelignore` (new); `vitest.config.ts`.

Database: `supabase/migrations/0007_audit_hardening.sql` (new and applied). Migrations 0001–0006 remain unchanged. Existing AI source/schema/prompt/history retained.

Tests/tools: `tests/audit-database.test.ts`, `tests/audit-routes.test.ts`, `tests/audit-math.test.ts`, `tests/no-live-ai.ts`, `scripts/verify-audit-live.mjs`, `scripts/verify-audit-flows.mjs`, `scripts/no-openai-network.mjs` (new); `scripts/verify-edge-live.mjs` (private-cache assertion updated). Original test files preserved.

Documentation/evidence: `README.md`, this report, `DEPLOYMENT.md`, `DEPENDENCY_AUDIT.json`, `MIGRATION_CHECKSUMS.json`, `PREDEPLOY_LIVE_VERIFICATION.json`, `PREDEPLOY_FLOW_VERIFICATION.json`, `PREDEPLOY_BROWSER_VERIFICATION.json`, `PREDEPLOY_AI_NETWORK.json`, `PREDEPLOY_SECRET_VERIFICATION.json`, `PREDEPLOY_DATABASE_VERIFICATION.json`, `EDGE_LIVE_VERIFICATION.json`. Temporary helpers/copies remain only in ignored `.local/` and are not application dependencies.

## Decision

**GO FOR PRIVATE DEPLOYMENT.** Complete the runbook's release/env/auth/backup/hosted-smoke prerequisites when deployment is explicitly authorized. Keep AI disabled. Retain the documented full-position/manual-input, CSP, very-large-export, accessibility-certification and restore-drill limitations. Do not treat this approval as authorization to deploy automatically.
