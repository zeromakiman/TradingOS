# Independent Opus UI V2 review

Review dates: 2026-09-16 through 2026-09-21. **GO FOR USER VISUAL REVIEW.** Independent code/security checks, automated verification, interactive browser acceptance and the Vercel preview are complete. This is not approval to merge or deploy production. AI remains disabled.

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

The hosted preview also shows the dedicated review account's single closed trade under its original 2026-09-16 lock-day header, with the unchanged planned 3R/$50/0.50% and actual +3R outcome. Its later exit date does not move it into a different Journal group.

## EDGE

`lowSample` recognizes only the existing `NO DATA`, `VERY SMALL SAMPLE` and `SMALL SAMPLE` labels. All five domain sample bands and an unknown label were tested; no threshold or formula was introduced.

The historical synthetic account showed four completed trades, +4R net, +1R expectancy, 50% wins, profit factor 5 and 1R drawdown. Desktop metrics and phone breakdowns were visually inspected. The equity-curve component and its accessible data remain unchanged.

After closing the dedicated synthetic review trade through the hosted UI, EDGE shows one completed trade, +3R net, +3R expectancy, 100% wins, `No losses` profit factor and 0R drawdown. Expanded accessible curve data shows 0R then 3R in exit order. The phone breakdown retains the explicit N=1/VERY SMALL SAMPLE and N=0/NO DATA states. The curve's data table scrolls inside its container without overflowing the page.

A minor presentation issue remains: desktop `nth-child` border rules can leave inconsistent divider lines when the headline grid changes to two columns. It does not hide metrics or alter calculations. No CSS correction was made during this review.

## SECURITY

- Authentication, password recovery, authorization, ownership checks, RLS, CSV security and server actions are unchanged.
- Screenshots still use `/api/screenshots/[id]`, never a public Storage object URL. Owner delivery preserves bytes and returns private/no-store plus nosniff headers.
- Live checks returned 404 for a foreign user, 401 signed out, no foreign metadata through RLS, and denied public Storage delivery.
- A previously soft-removed isolated screenshot remained privately readable by its owner and denied to the foreign user.
- The independent source scan covered 166 candidate files, 82 actual preview upload files and 18 browser asset files, with zero detected credential matches or excluded-file findings. The upload manifest contains ignored directory entries but no `.local/` contents.
- `.env.local`, `.local/`, integration-user credentials, build output and local tooling remain excluded. No secret values appear in this report.
- The disabled AI endpoint returned `DISABLED`, added no evaluation and preserved the existing failed evaluation history. The current guarded local runtime recorded zero attempted OpenAI calls. No OpenAI key is required.
- The approved existing server secret was supplied only as a runtime variable on the new Preview deployment. It was not committed, given a `NEXT_PUBLIC_` prefix or supplied to the browser build. A successful hosted screenshot upload verifies the server-side configuration. Production variables were not edited.
- The hosted sign-out/sign-in cycle passed; directly opening a private trade while signed out returned Login. Three private images decoded after signing back in, including the image excluded from future reviews.

## TESTS

| Stage | Total | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Audited baseline | 370 | 370 | 0 | 0 |
| Supplied patch, independently run | 399 | 399 | 0 | 0 |
| Patch plus independent review tests | 410 | 410 | 0 | 0 |

The final run has 19 test files. All baseline tests are preserved; 29 are supplied by the patch and 11 were added independently. No tests were weakened or deleted.

Lint passes with zero errors or warnings; 30 existing informational `useTemplate` diagnostics remain. Strict TypeScript passes. A clean local production build passed on 2026-09-16 with the same application source, yielding 17 routes. The hosted Preview build also passed on 2026-09-21, completing in 16 seconds. Subsequent review changes are tests and documentation only. `git diff --check` passes. Test and local-server guards prevent live OpenAI calls.

## NODE

Actual local runtime: **Node v24.19.0**, within the declared `24.x` requirement. This differs from Claude's claimed v24.21.0, which was not relied upon. Next.js is 16.3.4. Vercel project runtime remains `24.x`. Dependencies and lockfile are unchanged.

## BROWSER

Interactive acceptance used the actual local production build and then the hosted Preview, with real isolated Supabase data, DOM observations and screenshots. It was not certification from HTTP responses alone. Temporary browser unavailability was resolved, and the remaining acceptance was completed on 2026-09-21.

| Viewport | Evidence and coverage |
|---|---|
| Desktop 1440×1000 | PASS: Login, Today, New Trade/risk preview, Settings, Journal, Trade Detail and EDGE. |
| Laptop 1280×900 | PASS: the same seven core pages; forms, metrics and original/history columns remain usable. |
| Tablet 834×1112 | PASS: the same seven pages; populated gallery and EDGE were additionally inspected after layout settled. |
| Phone 393×852 | PASS: interactive forms, gallery focus, decoded private images, bottom navigation and final note-button clearance. |
| Phone 375×812 and 430×932 | PASS: the same seven core pages, including restricted risk preview, Journal and EDGE. |

