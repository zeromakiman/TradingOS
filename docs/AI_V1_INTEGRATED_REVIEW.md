# AI V1 integrated verification — 2026-09-25

Status: **AI V1 READY FOR STAGING**. Automated, build, migration, concurrency, security and complete local synthetic browser verification passed. No application defect was identified and no application code changed during this verification. Reconcile the stale Git references described below before staging. This is not production activation approval.

## Checkpoint and scope

- Branch: `feature/account-ai-budget`.
- Monthly Review checkpoint: `0b13aa566808ca709606f5c15f047719c2be29fa` — `Checkpoint verified Monthly Review feature`.
- Exactly the 23 reviewed Monthly Review files were committed. Explicit file manifest and secret checks preceded staging; the tree was clean after the checkpoint. The checkpoint is the sole staging/commit exception explicitly requested in this task.
- After checkpoint: only this report and `AI_V1_INTEGRATED_VERIFICATION.json` are new, untracked files. Zero staged files; no application changes. Local test outputs and synthetic fixtures remain ignored under `.local/`.

## One full verification

Node **24.19.0**. Full suite ran **once: 1,031 passed / 0 failed / 0 skipped / 0 todo**, across 50 test files. The JSON report contains exact per-file counts.

- Lint: PASS, 0 errors / 0 warnings (113 informational style suggestions).
- Strict TypeScript: PASS.
- Production build: PASS, Next.js 16.3.4. Built locally; never deployed.
- AI account/budget/disabled tests: 124 passed.
- REVIEW_TRADE: 53 passed; CHALLENGE_BIAS: 62; ANALYZE_SETUP: 77; WEEKLY_REVIEW: 104; RECENT_TRADES_ANALYSIS: 103; MONTHLY_REVIEW: 113. These are subsets of the 1,031 total.
- Database tests: 188 passed, including actual migrations in isolated PGlite, populated owner/foreign history, privileged-write denial, append-only output, precise scope, locking and accounting ownership. These are also a subset, not extra tests.
- Selected deterministic regressions: 167 passed covering risk, analytics, core database/locking, EDGE outcomes, mathematical audits and session boundaries. AI ON/OFF equality tests also passed.

The domain directory, original migrations 0001–0007, core actions, Supabase auth clients, screenshot authorization, CSV export and calculation loaders match production baseline `79ab1496bf0cb8e1807f3b83ef3c6ca96cf404bb`. Risk Engine, locking, realized R and EDGE formulas did not change.

## Native PostgreSQL and migration order

Created a new loopback-only PostgreSQL **18.4** instance with a generated ephemeral password, synthetic owners and Supabase auth/storage stubs. Applied all **13 migrations in filename order** to the empty database, including **0008–0013**. Fresh-database ordering passed. No hosted database or production credentials were used. The native server was stopped afterward.

Native contention used **20 independent connections**:

- 360 competing reservation attempts: six operations × EUR 3/5/10 caps × 20 requests.
- 20 additional mixed-operation requests against one shared EUR 3 account cap: four accepted, EUR 2.508 held. Every other request was rejected; aggregate holds stayed within the cap.
- All 18 operation/cap cases admitted exactly `floor(cap / reservation)` requests. No overspend.
- Twenty simultaneous reconciliations of one dispatched request produced exactly one settlement and 19 already-reconciled rejections.
- A EUR 0.924 reservation reconciled to a synthetic provider-usage estimate of EUR 0.018, releasing EUR 0.906.
- Pre-dispatch cancellation refunded its hold. Post-dispatch uncertain accounting retained the maximum hold and blocked further requests.
- Concurrent opt-out was observed by the waiting reservation. Dispatch rechecked opt-out after reservation.
- Cross-user preference/budget RPCs and reservation ownership were rejected. All 14 new AI tables have RLS, deny anonymous reads and client writes; foreign reads returned zero rows. Native populated accounting records rejected privileged update/delete. Populated per-operation history isolation is covered by the 188 database tests.

Exact native cases and migration names are embedded in the JSON report. The local runner/evidence hashes are included there; they are not provider results.

## Shared architecture

Every operation passes through the existing server gate: global switch and provider configuration, authenticated ownership, account opt-in, atomic budget reservation, dispatch authorization, provider usage capture, reconciliation and immutable history. Unknown operations/providers and mismatched/expired pricing fail closed. Browser state is not authorization.

| Operation | Input/output envelope | Images | Maximum reservation |
| --- | --- | --- | --- |
| REVIEW_TRADE | 24,000 / 6,000 | up to 4 selected | EUR 0.792 |
| CHALLENGE_BIAS | 16,000 / 4,000 | up to 3 selected | EUR 0.528 |
| ANALYZE_SETUP | 16,000 / 5,000 | up to 3 selected | EUR 0.594 |
| WEEKLY_REVIEW | 24,000 / 6,000 | none | EUR 0.792 |
| RECENT_TRADES_ANALYSIS | 32,000 / 6,000 | none | EUR 0.924 |
| MONTHLY_REVIEW | 32,000 / 6,000 | none | EUR 0.924 |

