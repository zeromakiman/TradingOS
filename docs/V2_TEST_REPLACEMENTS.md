# V1 → V2 test replacements

The record that V2_ARCHITECTURE.md §12.3 and §16.1 refer to: every V1 test that V2 deleted or rewrote, the intents it
protected, and the V2 tests that assert them now. Referenced from docs/V2_REPORT.md item 40.

Every test that pinned V1 presentation, or imported a module deleted as V1-only, is listed with the intents it
protected and the V2 test(s) that now assert the same intent with equal or stronger assertions. "RRP" =
`tests/v2-v1-replacements-presentation.test.ts`; "RRT" = `-today`; "RRR" = `-routes`; "RRS" = `-ai-settings`;
"RRH" = `-ai-history`; "RRA" = `-ai-actions`; "RRX" = `-actions` (all `tests/v2-v1-replacements-*.test.ts`, new).
Deterministic, database, RLS and AI contract/budget/citation tests are untouched (none was weakened or deleted). The unused-export
clean-up (section at the end) deleted only cases whose sole subject was a function nothing in the app calls any
more, three of them in such files (tests/ai.test.ts, tests/setup-ai.test.ts, tests/risk.test.ts); every live function
those files test keeps its cases.

## tests/ui-review.test.ts — deleted (subjects: V1 journal page, session-ribbon, status-banner, numeric, domain/ux)

| V1 intent | V2 test(s) |
|---|---|
| Journal keeps every row in query order across the UTC−5 midnight; 50 unique links; day headers never claim an aggregate for a day split across pages | v2-screen-journal › "keeps every row in query order across the strategy midnight and says the last day continues only when it does"; "does not claim the last day continues when the next page starts on an earlier day"; "trims a read of one trade past the page and keeps the reader's cursor otherwise" |
| Filters reach the loader and survive paging/return links | v2-screen-journal › "links Older through the reader's own cursor when the read stopped at its scan limit, without claiming the day continues"; "keeps drill-down links from EDGE, the calendar and Accounts working and visible as removable chips"; "search keeps the other filters as hidden fields and offers a clear link"; "every menu option links to exactly the filters it names"; "ignores cursors and trails it did not write" |
| Session ribbon names the first distinct next session across calendar/DST boundaries (3 instants), with its day; day segments cover 0–1440 | RRP › "renders the next session, its time and 'tomorrow' only when it falls on the next strategy day, at %s" (same 3 instants, rendered component); "tiles %s from 00:00 to 24:00 exactly once…" (7 days incl. US/EU DST, year end, leap day); v2-session-boundaries › "around %s" (minute scans of 3-day DST windows) |
| Status banner shows the authoritative label with every binding reason (restricted) | RRT › "states the block with every binding reason and still leads with the live trade and its actions"; v2-screen-today › "blocks in the Dead Pool with the engine's sentence and the boundary in the ribbon", "says when the daily trade limit is reached and that no trades are left" |
| formatR never reinterprets values; tone follows the printed sign | RRP › "%s reads %s with the %s tone, the same from text and from a Decimal" (the 5 V1 values + 2); v2-domain-format › "formatR(%s) = %s", "never renders a non-zero R as zero or as -0.00R" |

## tests/ui-presentation.test.ts — deleted (subjects: session-ribbon, status-banner, numeric, edge-dashboard, domain/ux)

| V1 intent | V2 test(s) |
|---|---|
| Segments cover every minute exactly once, agree with strategyClock, in clock order | RRP › "tiles %s from 00:00 to 24:00 exactly once, each segment agreeing with the clock at both ends"; v2-screen-today › "walks the strategy day through its sessions with exact boundaries" |
| Next-transition table (00:30, 01:30, 06:00, 13:00, 18:00 … 23:59) | RRP › "at %s UTC−5 the next session is %s at %s (next day: %s)"; v2-session-boundaries › "after %s the next session starts at %s (%s, %s UTC−5 on %s)" |
| Never announces the running session; announces the first transition (1440-minute scan) | RRP › "announces, for every minute of a day, the first session change and never the session already running"; v2-session-boundaries › "around %s" |
| A clear day is clear in both engine and status | v2-domain-daily-status › "reports a clear day" |
| Every restriction the status shows also blocks the engine (Dead Pool, stale values, slots, live-first slots, risk cap, legacy loss, loss cap) | v2-domain-daily-status › invariant "%s" (10 named states) and "holds over seeded random account states" (400 states) |
| Authoritative labels (READY, DEAD POOL, DAILY LIMIT REACHED, ACTION REQUIRED) | v2-domain-daily-status › "reports a clear day", "blocks Dead Pool from 12:00 UTC−5 to the microsecond", "counts planned and live-first trades toward the daily limit", "asks to confirm stale or missing account values, with an action" (V2 headlines). PLAN/TRADE ACTIVE: V2 lists them as sections — v2-screen-today › "lists plans waiting…", "shows live trades first…" |
| Active work is not hidden by a restriction | RRT › both tests |
| R tone from the formatted sign | RRP › R tone test |
| Low-sample emphasis uses only the existing bands | v2-domain-performance › "uses the V1 bands" (n = 0…150 identical to V1), "explains each band"; v2-screen-edge › "de-emphasises win rate, profit factor and expectancy below ten trades with the exact early-sample sentence" (spec 13.8: the VERY SMALL boundary; computed from the count, so no unknown band can exist) |

## tests/ux.test.ts — deleted (subjects: src/domain/ux.ts, src/components/unsaved-changes.tsx)

