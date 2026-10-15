# Account AI permission and monthly budget — feature review

This is a local feature branch (`feature/account-ai-budget`) based on production commit `79ab1496bf0cb8e1807f3b83ef3c6ca96cf404bb`. No deployment, production migration, production environment edit, provider-key installation or production activation is part of this work.

## Architecture and authorization

The selected Trading OS account (the existing `accounts.id`, owned by the authenticated Supabase user) is the budget boundary. Each trading account has its own permission and EUR cap; this is not a pooled per-login budget. Trading-account USD balances and AI EUR budgets are separate concepts.

New and existing accounts without an authoritative preference default to OFF and €5. No migration silently creates consent. Owners can choose €1–€100 in cents, including €3, €5 and €10. There is no unlimited option and no automatic increase.

`AI_ENABLED=true` remains mandatory. The existing global disabled response and provider-level kill switch remain. The shared `budgetedAiRequest` requires configured server credentials, reviewed model/pricing/output limits, authenticated ownership supplied by the session-scoped setup loader, atomic account opt-in and sufficient budget. The database independently verifies the user/account pair. Budget editing uses the user's authenticated client, not an admin client. Privileged accounting operations use only the existing server-only Supabase credential.

The existing setup analysis is the only connected AI operation. Each normal/deep pass uses the same gate. There is no page-open provider request. Deep mode may stop between passes if permission or capacity changes; earlier results remain recorded. Future operations must register an envelope and reviewed adapter/pricing profile; they use the existing gate and never import the provider directly. A test checks imports, and the provider requires a process-local one-use permit for live transport. Existing adapter tests can inject an in-memory transport only in `NODE_ENV=test`; the shared test preload rejects OpenAI network traffic.

## Database / RLS

Migration: `supabase/migrations/0008_account_ai_budget.sql`. It has been applied only to isolated test databases. Existing migrations and domain tables/functions are unchanged.

Four append-only owner-scoped tables:

- `ai_preference_events`: prior/new opt-in and budget, authenticated responsible user, account, server timestamp, disclosure version.
- `ai_request_reservations`: operation/stage, owner/account, provider/model, request hash, immutable operation/envelope and pricing snapshot, integer EUR micro-unit reservation, original billing month and timestamp.
- `ai_request_dispatches`: single-use dispatch authorization, linked to the same owner/account/reservation.
- `ai_usage_records`: immutable reconciliation, raw usage, token details, response ID/model, charged estimate, disposition and error code.

All enable RLS, grant owners SELECT through `auth.uid()`, and deny anonymous access. Authenticated users and the service role cannot directly insert/update/delete these tables. Composite foreign keys enforce ownership. The existing immutable trigger rejects updates/deletes, including privileged accidental mutation.

Owner RPCs: `get_account_ai_budget` and `set_account_ai_preferences`. Accounting RPCs (`reserve_account_ai_request`, `dispatch_account_ai_request`, `settle_account_ai_request`) are executable only by `service_role`. Helpers live in the private schema. All definer functions pin an empty search path and use schema-qualified objects. Clients cannot submit authoritative costs or forge usage records.

Budget changes, reservations, dispatch and settlement all lock the same `accounts` row for their short database transaction. They never hold that lock during provider I/O. The accounting query includes settled costs plus all unfinalized reservations. Dispatch and the pre-generation recheck both verify opt-out, a lower cap, uncertainty, request hash and month boundary. A request authorized before an opt-out commits is in flight; the UI explains that it may finish and be charged. Requests authorized afterward are blocked.

## Monthly period

Calendar months use fixed UTC−5, with no daylight-saving or browser-timezone conversion. A period starts on day 1 at 00:00 UTC−5 / 05:00 UTC. PostgreSQL is authoritative for the period and next reset. Settings prints that exact policy and the next reset timestamp.

Reservation and settlement stay attributed to the dispatch/reservation month, including a response finishing after the boundary. Undispatched reservations cannot cross a month boundary. New periods query a new ledger window; no history is reset or deleted. A lowered cap never rewrites previous consumption. Raising it restores eligibility only if every other gate passes.

## Pricing, reservation and failure policy

The former hold was **€32.76 per pass**: (1,050,000 × $12.50/M × 2 + 14,000 × $50/M × 1.5) × 1.20. It priced the full theoretical model context with long-context surcharges. This was safe but made small budgets unusable.

