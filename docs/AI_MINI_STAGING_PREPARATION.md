# GPT-5.4 Mini staging preparation — 2026-10-13

Staging preparation completed. A provider retry remains blocked by the two existing unresolved incidents and account opt-out; no gate was bypassed.

## Migration

Applied only 0014_ai_uncertainty_resolution.sql to isolated staging rqyehnaeplkgmmlzcnhq at 2026-10-13T13:59:35Z using the linked Supabase CLI. Dry run selected only 0014. The migration ledger now contains 0001–0014.

Migration SHA-256: 5936e9cee7c81465cdd1cbce19cc68e3e1865e01ccd3fff111386d6c1ebc6a7c.

No production database connection or migration was performed. Production migrations 0008–0014 were not applied by this workflow; production database state was not independently re-read.

## Focused hosted security checks

- Operator role successfully invoked the private resolution function against a synthetic reservation. Resolver identity came from database session_user.
- Authenticated-user and service-role execution attempts were denied.
- anon, authenticated, authenticator and service_role have neither operator membership nor function EXECUTE permission.
- Owner could read the synthetic audit row; foreign user could not.
- All synthetic writes and temporary operator permissions were rolled back. Zero persisted resolution rows; no synthetic account/reservation remained.
- Existing owner and foreign staging accounts were authenticated independently through Supabase. Cross-account budget RPCs were denied; reservation, usage, Trade Review and resolution history were hidden across users.
- Private resolution function is unavailable through the public application RPC interface.
- PostgreSQL retains only its migration-created administrator membership for postgres (ADMIN true, INHERIT false, SET false). No application role or persistent operator login was provisioned.

These were focused migration/security checks, not a full-suite rerun.

## Existing incidents unchanged

Before/after SHA-256 of both complete reservation/usage/dispatch records matched: d8dade528b1f87f6e0228b467d1dc390f25b80de3524d86929f79322824a8521.

| Reservation | Dispatch UTC | Current state |
| --- | --- | --- |
| 48583090-fe9d-42f5-add0-b6dd7343e14c | 2026-09-28 01:20:00.013 | UNCERTAIN; €0.792 conservative accounting charge; usage/response ID absent |
| fbc5bd59-c24d-4d19-a2de-2bf0ea41cd7c | 2026-09-28 13:27:07.627 | UNCERTAIN; €0.792 conservative accounting charge; usage/response ID absent |

HTTP 429 / RATE_LIMIT does not establish zero billable usage. No new provider-side evidence was obtained; no resolution decision was recorded, including KEEP_UNCERTAIN. The conservative charges are not confirmed provider invoices.

Both accounts remain AI OFF with uncertain=true. October usage and held amounts are zero, but the cross-period uncertainty block remains active as designed. No new account was created to bypass this block.

## Preview

- https://trading-a3qu6n3rt-maksim61910-7648.vercel.app
- dpl_6xSbRbFcMMH7NjW5mZpU8ksRu2FR; READY; Preview only; Node 24.x.
- REVIEW_TRADE / gpt-5.4-mini / REVIEW_TRADE_MINI_V1.
- 24,000 input / 6,000 output tokens, medium effort, up to four selected images, no tools.
- GPT_5_4_MINI_EUR_2026_10_13 pricing; maximum reservation 59,400 micro-EUR (€0.0594).
- Existing Preview environment read back: staging Supabase and AI_ENABLED=true. No environment changes or redeployment this continuation.
- Deployed source manifest hash: 47e0934e483b779898efdbf5967b40154fc5fa3c946f135a6076de5587b44245; feature/account-ai-budget base commit 0b13aa566808ca709606f5c15f047719c2be29fa plus reviewed uncommitted Mini/resolution changes. Deployment metadata matched the captured manifest. No provider execution was used to confirm configuration.

## Production

Read-only Vercel verification: production deployment still dpl_HfA2SWCiyNaZ8CXSFzwqH3KMoiPz; environment fingerprints and protection unchanged. AI_ENABLED=false read back; OPENAI_API_KEY absent. No production migrations, deployment, preferences or personal records were changed.

## Next required decision

The migration and authorization preparation passed. A retry using either existing staging account cannot pass the current gate. First investigate provider-side evidence and explicitly authorize an appropriate terminal incident resolution for the selected account; then explicitly opt that account into AI and authorize exactly one Mini call. Do not infer no usage from HTTP 429 and do not clear uncertainty solely to permit testing.

Provider generation calls this continuation: 0. Full-suite runs: 0. Git staging/commits: 0. Application-code changes: 0.

Private evidence: .local/ai-v1-staging/mini-migration-applied.json, mini-staging-security.json, mini-retry-readiness.json, mini-deployment-verification.json.

NOT READY FOR MINI STAGING RETRY
