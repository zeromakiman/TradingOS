# Independent Opus UI V2 review

Review dates: 2026-09-16 through 2026-09-21. **NO-GO pending completion of browser acceptance and the Vercel preview.** This is not approval to merge or deploy production. AI remains disabled.

## BASELINE

- Repository: https://github.com/zeromakiman/TradingOS
- Remote main, rechecked 2026-09-21: `9d1ef83a80a8a6abb11efaf4220e2458ec2afd9f`.
- Patch base: `9d1ef83`; no intervening main changes.
- Review branch: `review/opus-ui-v2`. Main was not changed.
- The two-commit patch applied cleanly with `git am`, without conflict resolution.
- Applied commits: `cb96411fa4a4725c2cd91a644bb85d92f80b3121` and `1caf0ed60faf2315e7a594dc1828d576a326be38`.
- Applied tree: `b3542f19fccdb818e30c9f503c9e391c19bd443e`, matching the supplied patch tree. Replayed commit IDs differ from the author's IDs because commit metadata differs.
- Independent tests committed as `cfa3102` (`Test Opus UI boundaries and journal presentation independently`). This report adds documentation only.
- Production remains deployment `dpl_8Cxi2zNDGhSp2q6mNAna1R3XQN5U`, associated with the previously audited password-recovery release. The production alias was verified unchanged on 2026-09-21.

## DIFF AUDIT

The patch changes these 16 files:

```text
FRONTEND_FUTURE_REQUESTS.md
src/app/edge/page.tsx
src/app/globals.css
src/app/journal/[id]/page.tsx
src/app/journal/page.tsx
src/app/layout.tsx
src/app/login/page.tsx
src/app/today/page.tsx
src/components/edge-dashboard.tsx
src/components/numeric.ts
src/components/session-ribbon.tsx
src/components/shell.tsx
src/components/status-banner.tsx
src/components/trade-screenshots.tsx
src/components/trade-workspace.tsx
tests/ui-presentation.test.ts
```

The independent review adds `tests/ui-review.test.ts` and this report. No application code was changed by the independent reviewer.

Protected files changed: **zero**. The actual diff leaves `src/domain`, `src/lib`, `src/ai`, API routes, server actions, proxy, CSV delivery, Supabase migrations, package manifest, lockfile, environment examples, ignore files, Next configuration and Vercel configuration unchanged. Mixed Today, Journal, Detail, EDGE and Login pages were inspected beyond their filenames: existing loading, queries, authorization, filtering and mutation handlers remain intact.

## DOMAIN/BUSINESS SAFETY

| Area | Finding |
|---|---|
| Risk, sizing, RR and limits | Authoritative domain and SQL unchanged; UI risk requests, validation and disabled conditions unchanged. |
| Sessions and strategy versions | Fixed UTC−5 clock and session definitions unchanged. |
| Analytics | Completed-trade selection, realized R, fees, expectancy, profit factor and drawdown unchanged. |
| Trade state and locking | Primary/outline button styling changed; handlers, lock eligibility and immutable reservations unchanged. |
| Original records and history | Original values, version labels, execution, evidence, notes and events remain displayed. |
| Auth and ownership | Existing SSR session handling, route protection, ownership/RLS and recovery flow unchanged. |

`rTone` reads only the leading sign of the existing `formatR` output. It does not parse a financial number or change the displayed value. Independent cases include rounded tiny values, negative zero, a large value and missing data.

## SESSION RIBBON

The ribbon uses `strategyClock` for every sampled minute; it contains no duplicated session boundary table. The day anchor encodes the existing fixed UTC−5 offset. That is consistent with the current domain, which does not use daylight-saving time.

All required examples pass against the authoritative implementation:

| Current strategy time | Next distinct session | Next time | Strategy date |
|---|---|---|---|
| 00:30 | JUDAS | 01:00 | Same day |
| 01:30 | ACTIVE KILL ZONE | 02:00 | Same day |
| 06:00 | DEAD POOL | 12:00 | Same day |
| 13:00 | ASIA | 18:00 | Same day |
| 18:00, 18:30, 19:00, 23:30, 23:59 | JUDAS | 01:00 | Following day |

Tests cover every minute of the day, first distinct transitions, segment coverage, fractional seconds, year rollover and dates surrounding DST changes. Browser acceptance previously observed evening ASIA with next JUDAS at 01:00 and the following date printed. Midnight itself does not incorrectly announce another ASIA session.

The actual worst case under current session definitions is 2,042 clock calls per render: 1,440 segment samples, up to 600 forward samples and two current-clock reads. The loop safety bound permits 4,322 calls. A local 100-iteration helper benchmark measured median 7.94 ms, p95 9.69 ms and maximum 10.39 ms. This is server-side helper cost, not end-to-end page latency. It is acceptable for this personal application; no domain optimization was introduced. The ribbon reflects the request-time clock, as the existing page does, rather than updating continuously while left open.

## STATUS BANNER