All six use the registered Astra adapter with medium effort and no tools. The registry, gate and accounting schema support reviewed alternate providers/models; adding a real adapter still requires review. No new provider was activated. Input counting and generation use the same bounded immutable payload; output limits are enforced. Prices are centralized/versioned, with a 1.20 USD-cost-to-EUR-budget multiplier and 10% reservation margin. These are application estimates, not final provider invoices. The current pricing profile expires **2026-10-22 00:00 UTC** and must be reviewed before subsequent activation.

Budget periods start on the first calendar day at 00:00 fixed UTC−5 (05:00 UTC). History survives reset and opt-out. No operation runs on page load.

## Browser acceptance performed

Actual React panels, shared forms and server actions, with synthetic service boundaries; Settings mutations used isolated PGlite. Browser viewport testing at **1440×1000** and **393×852**, not physical devices and not hosted Supabase/Next SSR acceptance.

- Settings: OFF, ON, UNAVAILABLE and BUDGET REACHED; unchecked consent blocks activation; explicit consent enables; deactivation persists; EUR 1/3/5/10/100 accepted; 0.99/100.01 rejected; history shows each owner change. EUR 3/5/10 are examples in the numeric input, not separate preset buttons. Used/reserved/remaining, 50/80/95/100% warnings and exact reset policy verified. Keyboard disclosure focus visible. No overflow.
- Trade Review: full desktop/mobile restriction matrix and completed/failed/in-progress/incomplete history passed. Explicit selected-evidence submission showed loading and a saved result. Mobile layout, metadata, keyboard focus and no overflow passed.
- Challenge Bias and Analyze Setup: full desktop/mobile state matrices passed. Errors focus the alert; loading disables submission; completed and failed reruns append. Only explicitly selected evidence was in the synthetic submission. BLOCKED Risk Engine status remains visible and unchanged after AI results.
- Weekly Review: desktop/mobile state matrix, exact period, low-sample copy, loading/error, completed plus appended failed history, keyboard metadata and no overflow passed. A settled-focus recheck confirmed the error alert receives focus with a visible outline.
- Recent Trades: full desktop/mobile matrix passed; loading/error, completed plus failed appended history; 10/20/30 selector selected exactly those sample sizes; visible keyboard metadata and no overflow.
- Monthly Review: fresh full desktop/mobile state matrix passed. Previous-month default, exact UTC-5 boundaries, month selector, empty-month blocking, 60-trade bounded-summary disclosure, loading, focused error, metadata, saved results and no overflow passed. Two new synthetic submissions appended one completed and one failed result; four prior synthetic records remained, for six history records total. Prior feature acceptance also remains preserved.

No horizontal overflow or visual blocker was observed in the pages checked. The normal viewport was restored afterward. All accepted submissions were synthetic; no provider calls occurred.

### Browser completion

All six operations passed the seven-state matrix on both sizes: **84 state/viewport cases**. Actions requiring permission were disabled in OFF, UNAVAILABLE and insufficient-budget states. History remained readable while AI was off. Console capture contained zero errors or warnings. Keyboard metadata disclosures had a 2px focus outline; settled form errors received focus. Viewport overrides were reset.

Automatic approval review briefly blocked navigation after reporting an exhausted allowance. The user explicitly approved local synthetic browser testing; the normal browser tool then accepted navigation and the remaining checks completed. No alternate surface or workaround was used. No browser work remains pending.

## Security and production

- Secret scan: zero findings across 296 candidate source/test/docs files (including these reports) and 18 built client assets. Checked configured private values, local test passwords, credential signatures, privileged JWTs and client-only boundaries. The final scan covers these new reports.
- `.env.local`, `.local/`, integration-user credentials, dependencies and build output are ignored and untracked.
- Build audit: zero attempted OpenAI requests; automated tests block real OpenAI network access; synthetic harnesses have no provider access.
- No production migration, deployment, environment change, key addition or activation. Existing `AI_ENABLED=false` production configuration was preserved, not freshly re-audited remotely. No personal records were touched.

## Git synchronization required before staging

Read-only `git ls-remote` confirmed GitHub `main` at **79ab1496bf0cb8e1807f3b83ef3c6ca96cf404bb**, the audited production merge. Local `main` and local `origin/main` both remain stale at **9d1ef83a80a8a6abb11efaf4220e2458ec2afd9f**, six commits behind the actual remote. The feature is four commits ahead of actual remote main, zero behind, and has no upstream. The remote query returned no feature or review branch. Local `main-Max` already points to 79ab149; prior sync-conflict refs must not be discarded blindly.

Before authorizing staging:

1. Preserve this checkpoint and the verification reports.
2. Fetch origin to refresh remote-tracking refs and verify actual main still matches the expected audited baseline.
3. After confirming no divergence, fast-forward stale local main to refreshed origin/main while preserving the feature work. Review the `-Max` sync-conflict refs before any cleanup.
4. If remote main has advanced, review those changes and agree reconciliation explicitly. No automatic merge/rebase is needed against the currently observed remote because the feature already descends from it.
5. Separately authorize staging after Git synchronization. Do not use production/main as a staging deployment target. Browser acceptance is complete.

No fetch, ref rewrite, merge, rebase, push or deployment was performed in this verification task.

**AI V1 READY FOR STAGING**