| V1 intent | V2 test(s) |
|---|---|
| Ready = slots remain, not approval of a plan | RRP › "keeps an approved plan's own check separate: a clear day is not an approval of any plan"; v2-domain-daily-status › "reports a clear day" |
| Active trade continues while new locks are blocked | RRT › "states the block with every binding reason and still leads with the live trade and its actions" |
| Live-first trades count toward slots | v2-domain-daily-status › "counts planned and live-first trades toward the daily limit" |
| Plan awaiting execution is identified | v2-screen-today › "lists plans waiting with one next action each and the first blocking reason of a blocked draft" |
| Stale account values exactly at the strategy-day boundary | RRP › "flags yesterday's account values exactly at the strategy midnight, and the engine agrees"; v2-domain-daily-status › "asks to confirm stale or missing account values, with an action" |
| Money caps with exact decimals (99.99 + 0.01) | v2-domain-daily-status › "blocks when the daily risk cap is reached, not before", "blocks when realized/external losses plus open risk reach the loss limit" (50.004 + 49.996), "never promises more remaining risk than the engine allows" |
| A cap needs no manually reported loss (engine 1.2) | RRP › "needs no reported loss for a configured daily loss limit: with no losses today the day is clear"; v2-domain-daily-status › "uses greatest(legacy reported loss, realized + external)…" |
| Never negative slots | RRP › "never shows a negative number of trades left, even past the limit" |
| Unsupported filters and impossible dates rejected; valid ones kept, search trimmed | RRP › "names unsupported values and impossible dates, ignores them, and keeps the valid ones"; v2-screen-journal › "names unreadable filters in words and ignores them", "explains an impossible date range instead of loading" |
| Search cannot inject PostgREST filter syntax | RRP › "strips PostgREST filter syntax from a search, so it can only ever match an instrument", "matches nothing for a search without an instrument part or a matching record, instead of everything" |
| Filters survive pagination | v2-screen-journal › "links Older through the reader's own cursor…" |
| Unsafe return destinations rejected | V2 has no free return parameter (the Journal trail only accepts cursors it wrote: v2-screen-journal › "ignores cursors and trails it did not write"); the only query-carrying redirects: v2-legacy-routes › "never lets a query string change where a legacy link leads (no open redirect)" |
| Unsaved-changes guard (anchors free, navigation warned) | V2 keeps entries instead of warning: v2-screen-forms › "unsaved entries kept in the tab" suite (9 tests); v2-screen-today-model › "keeps a closed panel mounted, so a typed note or staged screenshots survive…", "counts typed text and staged screenshots, never empty fields" |
| A blocked lock is never reported as saved; a real lock is acknowledged | v2-actions-trades › "explains a blocked check and refuses to report a blocked lock as success" |
| No invented lock on an unexpected reply | RRX › "Lock plan never reports a lock for %s" (4 replies), "Check risk never reports a verdict for %s" |
| formatR examples | v2-domain-format › "formatR(%s) = %s" |
| UTC labels and explicit offsets | RRP › "labels UTC and converts a UTC−5 instant"; v2-domain-time › "formats strategy, UTC and local time from the same instant", "labels zones" |
| Missing stop still saves; geometry explained; numeric fields named; reasoning required | v2-screen-forms › "validate with the engine's field sentences and send the 11 proposal keys", "names what is missing and the blocks that apply to any plan right now", "state the tick size, distance in pips, side and RR without colour alone", "previews with a stand-in thesis but reports that saving needs one", "explains blocks with the exact sentences, BLOCK first" |
| Event summaries without ids | v2-ui-journal-timeline › "keeps ids, codes and details out of the default view, behind collapsed Technical details", "states stop, target and partial details in plain words" |

## tests/ai-settings.test.ts — rewritten in place (V1 AiSettings component deleted; the actions stay)

The 8 action tests (consent, unavailable deployment, budget never silently raised, disabling always allowed, budget never
changes opt-in, 5 invalid amounts, signed-out, ownership denial) are kept unchanged.

| V1 component intent | V2 test(s) |
|---|---|
| OFF, cost, remaining, reset day, advisory copy, reservation disclosure | v2-screen-settings › "shows each account's AI budget, the opt-in with consent and the monthly limit, without internals"; v2-ui-ai-components › "states usage, limit, remainder and reset day with one status chip", "keeps held amounts in Details and never says 'reservation' by default"; RRS › consent step (advisory copy) |
| Activation is a separate step with an unchecked, required confirmation | RRS › "is a separate, explicit step with an unchecked, required consent before anything can be sent" |
| ON offers deactivation, not another opt-in | RRS › "offers only turning it off once AI is on, never a second opt-in" |
| AI on with uncertain accounting (V1 "uncertainty is unavailable even when unused capacity remains": "Accounting review required" AND "Disable AI") — turning AI off stays possible | RRS › "still lets the trader turn AI off while %s" (an earlier request's cost needs review; the deployment can't run AI: enabled submit, no disabled/aria-disabled, its form posts enabled=false for this account, no opt-in anywhere); RRS › "Settings → AI page: an account with AI on whose earlier request's cost needs review" › "says AI is paused for review and keeps 'Turn off AI' usable, never a way to turn it on" (the real SettingsPage: "Paused — needs review" chip + enabled "Turn off AI for …") |
| Unavailable deployment cannot activate; budget editing stays usable | RRS › "can't be turned on while AI is unavailable, says why, and keeps the monthly limit editable"; v2-screen-settings › "explains honestly when the deployment can't run AI and disables turning it on" |
| Budget reached / thresholds in words | v2-ui-ai-components › "status chip %#: %s", "says Limit reached once the remainder can't cover the cheapest request, as the AI buttons do" |
| Uncertain accounting pauses AI | v2-screen-settings › "pauses turning AI on while an earlier request's cost needs review"; RRS › "with AI off, the same pause blocks turning it on and says why"; v2-ui-ai-components › "status chip %#: %s" (Paused — needs review) |

## tests/ai-failure-accounting-ui.test.ts — deleted (6 V1 AI panels deleted)