All six possible `dailyStatus.reasons` represent restrictions: Dead Pool, stale observation, exhausted daily slots, reached daily risk cap, unknown gross losses when capped, or gross losses plus reserved risk reaching the cap. Tests confirm each also blocks the authoritative Risk Engine. Warnings are not being reclassified by the banner.

The original label is rendered verbatim, including `PLAN ACTIVE` or `TRADE ACTIVE` alongside restrictions. READY, working and restricted states differ in wording, icon and border geometry, as well as color. The Today note still requires each proposed trade to pass its own risk check.

## JOURNAL

The loader, filter semantics, query ordering and 50-row pagination are unchanged. Grouping uses the lock's existing UTC−5 strategy day without reordering the returned rows. Independent rendered tests verify all 50 rows exactly once, a day split across pages, midnight microseconds, page navigation and preserved filter return URLs. There is no per-day count or per-day net R.

Browser acceptance verified the four-trade historical synthetic account, LOSS filtering to one record, opening that record and returning to the filtered list. Identification, original planned risk, version, status and realized R remain visible on phone.

## EDGE

`lowSample` recognizes only the existing `NO DATA`, `VERY SMALL SAMPLE` and `SMALL SAMPLE` labels. All five domain sample bands and an unknown label were tested; no threshold or formula was introduced.

The historical synthetic account showed four completed trades, +4R net, +1R expectancy, 50% wins, profit factor 5 and 1R drawdown. Desktop metrics and phone breakdowns were visually inspected. The equity-curve component and its accessible data remain unchanged.

A minor presentation issue remains: desktop `nth-child` border rules can leave inconsistent divider lines when the headline grid changes to two columns. It does not hide metrics or alter calculations. No CSS correction was made during this review.

## SECURITY

- Authentication, password recovery, authorization, ownership checks, RLS, CSV security and server actions are unchanged.
- Screenshots still use `/api/screenshots/[id]`, never a public Storage object URL. Owner delivery preserves bytes and returns private/no-store plus nosniff headers.
- Live checks returned 404 for a foreign user, 401 signed out, no foreign metadata through RLS, and denied public Storage delivery.
- A previously soft-removed isolated screenshot remained privately readable by its owner and denied to the foreign user.
- The independent source scan covered 166 candidate files, 82 actual preview upload files and 18 browser asset files, with zero detected credential matches or excluded-file findings. The upload manifest contains ignored directory entries but no `.local/` contents.
- `.env.local`, `.local/`, integration-user credentials, build output and local tooling remain excluded. No secret values appear in this report.
- The disabled AI endpoint returned `DISABLED`, added no evaluation and preserved the existing failed evaluation history. The current guarded local runtime recorded zero attempted OpenAI calls. No OpenAI key is required.

## TESTS

| Stage | Total | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Audited baseline | 370 | 370 | 0 | 0 |
| Supplied patch, independently run | 399 | 399 | 0 | 0 |
| Patch plus independent review tests | 410 | 410 | 0 | 0 |

The final run has 19 test files. All baseline tests are preserved; 29 are supplied by the patch and 11 were added independently. No tests were weakened or deleted.

Lint passes with zero errors or warnings; 30 existing informational `useTemplate` diagnostics remain. Strict TypeScript passes. A clean production build passed on 2026-09-16 with the same application source, yielding 17 routes; subsequent review changes are tests and documentation only. `git diff --check` passes. Test and local-server guards prevent live OpenAI calls.

## NODE

Actual local runtime: **Node v24.19.0**, within the declared `24.x` requirement. This differs from Claude's claimed v24.21.0, which was not relied upon. Next.js is 16.3.4. Vercel project runtime remains `24.x`. Dependencies and lockfile are unchanged.

## BROWSER

Earlier interactive acceptance used the actual local production build and real isolated Supabase data, with DOM observations and screenshots. It was not certification from HTTP responses alone.

| Viewport | Evidence and coverage |
|---|---|
| Desktop 1440×1000 | Login, Today, trade detail and EDGE visually inspected. |
| Laptop 1280×900 | Today layout and overflow checked; remaining workflow matrix incomplete. |
| Tablet 834×1112 | Today layout and overflow checked; remaining workflow matrix incomplete. |
| Phone approximately 393×852 | Today states, Journal/filter/detail, risk preview, EDGE/breakdown and bottom navigation inspected. |
| Phone endpoints 375 and 430 | Not yet completed. |

No horizontal overflow was observed in the completed Today matrix or inspected phone workflows. Eight saved screenshots remain in ignored `.local/opus-browser/`. This is browser viewport testing, not physical iPhone or Safari certification.

On 2026-09-21 browser inventory returned no enabled browsers, and opening an in-app tab returned `Browser is not available: iab`. Opening the panel through Codex was queued. Remaining visual checks cannot be certified until browser control is restored.

## WORKFLOWS

