# Connected persistence verification

Verified against **Trading OS**, project `txodopkdigulyqkdgheb`, Supabase PostgreSQL 17.6, on 2026-09-05. The deterministic persistence phase is complete. No AI chart analysis or broker operations were added.

## Changes and migration review

Original migrations 0001 and 0002 were preserved. Additive 0003 introduces owner-scoped idempotent bootstrap requests, authenticated explicit risk evaluation, immutable evaluation provenance, report revision 1.1 and query indexes.

UUID primary keys, composite user/account/version foreign keys, uniqueness, bounded decimal inputs, canonical timestamps and immutable UPDATE/DELETE triggers remain enforced. Ownership is checked before protected reads/writes. Historical references are retained; auth-user deletion is restricted by retained records rather than cascading away the journal. Database administrators remain outside application RLS protection.

Account-row locks serialize evaluations and daily reservations. Server time is obtained after acquiring the lock. Lock retries compare the full proposal, including null safely; duplicate instrument identity uses canonical UUID comparison. Lock, evaluation and original event share one transaction. Unknown policies and skipped calculations are not reported as passing.

## Applied migrations

The SQL Editor applied transactional wrappers and recorded source in Supabase migration history. Browser paste normalized line endings to CRLF. Returned source MD5 hashes exactly match local files normalized to CRLF; content and other whitespace are unchanged:

| Version | Name | Source MD5 |
|---|---|---|
| 0001 | foundation | 30dd4a9fb00c27ab3f167c1d51e6701e |
| 0002 | baseline | 2e211478dc8b7f40b8aff18684d016ed |
| 0003 | persistence | 09f14c775c3fd226ba5b61d8877d316f |

One baseline editor attempt contained mixed query text and was rejected with a syntax error. No partial baseline was applied; the corrected transaction succeeded and its stored source matched after line-ending normalization. Initial test-user attempts failed before network access; an empty Auth user list was verified before retry. Exactly two confirmed development users were then created.

## RLS policy inventory

Every table below has RLS enabled and exactly one `read_own` SELECT policy:

`FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()))`

| Tenant tables |
|---|
| accounts, account_observations, strategy_versions, risk_plan_versions, instrument_versions |
| risk_evaluations, trade_plans, trade_events, configuration_events, daily_contexts |
| chart_assets, plan_chart_assets, ai_analysis_attempts, trade_reviews, strategy_experiments, experiment_reviews |
| bootstrap_requests |

Authenticated users have SELECT only; no direct INSERT/UPDATE/DELETE grant or write policy. Anonymous users have no table access. Every table has an immutable UPDATE/DELETE trigger.

Allowed authenticated owner-checking RPCs use SECURITY DEFINER with empty search_path: bootstrap_demo_account, evaluate_trade_plan, lock_trade_plan, record_observation, create_risk_version, append_plan_note and save_daily_context. Application roles cannot execute private functions or the old non-idempotent create_demo_account seed.

Journal reads trade_plans and trade_events. There are no separate trades/journal tables. Screenshot metadata is protected, but no Storage bucket/object policy or upload feature exists.

## Actual results

| Check | Result |
|---|---|
| Local automated tests | 122 passed, 5 files; original 87 retained |
| Lint | Passed; zero errors/warnings, five informational style suggestions |
| Strict TypeScript | Passed |
| Next.js production build | Passed |
| Real network acceptance | 9 groups passed; see LIVE_VERIFICATION.json |
| Two-user ownership | A cannot read B and B cannot read A across all 17 tables |
| Anonymous access/direct writes | Denied; direct plan and version mutation denied |
| Bootstrap replay | Same account and initial versions; conflicting input rejected |
| Explicit approved/blocked checks | Persisted with provenance; no slot reserved |
| Lock replay/audit | Same original ID; no extra lock event/evaluation |
| Concurrent final slot | Two independent authenticated requests; exactly one succeeded |
| Login cycle | Fresh session retrieved the same plan and historical labels |
| Private routes | Signed-out and invalid-cookie requests redirected with no-store headers |
| Browser workflow | Sign-in, first-account setup, blocked 0.51%, corrected 0.50%, approval, lock, refresh, Journal, note, sign-out/in all verified |
| Browser session restoration | Visiting login while signed in redirected to Today |
| Real session refresh | Supabase refreshSession followed by verified user and plan reads passed |
| Browser preserved plan | 5c9e535e-6638-45a8-b2a8-84ebe117ba1d |

The browser plan preserves EURUSD LONG, OB_FIRST_TOUCH, entry 1.10000, stop 1.09800, target 1.10600, 0.50%, USD 50 nominal risk, 3R and the original version IDs. PLAN_LOCKED and NOTE_ADDED remained after refresh and fresh login.

All live locks used the actual database clock in Active Kill Zone; no production clock bypass exists. Local tests separately exercise every requested session minute boundary, date/year/leap rollover, daylight-saving independence, early blocked reports and approval invalidation. BROWSER_VERIFICATION.json records the browser checks and final production validation; its migration hashes use the SQL Editor's CRLF-normalized source.

## Configuration and remaining user actions

The ignored .env.local contains only NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. No secrets were committed and no admin key is used by the application. Public signups are disabled; anonymous sign-in is disabled.

Open http://127.0.0.1:3000/journal. Development login credentials are in ignored .local/integration-users.json. No project-connection action remains. For personal use, create your own confirmed email/password user through Supabase Authentication → Users → Add user, then create your account in the app.

Synthetic accounts and immutable records were deliberately retained for inspection. Do not disable constraints or erase history merely to clean them up.

## Limits of this evidence

Reserved screenshot/AI/experiment tables have no feature data: policy structure and denial checks passed, but unimplemented uploads or AI workflows are not claimed as tested. No trade execution, closure, cancellation/release or analytics exists. Numeric risk excludes fees/gaps/slippage; daily caps and news remain explicit missing/user-reported inputs. Browser session restoration and invalid-cookie handling were checked, not a multi-hour expiry soak. No Vercel/GitHub deployment or broad device certification was performed.