| V1 intent | V2 test(s) |
|---|---|
| A FAILED attempt shows its real accounting state (SETTLED, UNCERTAIN, CANCELLED, unreconciled, unknown, none) for every operation, with code and version kept, without mutating history | RRH › "%s: %s" (7 operations incl. the timeline review × 6 states: plain wording per state, code/version/disposition/reservation only in Technical details, inputs deep-equal after rendering), "never words two different outcomes the same way"; v2-ui-ai-components › "states what a failed attempt cost in plain words for every accounting outcome", "keeps the technical fields of failed rows in the HTML, inside a collapsed element"; v2-ai-history › "explains failures and accounting in plain words while technical details carry codes and amounts" |
| Historical facts without a source manifest stay readable | RRH › "%s renders a completed result from facts without a manifest, leaving the facts untouched" (6 V1 contracts) |
| Monthly comparison caveat ("Change requires comparable earlier and later evidence"; completeness is not improvement) | AI side: monthly-review-contract › "counts matching input, enforces output and reconciles usage" (asserts both instructions). UI: `CHANGE_EVIDENCE_NOTE` under What improved / What degraded — v2-domain-ai-summary › "a monthly review's change sections carry the comparison caveat from Trading OS (kept from V1), no other section does"; v2-ui-ai-components › "a monthly review's What improved and What degraded carry the comparison caveat from Trading OS, apart from the AI text". Applied in the app: `resolveCardSources` (src/lib/ai-history.ts) and `sectionModels` (src/components/ai/model.ts) pass the note on, and the full-analysis sheet shows it under both sections, apart from the AI text — v2-ai-periodic-caveat › "a stored monthly review shows the caveat from Trading OS under What improved and What degraded, apart from the AI text", "other reviews show no caveat". This replaces the V1 panel test tests/ai-failure-accounting-ui.test.ts:52-53 at bc5441c ("monthly comparison notice preserves historical interpretation without claiming completeness proves improvement") |

## tests/ai-disabled.test.ts — rewritten in place (V1 SetupControls deleted)

The 9 isolation tests (flag fails closed, key required, model settings contained, orchestration loads nothing, provider
cannot be bypassed, no key → no network, disabled POST answer, configuration error only on the AI endpoint, auth kept) are
kept unchanged. The SetupControls test (AI off: AI button inert with the reason, risk and upload controls usable, no
alert) → RRH › "%s: both tools stay visible but inert, say why, raise no alert and request nothing" (DISABLED,
CONFIGURATION_ERROR); v2-screen-trade › "shows a blocked draft with its exact reasons, Edit draft as the one next
action and no way to lock" and "starts an unchecked draft with the free check…" (rendered with AI unavailable: Recheck
risk / Check risk, Edit draft, Add screenshots present); v2-ui-ai-panels › "explains why tools cannot run…".

## tests/analyze-setup-actions-data.test.ts, tests/bias-challenge-actions-data.test.ts — rewritten, then deleted

First rewrite: the 5 tests of the deleted V1 actions (`requestAnalyzeSetup`, `requestBiasChallenge`) → v2-ai-actions › "%s
passes only the trade, the request key, the selection and the shown revision", "%s is terminal, so the form rotates its
request key", "%s is returned as an error the key can be reused for", "invalid input %# never reaches the service",
"hides internal failures behind human copy and logs only a fixed event name"; RRA › "setup analysis action" and "bias
challenge action" suites (forged cost/proposal/permission/identity fields never reach the service; malformed ids; 3
terminal and 4 refusal outcomes; hidden internal failure) and "selected screenshots are bounded before any service call".

Unused-export clean-up: the 4 loader tests of each file that the first rewrite kept exercised only the V1 setup-page loaders
`loadAnalyzeSetupPanel` / `loadBiasChallengePanel`, which nothing in the app calls (the trade page uses
`loadTradeAnalyzeSetupPanel` / `loadTradeBiasChallengePanel` → `loadDraftPanel`). Loaders and both files deleted:

| V1 loader intent | V2 test(s) on the trade-page loaders (tests/v2-ai-pretrade.test.ts, "V2 pre-trade panels") |
|---|---|
| AI off: preserved facts, output and accounting stay readable, scoped to owner and proposal | "with AI off, keeps the saved results and their accounting readable, reads only the owner's records and downloads nothing" (new: DISABLED availability, reservation + usage read with the owner filter, another user's request and hold never read); "shows the latest revision, the Risk Engine decision, eligible evidence and this operation's history across revisions" (owner + every revision of the trade) |
| Locked: history kept, locked state and unchanged risk decision exposed | "keeps history readable on locked trades but offers no evidence, and degrades on storage errors"; "shows the latest revision, the Risk Engine decision…" (`riskDecision: "BLOCKED"`) |
| AI storage failure disables only the optional panel | "keeps history readable on locked trades but offers no evidence, and degrades on storage errors" (CONFIGURATION_ERROR, empty history, "Draft records are unaffected") |
| Evidence labels exclude removed, foreign and unrelated-proposal images, without downloads | "shows the latest revision…" (removed, other-trade and earlier-revision legacy screenshots excluded); the new AI-off test asserts no download |

## tests/analyze-setup.test.ts, tests/bias-challenge.test.ts — deleted in the unused-export clean-up

Subjects deleted: the V1 services `analyzeSetup(proposalId, …)` (src/lib/analyze-setup.ts) and `challengeBias(…)`
(src/lib/bias-challenge.ts), whose actions were deleted earlier; the V2 trade page runs `analyzeTradeSetup` /
`challengeTradeBias` (`runDraftRequest`, latest revision only). Each file held the same 17 cases (15 titles); "TP" =
tests/v2-ai-pretrade.test.ts.

| V1 intent | V2 test(s) |
|---|---|
| Foreign/signed-out access fails before privileged writes or dispatch | TP › "refuses trades of other users" |
| DISABLED, ACCOUNT_OFF, CONFIGURATION_ERROR, BUDGET_REACHED block without a provider request | TP › "%s blocks before the proposal is loaded" |
| Locked plans cannot start new requests | TP › "%s returns %s without loading the proposal, writing or calling the provider" (a locked plan → LOCKED), "a V1 lock that bypassed the trade model still counts as locked" |
| A blocked risk result can be examined, stays blocked, the proposal never changes | TP › "%s examines a blocked draft without changing it, and sends neither earlier AI output, setup history nor unselected screenshots" (new, both operations: TRADE_BLOCKED sent as a fact, only start/authorize/finish RPCs, proposal and risk deep-equal afterwards) |
| Only the current allowlisted context; no history, prior output or unselected screenshots | same new test (prior `[]`, images `[]`, no oldAI/oldHistory/storage_path, no download); "analyses the latest revision with V2 and legacy evidence downloaded from their own buckets" (exact downloads, no storage path in the facts) |
| Foreign/removed evidence rejected before storage or dispatch | TP › "rejects %s before any download or write" (removed, another trade's, an earlier revision's legacy screenshot, unknown id) |
| Selected image ownership and exact bytes; only selected evidence sent | TP › "changed evidence bytes fail the attempt before any reservation"; "analyses the latest revision with V2 and legacy evidence…" |
| Duplicate/over-limit selections rejected before context loading | TP › "validates ids, selection size and duplicates before any database access" |
| Replay does not spend again; new runs append separate ids | TP › "a replayed request id never reaches the provider again"; a new run gets a new id because the form rotates its request key after a terminal outcome: v2-ai-actions › "%s is terminal, so the form rotates its request key" |
| Reservation, dispatch and generation each recheck ownership and evidence | TP › "analyses the latest revision…" (three `authorize_bias_challenge` calls, reservation after the start) |
| A newly locked proposal prevents dispatch through the extra gate | TP › "a draft or evidence change caught by authorization stops before the reservation" |
| Invalid AI decision/mutation fields preserved as failure and never applied | TP › "persists invalid output %# as FAILED with the raw output and its reservation" |
| Network failure preserves the attempt and never retries | TP › "a provider failure is recorded once as %#" |
| Finish persistence failure cannot trigger another generation | TP › "a finish persistence failure is reported without another generation" |
| Persists exactly the canonical manifest-bound contract sent to the adapter | TP › "analyses the latest revision…" (`p_facts` equals the sent context, `p_contract` equals `operationContract`, ANALYZE_SETUP_CITATIONS_V2); "challenges the latest revision with the relabelled role of an evidence item" (CHALLENGE_BIAS_CITATIONS_V2) |
| Rejected raw citations preserved in failed immutable history | TP › "persists invalid output %# as FAILED…" (the evidence citation without selected evidence); citation rules per source: ai-citation-contracts |

## tests/weekly-review-actions-data.test.ts, tests/monthly-review-actions-data.test.ts, tests/recent-trades-actions-data.test.ts — deleted

Both subjects deleted (V1 actions in src/app/*-review-actions.ts and loaders src/lib/*-review-data.ts).

| V1 intent | V2 test(s) |
|---|---|
| Only owner account/period/key reach the service; client cost, facts, permission ignored | RRA › "weekly review action", "recent trades action", "monthly review action" › "passes only the parsed ids to the service, whatever else the browser sends"; v2-ai-actions › "weekly: normalises the chosen day to its Monday and refreshes /review", "recent trades: accepts only 10, 20 or 30", "monthly: validates the month and maps outcomes" |
| Terminal statuses rotate the key; budget refusal stays an error | RRA › "reports %s as terminal…", "returns %s as an error without a false completed state" (per action) |
| Malformed requestKey/accountId/period never call the service | RRA › "never calls the service with a malformed %s"; v2-ai-actions periodic tests |
| Internal details never exposed | RRA › "hides an internal failure behind human copy and logs only a fixed event" |
| History scoped to owner/account/period with persisted cost; reading never calls the service | RRH › "periodic AI reviews read only the owner's history of that account and period" (weekly, recent, monthly: foreign account, foreign user and other period rows excluded; filters asserted; no action called); v2-ui-ai-panels › "shows the period's latest review…, and only this period's history"; v2-ai-history › "explains failures and accounting…" (charged/reserved amounts in technical) |
| Ownership denial is not converted into another account | RRH › "%s: a refused account is an error, never another account's history" (no table read); v2-ui-ai-panels › "rejects an invalid period and degrades for an unavailable account" |
| History read failure disables only the optional review | RRH › "%s: unreadable history becomes a message, never a broken page" |
| Source failure keeps saved history | RRH › "%s: unreadable period trades keep the saved history and disable a new run", "shows the saved review with the run button inert when the week's trades can't be read" |
| Invalid pagination clamped | V2 panels have no page parameter (latest rows + disclosure); /review/history cursors: v2-screen-review-model › "round-trips the history cursor and rejects anything it did not write", "flags unreadable periods and falls back to the defaults instead of failing" |

## tests/trade-review-actions.test.ts, tests/trade-review-data.test.ts, tests/trade-review.test.ts — deleted

Subjects deleted: src/app/trade-review-actions.ts, src/lib/trade-review.ts, src/lib/trade-review-data.ts (V1
REVIEW_TRADE runs; spec 11.4: REVIEW_TRADE V1 stays for history only, no new V1 request from the V2 UI). The stored V1
contract and history keep their own tests (trade-review-contract, trade-review-database, trade-review-sources,
v2-ai-history, v2-ui-ai-panels › "offers 'Review this trade' once closed, shows the latest review and lists V1 reviews
in the history").

| V1 intent | V2 test(s) (timeline-aware review, the only trade review V2 can start) |
|---|---|
| Action forwards only ids + selected evidence; terminal/refusal outcomes; over-limit evidence; malformed ids; ownership errors hidden | v2-ai-actions › "accepts up to four screenshots and refreshes the trade, settings and journal", "returns no-write states as errors"; RRA › "trade review action" suite, "selected screenshots are bounded…" |
| Owner-bound lookup; signed-out/foreign never reach data or privileged writes | v2-ai-timeline-review › "validates ids and the selection before any database access", "refuses trades of other users without privileged writes" |
| Availability gates (DISABLED, ACCOUNT_OFF, CONFIGURATION_ERROR, BUDGET_REACHED) block before evidence, writes, dispatch | v2-ai-timeline-review › "%s returns without loading records, writing or calling the provider" |
| Requires a closed trade | v2-ai-timeline-review › "requires a closed trade" |
| Only this trade's sealed facts; no prior; manifest-bound contract stored = dispatched | v2-ai-timeline-review › "stores the facts and manifest-bound contract, authorizes before every ledger step and appends the result" |
| Invalid/foreign/unsupported citations persist FAILED with raw output and the charged reservation, never settled twice | v2-ai-timeline-review › "persists %s as FAILED with the raw output and the charged reservation" (hindsight, foreign, decision field, directive, no-plan contradiction) |
| Replay never calls the provider; concurrent start refused | v2-ai-timeline-review › "a replayed request id is recorded once and never reaches the provider again", "maps the start refusal %j to %s without dispatch"; v2-ai-database › "allows one in-flight review per trade and returns false for a replayed request id" |
| Foreign/removed selected evidence rejected before download; unselected never sent; owner download + hash check; mismatched bytes fail before reservation | v2-ai-timeline-review › "rejects %s evidence before any download or write", "%s fails the attempt before any reservation", lifecycle test (exact downloads, no storage path in facts) |
| Provider/accounting failure recorded; persistence failure never retries | v2-ai-timeline-review › "records provider or accounting failure %s without retrying", "a finish persistence failure is reported and never triggers another generation" |
| Panel: AI off still reads history and cost; expired pricing / missing migration disable only the panel; removed evidence excluded, nothing downloaded on load; Mini maximum disclosed | v2-ai-timeline-review › "lists selectable evidence with timing and parses every history row by its stored contract", "keeps the trade page usable when AI history cannot be loaded or pricing has expired"; v2-ai-history › "throws for a trade of another user and degrades when AI history cannot be read"; v2-ui-ai-components › "formats the typical cost and the reserved maximum, and falls back to null when pricing expired (never throws)" |

## tests/audit-routes.test.ts, tests/setup-routes.test.ts — rewritten in place (V1 upload route deleted)

The CSV export, legacy screenshot download and proxy tests stay. The removed POST /api/setups/[id]/screenshots tests →

| V1 intent | V2 test(s) on POST /api/trades/[id]/evidence |
|---|---|
| Unsigned → 401 before privileged storage; cross-origin → 403 | v2-routes-evidence › "answers 401 without a session and refuses writes on an outdated schema", "rejects %s before storage" (cross-origin) |
| Browser Host accepted behind an internal bind hostname; forwarded Host never trusted | RRR › "accepts the browser's Host when Next serves the request on its internal bind hostname", "never trusts an attacker-controlled forwarded Host" |
| Another user's record → 404 before upload | v2-routes-evidence › "rejects %s before storage" (another user's trade, malformed id) |
| Spoofed images rejected before storage | RRR › "refuses markup disguised as a PNG before storage"; v2-routes-evidence › bytes not matching the type, truncated image |
| Verified owner and validated metadata, form identity ignored | RRR › "stores and registers for the verified user, ignoring identity and path fields sent in the form"; v2-routes-evidence › "stores the image at {uid}/{trade}/{evidenceId} without overwrite and registers it for the verified user" |
| Cleanup when registration fails; failed cleanup logged without paths | v2-routes-evidence › "cleans up after a failed registration and logs fixed events only" |
| DB read outage → no storage call | RRR › "stops before storage when the ownership read fails, without revealing the database error" |
| Failed upload contained before metadata, no leak | RRR › "contains a storage failure: no registration, and the storage message never reaches the response or the log"; v2-routes-evidence › "reports a storage outage without registering anything" |
| Backend cap → 409 and the rejected object removed | v2-routes-evidence › "returns 409 at the evidence limit and removes the rejected object" |
| Malformed multipart → 400 before storage | RRR › "answers a body that is not a multipart form as a validation error, before storage" |
| Oversized body → 413 before decoding | v2-routes-evidence › "rejects a body above 4 MiB + 64 KiB by header and by streamed size" |
| Object path never derived from the filename | v2-routes-evidence › "stores the image at {uid}/{trade}/{evidenceId}…" (filename "../../\u0007chart.png" sanitised, path from ids) |

## tests/browser/*-entry.tsx + scripts/*-browser-harness.mjs (7 + 7) — deleted

Manual browser benches that mounted the V1 AI panels (ai-budget, analyze-setup, bias-challenge, weekly, recent, monthly,
trade review) with scenario switches (ON, OFF, UNAVAILABLE, BUDGET REACHED, EMPTY, SCOPE LIMIT, COMPLETED, FAILED, IN
PROGRESS, INCOMPLETE, SUBMIT ERROR, SUBMIT FAILURE) against synthetic services. V2: the real app on the local stack with
the mock provider (scripts/local-stack/mock-openai.mjs; per-schema scenarios in .local/mock-openai-scenarios.json: ok,
refusal, incomplete, invalid_json, schema_violation, foreign_source, hindsight_citation, trading_directive, http_500,
http_429, http_401, http_403, network_error, count_unavailable, input_limit_exceeded, plus delayMs for in-progress),
scripts/local-stack/screenshot.mjs and the acceptance runner scripts/local-stack/acceptance/; every
panel state is unit-tested in v2-ui-ai-panels, v2-ui-ai-components, v2-screen-review, RRH and RRS.

## src/app/loading.tsx — deleted (V1 root loading convention)

Not unreachable code but a Next.js file convention (an entry point): the V1 root Suspense fallback ("Loading your
workspace…" in the V1 `padded`/`loading-grid`/`skeleton` classes). Deleted because it was V1 presentation and, as a
boundary above every page, it made Next.js commit to 200 before a page could redirect: every legacy bookmark answered a
streamed 200 with a client-side redirect, and a legacy link to a missing or foreign record a 200 not-found page
(node_modules/next/dist/docs/01-app/02-guides/streaming.md, "The HTTP contract" › "Status codes"). The V2 app keeps its
skeletons through src/app/(app)/loading.tsx, which wraps only the (app) group, so no legacy page. Live
(2026-10-27): / → 307 /today, /preview → 307 /login, /analyze?… → 307 /trades/new?…, /analyze/[own proposal] and
/journal/[own plan] → 307 /trades/[id], /edge/weekly|recent|monthly?… → 307 /review/…?…, /analyze/[foreign] and
/journal/[foreign] → 404.

| Intent | Guard |
|---|---|
| Legacy links answer real HTTP 307/404, never a streamed 200 | v2-legacy-routes › "legacy links answer with real HTTP redirects and 404s, not a streamed page": "checks every redirecting legacy page, through src/app itself"; "%s has no loading boundary above it" (8 redirect pages, every segment folder up to src/app); "%s has no layout or template that suspends its content"; "the guard recognises a Suspense around children and ignores one around a sibling" |

## scripts/verify-{ux,non-ai,edge,ai}-live.mjs — deleted; scripts/verify-audit-live.mjs, scripts/verify-audit-flows.mjs — ported to V2 data

- verify-ux-live.mjs, verify-non-ai-live.mjs, verify-edge-live.mjs drove V1 screens (V1 page headings, V1 Journal form
  posts, V1 EDGE copy) and V1 RPCs that 0019 revokes (record_setup_decision, record_observation, create_risk_version);
  verify-ai-live.mjs uploaded through the deleted V1 route and ran the paid legacy evaluator that V2 no longer offers
  (spec 11.6; pricing expired 2026-10-22). Replacement: scripts/local-stack/acceptance/run.mjs (live V2 flows, mock AI)
  and the tests above; `package.json` "test:ai-live" removed with its script.
- verify-audit-live.mjs keeps every security check and now reads its fixtures from V2 data (users[1]'s earliest locked
  plan, the trade that owns it via trade_plan_links, the proposal of that trade's latest revision, a trade_evidence
  item); it fails with "users[1] has no …; seed it first" when one is missing. V1-only rows are optional: without a
  setup_screenshots row the legacy screenshot checks (cross-user GET /api/screenshots/[id], legacy bucket object
  download/public URL, owner download, remove_setup_screenshot) print SKIPPED and are listed under "skipped" in the
  report; without a FAILED setup_evaluation_events row the "preserves previous failed history" part is SKIPPED (the
  no-new-evaluation part always runs). V2 equivalents always run: cross-user /trades/[id], GET /api/evidence/[id]
  (+ ?variant=thumb) 404 for the other user and 200 private for the owner, anonymous 401 on /api/evidence, /api/export
  and the legacy route, the trade-evidence bucket (private, 4 MiB, no cross-user download/list, no browser upload, no
  public URL), foreign remove_trade_evidence/relabel_trade_evidence refused and the owner's evidence untouched; the
  cross-user table check also covers the 22 V2 tenant tables. Page titles are the V2 ones. New options: --users=<file>,
  --out=<file> (default docs/PREDEPLOY_LIVE_VERIFICATION.json, tracked) and --ai-enabled (a deployment that runs AI,
  such as the local stack with the mock provider: the legacy evaluator must refuse a body-less request and create no
  evaluation; without the flag it must answer DISABLED as before). Since the AI-accounting fix the route answers
  that request 400 `{"error":"Send a JSON body with an evaluationId (UUID) and a mode (NORMAL or DEEP)."}`, and the check
  now asserts exactly that status and message (it accepted any status ≥ 400 before); local run with --ai-enabled on two
  seeded users (cleanup5-a/b@example.test): 64 checks passed, 2 SKIPPED (no V1 rows). Run on the local stack with
  two seeded users (cleanupfix.a/b@example.test): 64 checks passed, 2 SKIPPED (no V1 rows); with one legacy screenshot
  added for users[1] through the service-role path, 64 passed and only the FAILED-history part SKIPPED.
- verify-audit-flows.mjs (broken only by the deleted V1 upload
  route): the two upload checks now use POST /api/trades/[id]/evidence on a Plan Trade draft (create_planned_trade) of
  the audit account with a fresh evidenceId per request — "Twenty-five concurrent uploads admit only twenty-four active
  screenshots" (24 × 201, 1 × 409, 24 registered rows, object paths {uid}/{trade}/{id}) and "Soft removal preserves
  private bytes and permits one replacement" (remove_trade_evidence, owner GET /api/evidence/[id] 200, one more 201,
  25 rows, then 409); the cookie-refresh check uses /api/evidence/[id] and adds /api/screenshots/[id] only when users[1]
  has a legacy row (SKIPPED otherwise). New options --users/--out as above. Local run: 8/8 checks, also with SKIPPED.

## Unused-export clean-up: exports without a caller, and the guard that keeps them out

Every name below had no caller in src/ or scripts/ (grep, then `tsc --noEmit` clean with it removed). The guard is new:
`scripts/check-unused-exports.mjs` (run by `pnpm lint` after Biome) fails when an exported value of src/ has no caller
in src/ or scripts/ (tests never count), or when an entry of its reasoned `KEPT` list no longer applies;
tests/v2-unused-exports.test.ts runs it on the repository (`{ unused: [], stale: [] }`) and pins the scanner on
synthetic trees.

Correction: the first version of the guard counted an export as called when its name appeared as a
whole word in any other src/ or scripts/ file, or more than once in its own module. That blind spot was wider than
first stated here ("only `analyzeSetup` and the two V1 panel loaders"): at HEAD 088dc29 it also hid `euros`,
`exportHref`, `exactText`, `fieldError`, `restoreFocusAfterDialog`, `restoreFocusWhenGone`, `sessions`, `schemaOutdated`
and `readZip` (a same-named local function, method, string, object key or fixture elsewhere), `realizedR` (its own
`{ realizedR: … }` result key) and `monthlyReviewContext` / `recentTradesContext` (named only in their own
`ReturnType<typeof …>` types), and after the first fix nine of them still passed. The guard now resolves callers per
module: an import of that name from a specifier that resolves to the module (`@/`, relative paths, with or without an
extension, `index` files, `.js` → `.ts`), a namespace or `await import()` binding read as `ns.N` or destructured,
`export { … } from` / `export *` forwarding (counted once the forwarded name has a caller), and the modules
scripts/local-stack/seed-v2.mjs loads by path (`load("ai/pricing.ts")`, bound by position in its `Promise.all`, read as
`app.pricing.N`). Inside a module an identifier use counts, but member accesses, object keys, strings, comments and a
function's own `typeof` do not. Run on the committed tree (HEAD 088dc29) it reports 54 exports without a caller (41
outside today's `KEPT` list), every name listed below among them; the earlier whole-word version reported 29.

| Deleted (file) | Was | Tests: what happened, and where the live behaviour is tested |
|---|---|---|
| `analyzeSetup`, `challengeBias` (src/lib/analyze-setup.ts, bias-challenge.ts) | V1 paid-AI services of the deleted setup page | tests/analyze-setup.test.ts, bias-challenge.test.ts deleted: section above |
| `loadAnalyzeSetupPanel`, `loadBiasChallengePanel` + their `*PanelData` types (src/lib/*-data.ts) | V1 setup-page panel loaders | tests/*-actions-data.test.ts deleted: section above |
| `loadTodayActivity`, `loadAccountToday` (src/lib/today-data.ts) | V1 Today loader (marked @deprecated); a V2 loader never wired up | none existed; Today: v2-screen-today, v2-today-data-losses |
| `loadWorkspace` + `accountRow`, `observationRow`, `instrumentRow` (src/lib/data.ts) | the retired V1 workspace | none existed (v2-screen-forms-data only names a mock `loadWorkspace` for `loadAccountWorkspace`) |
| `evaluationState`, `EvaluationRow` (src/lib/setup-data.ts) | V1 evaluation status | none existed |
| `getPerformance`, `getCalendar`, `calendarModeSchema` (src/lib/performance-data.ts) | V2 loaders never wired up | removed with the EDGE filter work; none existed |
| `linkedExecution`, `loadExecution`, `oneExecution` (src/lib/sync-service.ts) | single-execution reads never wired up | v2-connections-service: the two `loadExecution` lookups dropped; the candidate test takes its execution from `listUnmatchedExecutions` (same `toExecution` mapping); listing, link methods and parsing stay in "lists unmatched executions…", "lists linked executions…" |
| `exceedsInputLimit` (src/ai/request-estimate.ts) | duplicate of the inline `estimateRequest(…).tokens > maxInputTokens` checks | none existed; the inline checks: v2-ai-request-gate, v2-ai-operation-maxima, v2-ai-periodic-facts |
| `aiFailureAccountingMessage` (whole file src/ai/failure-accounting-message.ts) | V1 failure wording, replaced by `failureAccountingText` (AI panels) | none existed; v2-ai-history, v2-ui-ai-components, RRH |
| `loadAccountAiHistory`, `AccountAiHistory`, `PERIODIC_OPERATIONS` (src/lib/ai-history.ts) | account periodic history never wired up (the panels and Review → History have their own loaders) | v2-ai-history › describe "loadAccountAiHistory" replaced by describe "loadAccounting" (the shared accounting read every live history uses): "reads nothing without requests and only the owner's holds", "reads the owner's terminal accounting review of an unconfirmed cost and says what it settled" (ported: KEEP_UNCERTAIN and another user's review ignored, NO_PROVIDER_USAGE_CONFIRMED worded through `historyRow`, read failure); `weekLabel` keeps its own test; recent-sample scope labels: v2-ui-ai-panels ("Last 12 trades (20 requested)") |
| `TradeReviewV1Card`, `TradeTimelineReviewCard` (src/components/ai/operation-cards.tsx) | two identical components behind `TradeReviewCard` | `TradeReviewCard` now renders the card itself; v2-ui-ai-components › "Challenge My Bias and the trade reviews keep facts apart from the interpretation" renders both formats through it |
| `StaleRevisionMarker` (src/components/ai/stale-revision-marker.tsx) | wrapper over `StaleNotice` no screen used | v2-ui-ai-components › describe "StaleNotice": "states the analysed and the current revision, and there is no marker for the current one" (`staleRevisionLabel` + the rendered notice); the cards' markers: "operation cards" tests |
| `timelineTimeLabel` (src/components/trade/journal/timeline-model.ts) | duplicate of the `TimelineItem.timeLabel` rule | v2-ui-journal-timeline: the same assertions through a local helper over `timelineTime`, which the timeline renders ("time · recorded …"), including "agrees with the domain's own labels in every display" |
| `stagedStatusText` (src/components/evidence/stager-model.ts) | status line the stager card never used (it renders its own) | v2-ui-evidence-stager: two assertions on it dropped; the state transitions they sat in stay asserted |
| `rankByQuery` (src/components/shell/fuzzy.ts) | wrapper over `scoreByQuery` | v2-ui-shell: the ranking assertion now uses `scoreByQuery`, which the palette uses |
| `aiCostTooltip`, `aiActionLabel`, `aiCostLabel` + `euros` (src/domain/ai-summary.ts) | duplicates of the paid buttons' `estimateModel` + `estimateLabel` / `estimateTooltip` | v2-domain-ai-summary › "labels buttons and tooltips in euros, as the paid buttons show them": the same figures (≈ €0.02, at most €0.06 / €0.04 / €0.05, ≈ €0.03) through the live helpers |
| `parseLedgerRows` (src/domain/ledger.ts) | `rows.map(ledgerRow.parse)` | v2-domain-ledger › "parses pages of rows" now maps `ledgerRow.parse` |
| `tradingStatus` (src/ai/chart-contract.ts) | V1 status wording of the setup page | tests/setup-ai.test.ts › "preserves all AI and risk combinations" deleted (V2 trade states: v2-domain-trade-state) |
| `composeFinalEvaluation` (src/ai/validate.ts) | V1 final composition of the legacy evaluator (the legacy route refuses before any provider request) | tests/ai.test.ts › "a deterministic hard block dominates a supported AI result", "requires the same evidence package for final composition", "keeps grade and score missing while no grading policy exists" deleted; V2's rule that AI never decides: TP "%s examines a blocked draft without changing it…", RRA |
| `REVIEW_TRADE_VERSION`, `REVIEW_TRADE_TIMELINE_VERSION` | unused constants (the versions live in src/ai/operations.ts) | none existed |
| `moneyString` (src/domain/risk.ts) | V1 money schema no V2 schema uses | tests/risk.test.ts › "rejects invalid monetary input %s" deleted |
| `tradeCsv` (src/domain/analytics.ts) | V1 CSV writer; V2 writes the file in src/app/edge/export | tests/analytics.test.ts › "exports raw trade fields without authentication identifiers or formula injection" → v2-data-export › "guards every cell against spreadsheet formulas, like the V1 file", "writes CSV cells exactly: quoted, formula-guarded, tags joined, empty values blank" |
| `zipPathSegment` (src/lib/zip.ts) | path-segment helper the export never used (it names entries from ids; `createZip` refuses unsafe names) | v2-zip › describe "zipPathSegment" deleted; unsafe names: the `createZip` tests of v2-zip |
| `LAST_CLOSED` (src/app/edge/export/contract.ts) | alias of `LEGACY_LAST_CLOSED` for one test | v2-data-export imports `LEGACY_LAST_CLOSED` from src/components/edge/query.ts |
| `euros` (src/ai/budget.ts) | V1 euro formatter of the deleted AI panels (hidden by a local `euros` in src/components/ai/estimate.ts) | none existed; the paid buttons' euro figures: v2-domain-ai-summary › "labels buttons and tooltips in euros, as the paid buttons show them" |
| `pricingFor` (src/ai/pricing.ts) | V1 price lookup by model (hidden by the seed's `pricingFor()` method) | ai-budget › "unknown model, expired price and changed output bound never send" → "changed output bound never sends"; an unknown model or expired price fails in `operationPricing`, the lookup every request makes: ai-budget › "rejects unknown providers and mismatched pricing/model profiles", ai-mini-pricing › "fails closed on expired or mismatched prices and unknown operations", v2-ai-entry-points (legacy pricing expired) |
| `exactText` (src/components/trade/model.ts) | tick-size hint helper no screen used (hidden by a private `exactText` in src/domain/format.ts) | none existed |
| `fieldError` (src/components/trade/use-trade-action.ts) | copy of `fieldError` in src/components/accounts/use-account-action.ts, which the forms use | none existed; the live one: v2-screen-accounts › its `fieldError` assertions |
| `restoreFocusAfterDialog`, `restoreFocusWhenGone` (src/components/ui/focus.ts) | unused copies of the src/components/accounts/focus.ts helpers that Accounts and Today import | v2-ui-focus › "waits for an open dialog before restoring focus, and for a removed control to be gone" now imports them from accounts/focus (also covered by v2-screen-accounts' focus tests) |
| `sessions` (src/domain/analytics.ts) | V1 EDGE session list of the deleted V1 /edge page | none existed; session labels: src/components/shell/session-labels.ts (v2-ui-shell, v2-v1-replacements-presentation) |
| `realizedR` (src/domain/analytics.ts) | V1 full-close R helper the app never called (V1 and V2 record R in the database) | analytics › describe "full-close realized R" (5 cases) deleted → v2-domain-close › "works out a planned long…" (long, fees, loss, break-even, R = net ÷ locked risk), "turns the sign for a short…", "takes a reported net P&L as it is, and has no R without a risk basis"; v2-close-preview-parity (the same values as the database, which refuses negative fees: `check (fees >= 0)`); audit-math › "agrees with an independently summed fee-adjusted full-close ledger" and ai-budget › "AI ON/OFF cannot alter approved risk, realized R or nonempty EDGE results" now compute R with `calculatedClose`, the close preview the app shows |
| `schemaOutdated` (src/lib/schema-gate.ts) | page-side schema check nothing used (actions use their own over `writableSession`) | none existed |

Kept on purpose (the guard's `KEPT` list, each with its reason): `validateTradeReview` (stored V1 REVIEW_TRADE
contract), `filterTrades` (V1 EDGE filters; tests/analytics.test.ts also reads enrichTrades' sequence fields through
it), the three `src/domain/fixtures.ts` fixtures, `EvidenceJournalDemo` (dev demo), `CAPTURE_METHODS`, the UI
primitives `SheetClose`, `PopoverClose`, `DropdownMenuGroup`, and `readZip` (the strict reader of the
archives `createZip` writes, which the export tests use; it shares the writer's constants and CRC table) and the V1
fact builders `monthlyReviewContext`, `recentTradesContext` (the app builds only V2 facts; the stored-V1-history
fixtures tests/fixtures/monthly-review.ts and recent-trades.ts, and the mock-provider, contract and citation tests, build
their V1 facts with them). Follow-up for the V1 builders: move them into tests/fixtures with their behaviour tests in
monthly-review-contract / recent-trades-contract, then drop the two KEPT entries.

Former duplicate, resolved: src/components/accounts/focus.ts now imports `focusLost`,
`focusElement`, `onceReady` and `noDialogOpen` from src/components/ui/focus.ts (re-exporting the first two) and keeps
only `restoreFocusAfterDialog` and `restoreFocusWhenGone`, built on them — v2-ui-focus › "has one copy of each
primitive: accounts/focus re-exports the design system's focusLost and focusElement".

`listLinkCandidates` (src/lib/sync-service.ts), whose only remaining caller was a
test, was replaced by `loadLinkablePlans` (the account's linkable plans, read once for every waiting execution) and
`linkCandidatesFor` (one execution's candidates under the database rules). v2-connections-service › "offers link
candidates under the database rules, suggested matches first" now calls `linkCandidatesFor(execution, await
loadLinkablePlans(db, ACCOUNT))` with the same assertions; v2-data-connections › "reads the account's linkable plans
once for every waiting execution, never once per execution" pins the single read.

Replaced V1 presentation (trade timeline): the V1 /analyze/[id] "Human decisions" list → the trade
timeline's decision items: v2-domain-timeline › "shows each decision with the trader's reason, and keeps the skip that
ended the plan Before entry", "says Taken despite a block for a V1 manual override, and classifies decisions by their
recording time"; v2-ui-journal-timeline › "shows decisions recorded in V1 with the trader's reason, an override as
Taken despite a block"; v2-screen-trade › "explains a plan skipped in an earlier version with the trader's V1 reason,
and shows its V1 decisions", "shows a V1 decision to take a blocked setup as Taken despite a block, with the trader's
reason".