### Operation registry and adapters

`src/ai/operations.ts` is the single reviewed operation registry, version `BOUNDED_SETUP_V1`. Every entry declares provider, model, effort, total input ceiling, total output ceiling (reasoning included), image count/detail, tool permissions, timeout, pricing profile and reservation safety multiplier. Unknown keys (including inherited object properties) fail before reservation or provider contact. Deployment environment variables cannot silently substitute an unreviewed model/effort. The gate requires an explicit operation ID; the setup orchestrator maps its existing A/B/reconciler stages to registered IDs.

| Operation | Provider/model | Effort | Max input | Max output | Images | Tools | Maximum hold |
|---|---|---|---:|---:|---|---|---:|
| SETUP_ANALYSIS | OpenAI / gpt-6-astra | high | 32,000 | 8,000 | ≤8, high detail | none | €1.056 |
| SETUP_CHALLENGE | OpenAI / gpt-6-astra | high | 32,000 | 8,000 | ≤8, high detail | none | €1.056 |
| SETUP_RECONCILE | OpenAI / gpt-6-astra | high | 48,000 | 8,000 | ≤8, high detail | none | €1.320 |

Normal analysis is one pass. Deep review is up to three separately authorized passes (maximum combined estimates €3.432 before usage releases). A €3 budget can fund two maximum normal requests; €5 can fund four and €10 nine, with more capacity released when actual usage is lower. A €3 budget is not promised a full worst-case deep review.

`provider-contract.ts` defines provider-neutral request/result types; `providers.ts` selects a fail-closed adapter. Adapters own wire format, exact input counting, generation and usage normalization. The gate owns permissions, atomic budget accounting and reconciliation. OpenAI is the only implemented adapter; this is extensibility, not a claim of live multi-provider support. A future provider needs a reviewed adapter, credential-name mapping, pricing profile and bounded operations, without new budget/RLS logic. SQL stores operation/provider/model metadata without an OpenAI-only constraint; only trusted server accounting RPCs can insert it. Unknown operations are rejected by the authoritative application registry, not a duplicated SQL registry.

### Enforced request limits

The gate snapshots the request, checks the deployment/configuration, selects the registered operation/adapter/pricing, reserves atomically and obtains single-use dispatch authorization **before any provider contact, including token counting**. The adapter assembles an immutable input from instructions, schema, context, prior outputs and inline evidence. It sends the exact input-bearing fields supported by the token-count endpoint: model, instructions, input, reasoning, text/schema and truncation. Generation-only fields (output cap, storage and service tier) are excluded from counting. No remote image URLs, files, conversations or tools can introduce uncounted mutable input.

The provider's authoritative input count must be a nonnegative integer at or below the operation's ceiling. Oversized or uncountable input never reaches generation. This is a pre-generation server check, not a nonexistent `max_input_tokens` parameter or a character-count guess. The same immutable input is then generated with `max_output_tokens=8000`, standard service tier and truncation disabled. A second account-lock/RLS accounting check after counting observes opt-out, cap reduction, month changes and uncertainty before generation. The global switch and pricing expiry are also rechecked. No automatic provider retry occurs.

### Versioned pricing and conversion policy

`src/ai/pricing.ts` contains the versioned profile `ASTRA_EUR_2026_09_23`, valid until **2026-10-22 00:00 UTC**. Prices, long-context multipliers and the fixed conversion policy are centralized. Unknown/expired/mismatched profiles fail closed.

Official references inspected on 2026-09-23:

- [Astra pricing](https://developers.openai.com/api/docs/models/gpt-6-astra): USD per million input 10, cached input 1, cache write 12.5, output 50. The initial bounded operations stay below the long-context threshold.
- [Input counting guide](https://developers.openai.com/api/docs/guides/token-counting) and [count request fields](https://developers.openai.com/api/reference/python/resources/responses/subresources/input_tokens/methods/count): exact counts include input structure, images and schema overhead.
- [Responses request contract](https://developers.openai.com/api/reference/cli/resources/responses/methods/create): output ceiling includes reasoning tokens.

Reservation = ceiling((operation max input × highest applicable input rate + operation max output × output rate) × `usdCostToEurBudgetMultiplier` × operation safety multiplier). The initial safety multiplier is **1.10**. Amounts use EUR millionths; rates are USD per million tokens, so those million factors cancel in micro-unit arithmetic. The 32K/8K formula is (32,000 × 12.5 + 8,000 × 50) × 1.20 × 1.10 = 1,056,000 micro-EUR.

`usdCostToEurBudgetMultiplier=1.20` means **one estimated USD of provider usage debits 1.20 EUR of application budget**. It is a fixed conservative policy, not a EUR/USD exchange quote, live FX feed or provider invoice. No automatic tariff/FX/budget changes occur.

Reconciliation uses returned input/output/cached/cache-write/reasoning metadata and the reserved pricing snapshot. Reasoning is already in output and is not counted twice. Missing cache-write detail receives the conservative higher input rate. Costs round upward to one EUR millionth. Valid usage releases all unused reservation, including unused margin. Over-envelope usage, unexpected models or malformed usage fail closed and retain the hold. Existing evaluation-pass usage and failed evaluations remain intact.

| Outcome | Accounting |
|---|---|
| Definitely not dispatched | CANCELLED; zero cost; release hold |
| Successful, refused, incomplete or invalid-output response with usable usage | SETTLED from returned usage, release unused reservation; retain evaluation outcome |
| Count failure/oversize input after dispatch, timeout, network loss, missing/malformed usage, unexpected model, or bounds violation | UNCERTAIN; retain full reservation as estimated charge; stop further account AI pending accounting review |
| Accounting persistence failure / process crash | Keep the original hold; never retry provider automatically or assume zero cost |
| Ambiguous dispatch RPC outcome | Refund RPC refuses if dispatch actually committed; hold remains |

Uncertain history is not automatically refunded at month reset or cleared by raising the cap. There is deliberately no browser override. Resolving such an account requires an operator to compare provider records and introduce an audited append-only resolution in a separately reviewed change; this initial feature does not ship an administrative refund tool.

The count endpoint does not generate model output, but the official references inspected do not establish a billed-cost contract for token counting. No zero-cost invoice claim is made. All preflight contact is permission/budget gated; if preflight fails or rejects input after dispatch, this implementation conservatively records UNCERTAIN and retains the full hold. Confirm counting billing/limits and real image/schema counts in an explicitly authorized staging acceptance before activation.

The hard cap is an application estimated-cost limit. Provider tariff changes, currency conversion, taxes, credits, pricing-tier anomalies and invoice adjustments can differ from this ledger; it is not the provider's final invoice or an account-wide provider spending limit. Provider-side project spend controls should be configured separately before live use. No provider request or billed test was needed here: test cost €0.

## Settings UX

State precedence: deployment/configuration/accounting failure → UNAVAILABLE; opted out → OFF; opted in with committed capacity at/above cap → BUDGET REACHED; otherwise ON. An ON account can still lack the minimum reservation; Analyze remains disabled with an explanatory message.

Enabling requires opening an explicit disclosure, checking an initially unchecked confirmation and submitting "Confirm and enable AI". The server and database validate consent. Disabling remains available even when the deployment is unavailable. Budget updates preserve the latest opt-in atomically, and activation preserves the latest budget; stale forms cannot silently re-enable AI or raise the cap.

The panel displays monthly cap, estimated usage, pending reservations, estimated remaining, committed percentage, reset, provider/model, required reservation, advisory status, and the latest 12 preference/budget audit changes. Warning text at 50%, 80%, 95% and 100% supplements the progress indicator. Warnings are persistent inline status, not repeated notifications. Full historical ledger and audit rows remain owner-readable through RLS.

## Deterministic isolation

Risk Engine, position sizing, RR, slots, sessions, strategy definitions, trade locking, execution, realized R, EDGE formulas, screenshot security, authentication/authorization and CSV: **NO changes**. Missing AI migrations/configuration are contained within the AI Settings panel. AI limits never become trade permission or risk authority.

## Verification

Final verification results: **519/519 tests passed, 0 failed, 0 skipped across 22 files**. Lint: 0 errors, 0 warnings (30 existing informational diagnostics). Strict TypeScript and production build passed on Node 24.19.0. Secret scan: 186 source candidates and 18 browser assets, no findings. The machine-readable results are in `docs/AI_BUDGET_VERIFICATION.json`. During implementation only targeted tests were run; the full suite is run once after completion. Existing 410 baseline tests remain unmodified.

Native PostgreSQL concurrency uses 20 independent connections for each of €3, €5 and €10: admitted/rejected 2/18, 4/16 and 9/11, with holds €2.112, €4.224 and €9.504. Sixty requests in total. All caps held; concurrent opt-out and cross-user denial passed. PostgreSQL is loopback-only and stopped after testing. PGlite tests independently cover all eight migrations, RLS/ownership, immutable history, boundary resets, lowered/raised budgets and post-count authorization.

**Current-revision local Settings browser acceptance: PASS (2026-09-23).** The connected Codex browser tested the actual Settings component/server actions with synthetic authentication and local PGlite. Deployment availability and usage were explicit fixtures. No production account or provider was contacted.

Verified OFF, ON, UNAVAILABLE (global disabled and accounting uncertainty), and BUDGET REACHED; explicit initially unchecked consent; keyboard activation; deactivation including while globally unavailable; refresh persistence; valid €1–€100 editing and €3/€5/€10 preset values; rejection of €0.99, €100.01, fractional cents and empty input. Invalid input receives native validation focus and does not change the saved budget.

Verified used €1.34, reserved €1.056 and remaining €2.604 against a €5 cap (47% committed); text warnings at 50/80/95/100%; exact reset 2026-10-01 00:00 fixed UTC−5; prior/new budget and opt-in audit values, timestamp and owner attribution. A €1 remaining balance displays the €1.056 reservation and explains that insufficient capacity blocks requests.

Desktop 1440×1000 and mobile 393×852: sixteen scenario/viewport checks plus OFF, expanded disclosure and expanded-history checks. No horizontal overflow or clipped mobile elements. These are browser viewport checks, not physical-device tests. Labelled controls, region/progress names, disclosure keyboard controls, consent, logical Tab navigation, visible 2px focus outlines and native validation focus passed; no physical screen-reader test was performed. Browser console: no errors/warnings.

One real presentation defect was found and fixed: audit timestamps were concatenated visually with monetary values, particularly on mobile. The timestamp now renders on its own line with 4px top spacing. Desktop/mobile history were rechecked. No architecture, permissions, accounting or deterministic behavior changed. Test-harness-only fixtures were added for 50%, 95% and used/reserved displays.

Follow-up verification: **18/18 focused Settings tests passed**, strict TypeScript passed and targeted lint passed. The existing 519/519 full-suite result and prior build/security/concurrency verification were retained; the full suite was not repeated for this presentation-only change. Live model quality with the 8K output ceiling, real staging integration and provider invoices remain separately authorized staging acceptance items.

Optional test tooling, isolated from application dependencies:

```powershell
pnpm --dir .local/ai-budget-tools add embedded-postgres@18.4.0-beta.17 pg@8.23.0 esbuild@0.25.12
node scripts/verify-ai-budget-concurrency.mjs
node scripts/ai-budget-browser-harness.mjs
```

## Before production activation

1. Review the feature, operation registry and fixed cost-conversion policy. Reverify model pricing, snapshot identity, output bounds, currency assumptions and pricing expiry.
2. Apply migration 0008 to a separate Supabase staging project; test real SSR sessions, RLS/RPC privileges, the Settings actions and the disabled workflows there. The isolated local PostgreSQL tests do not substitute for this deployment-environment check.
3. If desired, explicitly authorize a small live staging provider test with sufficient reservation capacity; compare returned usage with provider billing. No live provider behavior or billing has been certified in this task.
4. Separately approve deploying the reviewed application and migration to production with `AI_ENABLED=false`. Verify owner settings, private data and zero provider traffic while disabled.
5. Only after a separate activation approval: configure the server-only provider key, set provider project spending controls, enable the deployment master switch, then explicitly opt in the intended account with a chosen affordable cap. Initial normal requests require €1.056 remaining, including the safety margin.

No deployment or activation was performed during this feature task. Production stays at the approved Opus release with AI disabled.

Read-only Vercel check on 2026-09-23 confirmed deployment `dpl_HfA2SWCiyNaZ8CXSFzwqH3KMoiPz`, release commit `79ab1496bf0cb8e1807f3b83ef3c6ca96cf404bb`, unchanged production environment/protection, `AI_ENABLED=false` and no OpenAI key. No files were staged. Current review status: **READY FOR AI STAGING REVIEW**. Local Settings browser acceptance is complete; no unresolved browser defects.