The saved hosted matrix contains 36 observations with zero horizontal page-overflow cases. Screenshots and compact observations remain in ignored `.local/opus-browser/`, `.local/OPUS_BROWSER_MATRIX.json` and `.local/OPUS_FINAL_BROWSER.json`. This is browser viewport testing, not physical iPhone or Safari certification.

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
| Screenshot upload interaction and rendered populated gallery | PASS: local and hosted browser uploads, success feedback, private decoded gallery and preserved soft-removed image. |
| Trade close | PASS on hosted Preview: invalid pre-entry exit time displays a useful error; corrected close persists WIN/+3R/$150 with the original $50 denominator. |
| EDGE and phone breakdowns | PASS for historical synthetic records. |
| AI-disabled workspace | PASS in earlier browser session and current endpoint checks. |
| Settings save | PASS on hosted Preview: a new isolated equity/balance observation of $10,150 and gross loss of $0 persists. Risk-plan settings unchanged. |
| Sign out, sign back in and post-login persistence | PASS on hosted Preview: signed-out private navigation denied; closed trade, three images, note and four events persist after a fresh login. |
| Password recovery | Architecture unchanged and existing focused tests pass; no new mailed recovery exercise during this UI review. |

During the real Dead Pool session on 2026-09-21 the hosted risk preview showed `SAVED · SERVER-VERIFIED`, `TRADE BLOCKED` and a disabled original-plan lock. Saving the proposal still worked and did not create a plan lock or reserve risk. No clock override or trading-rule change was used.

## ACCESSIBILITY

Sampled new text pairs meet 4.5:1 normal-text contrast: status labels 6.02–6.77, restriction text 11.75, button text 6.63, low-sample rows 5.79, ribbon legend 5.42 and seal footer 5.00. These are static CSS calculations, not comprehensive rendered WCAG certification.

Keyboard traversal was exercised in the hosted browser: Email to Password to Sign in to Forgot password; input/link outlines are visibly 2 px. The skip link jumps to the main content and the next Tab focuses its first link. Gallery links have visible focus and meaningful image alternatives. Mobile navigation targets are approximately 58 px high; the final Add note control remains above navigation at the end of the page. Safe-area padding is present in CSS. State is not color-only. No severe layout shift or accidental hidden core content was observed.

There is no explicit reduced-motion media rule. The reviewed styles introduce no spatial animation; the existing 100 ms button background-color transition remains. No physical safe-area or on-screen keyboard certification is claimed.

## LIVE ACCEPTANCE

Only existing isolated test users and synthetic demo accounts were used. The user explicitly approved isolated writes. The dedicated review account is named `Opus UI independent review · SYNTHETIC · 2026-09-16`; earlier browser writes created its plan, actual entry, note and linked screenshot workspace. On 2026-09-21 a clearly labeled synthetic PNG was attached in three roles: H4 through the initial live upload check, M5 through the local browser, and OTHER through the hosted Preview. M5 was excluded from future reviews through the existing soft-removal action and remains preserved in Journal. The hosted browser also closed the synthetic trade, saved an account observation and saved a separate blocked proposal. These are journal records with no broker execution.

Eight focused live security check groups pass: upload persistence; owner byte-for-byte delivery; foreign/signed-out denial and RLS; public-storage denial; removed-image preservation; AI-disabled behavior/history; signed-out private routes; and preserved original/note/private-image markup. The original plan row was unchanged by these checks. Final read-only queries confirmed original prices/risk/news, one WIN/+3R/$150 close, four ordered events, three screenshots and one exclusion, existing failed AI history, zero new evaluations, the new proposal with no lock, and the saved $10,150 observation. Personal trading records, passwords, policies and migrations were not modified. Synthetic audit history remains preserved.

## PREVIEW

**READY:** https://trading-49cazmkg0-maksim61910-7648.vercel.app

- Deployment: `dpl_6mecsccUishshF59n1a34QowCcjZ`.
- Review branch: `review/opus-ui-v2`; deployed commit: `5065202a027d03555e0eaf8349e8067b53f6f563`.
- The final report update is documentation only; the deployed application source matches the reviewed source exactly.
- Vercel reports READY and a non-production target (`null`, its Preview representation); no aliases were assigned.
- The user explicitly authorized the existing `SUPABASE_SECRET_KEY` for Preview only. The earlier approval block is resolved. The key was supplied to this deployment's server runtime only; there is no new persistent project-level Preview variable. Future independent Preview deployments must receive the same authorized server configuration if screenshot uploads are required.
- `AI_ENABLED=false`; no OpenAI key supplied and no live AI evaluation performed.
- Production remains https://trading-os-six-brown.vercel.app on `dpl_8Cxi2zNDGhSp2q6mNAna1R3XQN5U`. Its environment-variable update timestamps predate this review deployment. Production variables, alias and protection setting `all_except_custom_domains` were verified unchanged after browser acceptance.
- Existing Vercel access protection remains in place. The user may need to sign into Vercel before reaching the Trading OS login. The isolated test account was signed out for handoff.

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

1. No physical iPhone/Safari, on-screen keyboard, hardware safe-area or comprehensive WCAG certification. Browser viewport and keyboard checks passed.
2. Minor EDGE divider styling remains at the two-column breakpoint; metrics remain readable and correct.
3. Password recovery was covered by preserved tests and unchanged architecture, without sending a new recovery email during this UI review.
4. Screenshot thumbnails still download original private images; optimization remains deferred with the other eight future requests.
5. The preview shares the existing Supabase project; all review writes were confined to the explicitly authorized isolated synthetic account. Review branch has not been merged or deployed to production.

## FINAL STATUS

Protected code, automated verification, Node 24, focused security checks, browser workflows and the responsive matrix pass. The Preview is available for the user's visual review. No application code was changed by the independent reviewer, no future request was implemented, and no main merge or production deployment was performed or authorized by this review.

GO FOR USER VISUAL REVIEW