| Workflow | Status |
|---|---|
| Login and invalid-password error | PASS in earlier interactive browser session. |
| Today READY/restricted/ACTION REQUIRED | PASS with isolated current and historical accounts. |
| New Trade approved and blocked | PASS: 1% blocked; 0.5% approved with server-saved feedback. |
| Dead Pool risk preview | PASS: blocked text, stronger border and disabled lock. |
| Lock original plan | PASS in browser; original $50 risk, 3R and 0.25 lots preserved. |
| Record actual entry | PASS in browser. |
| Journal, filters and return navigation | PASS in browser and focused tests. |
| Trade Detail original/execution/timeline | PASS for inspected records. |
| Notes and events | PASS: synthetic note appended and original unchanged. |
| Screenshot storage/delivery/access control | PASS in live HTTP/database acceptance. |
| Screenshot upload interaction and rendered populated gallery | PENDING browser completion; upload via API does not substitute for UI acceptance. |
| Trade close | PENDING interactive completion; the synthetic review trade remains open. |
| EDGE and phone breakdowns | PASS for historical synthetic records. |
| AI-disabled workspace | PASS in earlier browser session and current endpoint checks. |
| Settings save | PENDING this review's interactive acceptance. |
| Sign out, sign back in and post-login persistence | PENDING complete interactive cycle on this patch. Signed-out route denial passes separately. |
| Password recovery | Architecture unchanged and existing focused tests pass; no new mailed recovery exercise during this UI review. |

## ACCESSIBILITY

Sampled new text pairs meet 4.5:1 normal-text contrast: status labels 6.02–6.77, restriction text 11.75, button text 6.63, low-sample rows 5.79, ribbon legend 5.42 and seal footer 5.00. These are static CSS calculations, not comprehensive rendered WCAG certification.

Visible focus styles and the skip link remain in source. Mobile navigation targets are approximately 58 px high; safe-area padding and content clearance are present in CSS. State is not color-only. Keyboard traversal, populated screenshot focus behavior, physical keyboard/phone interaction and the remaining viewport matrix still require browser completion.

There is no explicit reduced-motion media rule. The reviewed styles introduce no spatial animation; the existing 100 ms button background-color transition remains. No physical safe-area or on-screen keyboard certification is claimed.

## LIVE ACCEPTANCE

Only existing isolated test users and synthetic demo accounts were used. The user explicitly approved isolated writes. The dedicated review account is named `Opus UI independent review · SYNTHETIC · 2026-09-16`; earlier browser writes created its plan, actual entry, note and linked screenshot workspace. On 2026-09-21 one clearly labeled synthetic PNG was uploaded to that existing workspace. Repeated verification reused that image rather than adding duplicates.

Eight focused live check groups pass: upload persistence; owner byte-for-byte delivery; foreign/signed-out denial and RLS; public-storage denial; removed-image preservation; AI-disabled behavior/history; signed-out private routes; and preserved original/note/private-image markup. The original plan row remains identical. Personal trading records, passwords, policies and migrations were not modified. Synthetic audit history remains preserved.

## PREVIEW

**No preview deployment has been created yet.** The source and deployment manifest are prepared and scanned. Production remains https://trading-os-six-brown.vercel.app at its existing deployment, with protection setting `all_except_custom_domains` unchanged.

Automatic approval review rejected the prepared preview action because it would transfer the existing `SUPABASE_SECRET_KEY` to the preview as a server environment variable without specific secret-transfer authorization. The script was not executed. Approval has been requested for that existing secret on the existing Trading OS Vercel project, preview only. An alternative preview can omit the key, but private screenshot uploads would then be unavailable. No production environment or deployment was changed.

## FUTURE REQUESTS

| Item | Classification | Reason |
|---|---|---|
| Structured dailyStatus reasons | GOOD FUTURE CANDIDATE | Domain-owned codes could support precise next actions without parsing prose. Separate contract change required. |
| Planned-versus-actual delta | NEEDS MORE DATA | Agree useful comparisons and fee/denominator semantics before deriving new trading values. |
| Per-day net R | NEEDS MORE DATA | Resolve lock-day versus exit-day meaning, complete aggregation and pagination scope. |
| Private thumbnail variants | GOOD FUTURE CANDIDATE | Could reduce mobile transfer while retaining authorized private delivery. |
| Session boundary helper | NOT NEEDED | Current measured helper cost is acceptable for personal use. Revisit if scale or additional clock consumers justify a domain API. |
| Account context/routing cleanup | NOT NEEDED | Explicit account URLs already preserve shareable context; moving it into cookies adds hidden state. |
| Planned RR in journal_analytics | GOOD FUTURE CANDIDATE | Could remove a read round trip, with separate migration and historical-version review. |
| Configurable sample thresholds | NOT NEEDED | No demonstrated requirement for account-specific statistical bands. |

None of these eight requests was implemented.

## REMAINING LIMITATIONS

1. Restore browser control and finish the explicitly pending workflow, keyboard and responsive checks.
2. Resolve preview-only secret authorization, create the preview and verify it is READY with production/protection unchanged.
3. No physical-device or comprehensive accessibility certification; minor EDGE divider styling remains.

## FINAL STATUS

Protected code and automated checks pass, but the user's complete GO criteria are not yet met. Missing browser acceptance and preview availability are gates, not proof of an application regression. No merge or production deployment is authorized by this review.

NO-GO
