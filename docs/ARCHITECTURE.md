# Trading OS — V1 architecture

Status: implementation begins with the deterministic vertical slice. This document is the committed design, not a claim that all V1 features exist.

## 1. System boundary

One strict TypeScript Next.js App Router application, Tailwind CSS and shadcn-style accessible Radix primitives. Server Components read private data; Server Actions validate commands and authenticate against Supabase Auth. PostgreSQL is authoritative for locking, exact numeric risk checks and audit persistence. Supabase Storage will hold private chart objects. Vercel is the deployment target. No broker credentials or execution endpoints exist.

The browser computes a Decimal.js preview for responsiveness. A PostgreSQL transaction independently recomputes the decision using current account data and immutable strategy/risk/instrument versions. Only that transaction can lock a plan. Never trust a browser verdict, equity, clock, owner ID, or calculated size.

Authentication uses cookie-based Supabase SSR, refreshed by Next.js proxy; each private page and action verifies the user. User JWTs, not service-role keys, invoke narrow RPCs. Every tenant table has RLS; critical tables grant SELECT only, with writes behind authenticated SECURITY DEFINER functions with a fixed search_path and explicit owner checks. No credentials are required for the isolated, synthetic risk preview.

## 2. Repository

```
src/app/                 login, preview, private Today/Analyze/Journal/Settings
src/components/          workstation UI and accessible primitives
src/domain/              immutable ICT definition, risk types, decimal engine, sessions
src/lib/supabase/        server client and authenticated data access
src/ai/                  provider-neutral schema, validation, evaluator prompts
supabase/migrations/     ordered PostgreSQL schema, RLS, immutable records, atomic RPCs
tests/                   arithmetic, boundaries, contract and database integration
docs/                    architecture, risk specification, implementation/runbook
```

## 3. Database model

The executable schema is `supabase/migrations/0001_foundation.sql`.

`accounts` belong to `auth.users`. `account_observations` append manual balance/equity snapshots. `strategy_versions` contain the full immutable written rule set and a schema version. `risk_plan_versions` are separate, immutable, account-specific, effective-dated configurations. `instrument_versions` pin sizing units, tick/pip size, tick value in account currency, quantity step/minimum and assumptions. Unsupported contract/currency conversions cannot be sized.

`trade_plans` permanently reference all three versions and the account observation. Prices, narrative, evidence classifications, deterministic results and lock timestamp are immutable. `trade_events` append subsequent changes. Locking reserves a daily slot and its initial monetary risk; a reservation is not represented as an executed trade. The first slice retains reservations conservatively until explicit execution/cancellation workflows are implemented. `daily_contexts` preserve premarket narrative revisions. Future chart, analysis, outcome, review and experiment tables maintain owner IDs, schema versions, immutable references and append-only histories.

All timestamps use timestamptz. A trading day is midnight–midnight at the strategy's fixed UTC−05:00 offset, not New York daylight-saving time or browser time. Asian range crosses the date boundary; session windows are start-inclusive and end-exclusive.

## 4. Strategy versions

Seed exactly ICT V1.0. Preserve the user's source request in `docs/PRODUCT_REQUIREMENTS.txt`. Store both structured deterministic parameters and complete qualitative definitions. OB_FIRST_TOUCH and OTE are valid. Bullish OB uses the bearish displacement-origin reversal candle's open/body down through its lower unmitigated wick; bearish mirrors it. The first proximal-edge mitigation needs no invented extra confirmation. MSS must be meaningful, never automatically inferred from a crossed line. Equal highs/lows are not automatically external liquidity. AI cannot create or edit strategy versions.

Future changes require an explicit user-created version or experiment; never migrate historical plans to new definitions. Grading policy is independently versioned and pending configuration, rather than fabricated cutoffs.

## 5. Risk plans

Initial Risk Plan V1.0: maximum 0.50% per trade, two daily slots, minimum RR 3 enforced as BLOCK. Daily monetary risk/loss caps are nullable because no values were supplied. Their unconfigured status is visible. Costs/slippage are recorded as unknown in the first slice, so sizing is nominal stop risk only. Values cannot rise following wins, losses or AI confidence.

New risk versions activate the next strategy day by default. A deliberate same-day effective version requires an explicit override reason and an append-only configuration audit event. Existing trades retain the previous version. An account lock serializes risk changes with trade locks.

## 6. Risk engine

See `RISK_ENGINE.md`. Typed input → exact decimal calculations → rule findings → RISK APPROVED / TRADE BLOCKED. Risk approval alone never establishes ICT setup validity. Missing or ambiguous qualitative evidence stays unresolved. Hard blocks dominate warning grades, AI decisions and manual narratives.

## 7. AI contract

`src/ai/evaluation.schema.json` is the strict backend JSON Schema; `src/ai/validate.ts` also checks semantic/provenance consistency. `src/ai/evaluator-system-prompt.txt` is the exact shared evaluator instruction. A/B and reconciliation stage prompts are separate. No model is called in this slice. The future provider adapter uses Responses structured outputs; its model is server configuration, initially `gpt-6-astra` subject to account access verification. The AI cannot call write-risk, write-strategy or execution tools. Calculations and stats are read-only deterministic tools.

Observed, user-reported and inferred evidence never collapse into one category. Every observation references provided source material. Unknown is nullable, never false. Refusals, incomplete responses, malformed JSON or semantic failures remain failed attempts and cannot be saved as valid analyses. Store prompt/schema/model identifiers, input hashes, stage outputs and deterministic verdict with each run. Scores measure classification/process, never probability of profit.

## 8. Full V1 flow after foundation

Private screenshots → evaluator A plus independently prompted evaluator B → reconciliation → schema/semantic validation → deterministic decision merge → lock the evidence and plan → append execution events → manual close → separate financial and process review → journal and statistics. Hard risk blocks always win. Weekly review selects at most two evidence-backed improvements. Every aggregate shows sample size and separates versions/models. Experiments are isolated; AI cannot promote them automatically.

## 9. First vertical slice order

1. Preserve requirements; create this architecture, schema and test harness.
2. Implement session and exact risk functions with critical tests.
3. Implement schema, RLS, immutable records and atomic lock RPC; run PostgreSQL integration tests.
4. Add authenticated account creation, ICT/risk baseline loading and manual account observations.
5. Build Today, trade-plan risk preview, server lock, immutable plan detail and event history.
6. Add versioned risk settings and visible unknown/unconfigured states.
7. Validate types, tests and production build; provide a usable local preview and Supabase/Vercel setup runbook.
8. Next slice: screenshot upload and evidence preservation, then structured AI evaluation. Journal close/review and edge analytics follow, then weekly review. Advanced analytics/integrations are deferred.

Database invariants precede UI work because risk limits and history must survive concurrent submissions and direct API calls. AI schema and prompts are delivered now as design artifacts; chart interpretation is deliberately not connected before the foundation is verified.

## Verified platform references

- [Next.js installation](https://nextjs.org/docs/app/getting-started/installation)
- [Supabase SSR clients and verified authentication](https://supabase.com/docs/guides/auth/server-side/creating-a-client)
- [PostgREST column casts for exact decimal JSON](https://docs.postgrest.org/en/stable/references/api/tables_views.html#casting-columns)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)

Public documentation is not proof of provisioned credentials or successful hosted integration.
