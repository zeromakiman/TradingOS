# Mini Trade Review and uncertainty resolution — local review

Date: 2026-10-13. Branch: feature/account-ai-budget. Changes remain unstaged and uncommitted.

## Trade Review

Only REVIEW_TRADE selects openai / gpt-5.4-mini, operation version REVIEW_TRADE_MINI_V1. Its output contract remains REVIEW_TRADE_V1. Limits remain 24,000 input tokens, 6,000 output tokens (including reasoning), medium effort, up to four explicitly selected images, no tools. The existing adapter, exact input-count check and gated dispatch are unchanged. No provider calls occurred.

Pricing profile GPT_5_4_MINI_EUR_2026_10_13 uses standard global rates checked against https://developers.openai.com/api/docs/models/gpt-5.4-mini: USD 0.75/M input, 0.075/M cached input, 4.50/M output. No inherited Astra cache-write premium. The profile accepts only the documented alias and gpt-5.4-mini-2026-03-17 response identity. New unreviewed identities fail closed. Review expiry: 2026-11-12T00:00:00Z.

Maximum reservation = (24,000 × 0.75 + 6,000 × 4.50) × 1.20 × 1.10 = 59,400 micro-EUR = **EUR 0.0594**. The fixed conversion multiplier is a conservative budget policy, not a live FX quote. Actual estimated maximum before the 10% hold margin is EUR 0.054. Unused capacity is released by the existing reconciliation path.

Operation-specific eligibility checks the selected operation's pricing, so expired unrelated Astra pricing does not disable Mini. Other registry operations, deterministic trading systems and the provider adapter are unchanged. No production configuration was changed; a future Preview build is needed to use this selection on hosted staging.

## Resolution architecture

Migration 0014 adds public.ai_uncertainty_resolutions and private.resolve_ai_uncertainty. A separate NOLOGIN ai_accounting_operator role has explicit execute permission, but migration grants it to no login. Normal users, anonymous callers and service_role cannot resolve or directly write audit rows. The authenticated database session identity supplies the resolver; neither request text nor JWT claims can choose it. Operators must be separately provisioned as named database logins.

Every decision requires a reason and investigation reference. KEEP_UNCERTAIN appends an investigation without changing the block. NO_PROVIDER_USAGE_CONFIRMED applies a zero effective charge. USAGE_CONFIRMED records provider-confirmed EUR cost, provider-confirmed USD cost with checked historical conversion, or an operator-attested provider-usage estimate calculated from preserved pricing. Evidence verification remains an explicit operator responsibility; SQL does not contact the provider or infer zero cost from a 429.

The original uncertain record and failed review remain unchanged. Audit rows preserve original/reconciled/released/additional amounts, evidence, reason, decision, resolver and timestamp. Owner-only audit reads use RLS. Updates/deletes are forbidden, terminal decisions are unique and identical request replay is idempotent. Confirmed overages are never hidden; they count against the cap. Resolution cannot opt in an account or raise its budget.

Budget accounting overlays only terminal decisions in the original reservation month. Past-month resolutions do not credit the current month. Other unresolved incidents keep the all-period block. The shared account row lock serializes resolution with reservations, dispatch, settlement and preference changes.

The secure procedure and parameterized SQL entry point are documented in AI_ACCOUNTING_RESOLUTION.md. Neither existing staging incident was modified. No role was provisioned outside disposable local test databases.

## Verification

- Node 24.19.0.
- Initial targeted batch: 196/196 passing across eight affected suites (Mini pricing, Trade Review contract/service, resolution DB, existing budget DB/gate, AI-disabled and Settings).
- After adding response-identity integration cases: Trade Review contract 15/15 passing.
- Final resolution DB suite, including confirmed USD conversion: 30/30 passing.
- Latest results cover **201 distinct targeted tests**, zero remaining failures/skips. Earlier local harness/SQL editing failures were corrected and the affected suites passed on rerun. The full application suite was not rerun.
- Targeted lint: eight affected source/test/script files passed with no warnings. Strict TypeScript passed. Git diff whitespace check passed.
- Final native PostgreSQL check (2026-10-13T13:34:01Z): fresh migrations 0001–0014; actual named operator login recorded, ordinary login denied; two simultaneous terminal decisions admitted one and rejected one; four new reservations demonstrably waited on the resolution lock, then one was admitted and three rejected under a EUR 1 cap (EUR 0.60 held); identical decision replay did not release twice.
- All provider outputs in tests are synthetic; the test setup forbids OpenAI network calls. Native integration uses localhost only and loads no application environment file.
- No Risk Engine, risk/RR/position-sizing, locking, realized-R, EDGE, strategy/session, trade records, authentication or existing ownership policy changed. New RLS is restricted to the resolution ledger.

## Files

Modified: src/ai/operations.ts; src/ai/pricing.ts; src/ai/request-gate.ts; src/lib/ai-budget.ts; tests/trade-review-contract.test.ts.

Added: supabase/migrations/0014_ai_uncertainty_resolution.sql; tests/ai-mini-pricing.test.ts; tests/ai-resolution-database.test.ts; scripts/verify-ai-resolution-concurrency.mjs; docs/AI_ACCOUNTING_RESOLUTION.md; this report.

The four pre-existing untracked integrated/staging reports remain preserved. Nothing was staged, committed, pushed or deployed.

## Retry readiness

Implementation is locally verified. Hosted staging is not ready for a real retry yet: apply the reviewed 0014 migration to staging, deploy a Preview containing the Mini selection, separately provision operator access, investigate the selected existing incident and explicitly authorize its audited resolution. Recheck account opt-in, pricing validity and budget before a newly authorized call. Do not bypass either existing uncertain record or create another account merely to evade the block.

No remote migrations, staging resolutions, provider calls, production deployment or production AI activation occurred.

NOT READY FOR STAGING RETRY
