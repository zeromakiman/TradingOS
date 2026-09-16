# Screenshot analyzer — implementation and activation review

**Current status, 2026-09-06:** Live AI is paused by user instruction. `AI_ENABLED=false` is the default; normal usage requires no OpenAI key or billing. See [AI-disabled mode](AI_DISABLED_MODE.md) for the latest 189-test and non-AI acceptance results. Earlier activation instructions below are historical and apply only after future explicit enablement.

Date: 2026-09-05. **Implemented locally; live activation and manual acceptance remain pending.** The prior deterministic/persistence acceptance evidence is unchanged. This report does not claim a successful paid Astra request or live screenshot upload.

## Implemented

- Immutable saved proposals before risk locking, including risk-blocked proposals. Saving recomputes and persists risk without reserving a slot. Existing locked plans can open an associated analysis workspace. Later locking rechecks current risk and links the existing proposal; it does not copy or lose its image/review history.
- PNG/JPEG/WEBP upload, user-assigned DAILY/H4/H1/M30/M15/M5/M3/OTHER roles, local preview, private authenticated image delivery, and selection removal. Each file has owner, account, proposal, original name, path, MIME, size, dimensions, SHA-256 and upload time. The proposal ID is the pre-lock trade-plan identity; `setup_locks` maps it to the immutable locked `trade_plans` ID.
- Limits: 4 MiB per file, 40 million decoded pixels, still images only, 1–8 images per evaluation. The 4 MiB upload ceiling also leaves room for multipart overhead. Signature checks plus a full Sharp decode reject unsupported, spoofed, corrupt and animated images. Stored original bytes are hashed again before sending to OpenAI.
- A new strict schema 2.0 wraps the existing schema 1.0 assessment with expanded MSS, displacement, liquidity, OB, OTE, target and evidence-quality fields. Existing validation and all original tests remain. Readable prices require observed references, first-touch claims require observed provenance, cross-pass identifiers are scoped, and missing OTE parameters cannot be supplied by the model.
- Every request loads the strategy by the proposal's permanent strategy ID, including the exact rules and written text. It never asks for the latest strategy. `ICT_V1`, its null OTE parameters and its null strategy grading policy are unchanged.
- Normal: one support/evaluation pass. Deep Review: independent A and B, then reconciliation with the original images. B never receives A. The reconciler must account for both reports and every prior finding; it does not average scores. A failed challenge prevents a successful final review, while earlier passes remain saved.
- Append-only evaluator versions, immutable input manifests and hashes, exact selected screenshot associations, pass outputs/statuses, response/model identifiers, token usage, lifecycle events and final results. Reanalysis creates a new record. A reused in-flight request cannot silently charge for a duplicate run.
- Separate AI and risk panels and a derived trading status. AI approval never permits a risk-blocked lock. A changed evidence selection or newer unfinished review is identified rather than presenting the older approval as current.
- Human TAKEN/SKIPPED decisions, timestamps and optional reasons. TAKEN with a risk or AI block records MANUAL_OVERRIDE. A failed retry cannot hide the last completed AI block. Recording a decision rechecks risk, including for locked plans, without double-counting that plan's reservation or rewriting its original report.
- Journal entries for proposed and locked setups, with AI decision, grade, evidence quality, risk, strategy, plan status and human decision. Details include screenshots, findings, original proposal, locked-plan link, passes and audit events.

## Database and Storage

`0001_foundation.sql`, `0002_baseline.sql` and `0003_persistence.sql` are preserved.

- `0004_setup_analysis.sql`: ten new tenant tables and one immutable evaluator-configuration table; composite ownership/version relationships; owner SELECT RLS; immutable-record triggers; narrow authenticated proposal/risk/removal/decision RPCs; server-only evaluation start/finish RPCs.
- `0005_private_screenshot_storage.sql`: private `setup-screenshots` bucket, 4 MiB object limit, allowed image MIME types. Authenticated reads require an owned registered screenshot. Browser insert/update/delete are denied, including by restrictive policies protecting this bucket from unrelated permissive policies. The server validates bytes before upload; no signed public links or privileged browser client are used.
- `AI_INSTALL.sql` combines these two sources in a transaction and records their exact SQL in migration history. Guards reject already-installed versions; no prior history is rewritten. Use only on the existing project with migrations 0001–0003 already installed.

Image selection removal appends a removal event; it does not erase original chart bytes or any historical evaluation association. Failed registration attempts request deletion only of the just-uploaded, unregistered object. Infrastructure failures during that cleanup can leave an inaccessible orphan object; operator cleanup is a future maintenance task.

## Model, prompt and grading

| Setting | Value |
|---|---|
| API | OpenAI Responses, server-side, `store:false`, strict JSON Schema, image data URLs, no tools |
| Default model | `gpt-6-astra` |
| Reasoning | `high` |
| Image detail | `high` |
| Output budget | 14,000 tokens per pass, including model reasoning |
| Provider timeout | 180 seconds per pass; no automatic paid retries |
| Prompt version | `ICT_EVALUATOR_V2` |
| Output schema | `2.0`, retaining nested assessment schema `1.0` |
| Grading config | `PROCESS_1` |

Model/effort/deep-review availability are centralized in `src/ai/config.ts`. The returned provider model identifier, when available, is saved in each pass. The alias is not a promise of a fixed snapshot or account entitlement; no alternate model is substituted on access failure. A later model pin is included in the immutable request manifest. Changing a deployed prompt/schema/grading definition under the same evaluator version fails its hash check; create a new version instead.

PROCESS_1 is an application evaluator rubric, not a modification to the trading strategy. It gives equal weight to the six legacy setup components other than EVIDENCE_CLARITY: STRONG 100, ADEQUATE 75, WEAK 40, INVALID 0. NOT_APPLICABLE is excluded. Any unknown criterion leaves the total UNRATED. Scores are rounded; A starts at 90, B 75, C 60, otherwise D. Evidenced rule violations cap an available total at 39. Evidence quality is displayed separately. These are qualitative compliance/process scores, **not calibrated win probabilities**.

Official references: [Astra model capabilities and pricing](https://developers.openai.com/api/docs/models/gpt-6-astra), [structured output format](https://developers.openai.com/api/docs/guides/structured-outputs), [image input formats](https://developers.openai.com/api/docs/guides/images-vision), [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control).

## Validation and remaining activation

- **172 automated tests pass across eight files**, retaining all original 122 tests. No paid API calls occur in this suite.
- TypeScript passes. Lint passes with zero errors/warnings; five existing style information messages remain. Production build passes.
- New tests cover file signatures/full decoding, upload-route authentication and Origin checks, tenant/Storage-policy isolation, proposal/strategy/prompt links, locks, multiple evaluations, terminal lifecycle, malformed/refused/incomplete/rate-limited responses, independent Deep Review passes, risk/AI separation, override history and interrupted-job recovery.
- Storage policies were exercised using the local PostgreSQL policy harness, not the hosted Storage HTTP service. Route tests mock Supabase; model tests mock Responses.
- **Live migrations: not applied in this phase.** Supabase browser control repeatedly timed out before reaching the SQL editor. A subsequent authenticated REST check returned PGRST205 for the new table, confirming installation is pending. The earlier three migrations remain the last verified hosted state.
- **Unpaid readiness checks pass:** existing-user sign-in; Journal and Analyze return HTTP 200; original locked plans remain visible beside an installation-pending notice; unauthenticated image requests return HTTP 401. See `AI_READINESS_VERIFICATION.json`. These are HTTP checks, not browser visual acceptance.
- **Live Astra smoke test: not run.** `OPENAI_API_KEY` and server-only `SUPABASE_SECRET_KEY` are not populated. No model access or paid output is claimed.
- **Manual acceptance: pending.** Browser screenshot/upload/analysis/lock/refresh/journal flow must be run after activation, using genuine chart screenshots for accuracy review. The added opt-in smoke test uses explicitly synthetic blank images and tests transport, conservative output and persistence; it does not validate ICT interpretation accuracy.

### Required local activation

1. In the Trading OS Supabase SQL editor, run the complete `docs/AI_INSTALL.sql`. Verify history includes 0004 and 0005 and `setup-screenshots` reports `public=false` and `file_size_limit=4194304`.
2. In ignored `.env.local`, populate `SUPABASE_SECRET_KEY` from that project's Settings → API Keys → existing secret key (`sb_secret_…`), and `OPENAI_API_KEY` from your OpenAI API project. The keys belong only in this local file; never paste them into chat or prefix them `NEXT_PUBLIC_`. The OpenAI account needs funded API access to the configured model.
3. Restart the local server, then complete the acceptance sequence below. The public Supabase URL and publishable key are already configured.

Optional configuration: `OPENAI_SETUP_MODEL=gpt-6-astra`, `OPENAI_SETUP_REASONING=high`, `OPENAI_SETUP_DEEP_REVIEW=true`. Public variables remain only the Supabase URL and publishable key. `.env.local` is excluded from Git.

### Manual acceptance sequence

Sign in at `http://127.0.0.1:3000/analyze`. Enter a EURUSD OB_FIRST_TOUCH proposal and run risk check. Select **Save proposal & add screenshots**. Upload actual H4/H1/M15/M5 screenshots, then select **Analyze setup**. Check observed/user-reported/inferred provenance, missing evidence, structured entry/target findings, the independent AI decision, process grade and evidence quality. Compare with the saved risk report. **Recheck & lock plan** only succeeds under the actual current risk/session rules. Refresh and open Journal; the images, evaluation, attached strategy and locked-plan link must remain. Record a skipped/taken decision and inspect its append-only history.

Also test: another user cannot read the image URL or start a review; removed images stay accessible in prior reviews; an invalid image is rejected; reanalysis adds a record; Deep Review partial failures preserve earlier passes without a final success; a hard risk block remains un-lockable even with AI approval. Use the real fixed UTC−5 session; do not bypass Dead Pool or daily reservations to make acceptance pass.

Optional paid transport check after activation: `pnpm test:ai-live --allow-paid`. It uses the existing ignored integration-test users, creates a synthetic proposal with four blank images, makes one NORMAL request, expects INSUFFICIENT_EVIDENCE and writes `docs/AI_LIVE_VERIFICATION.json`. It is deliberately separate from `pnpm test` and does not lock a plan.

## Cost and limitations

No actual cost per analysis has been measured. At the documented short-context rates of $10 per million input tokens and $50 per million output tokens, an illustrative NORMAL run with 20,000 input tokens (including images) and 8,000 output/reasoning tokens costs **about $0.60**. Two such independent passes plus a 30,000-input/8,000-output reconciliation cost **about $1.90**. Actual image, strategy, reasoning and result size can differ substantially; saved usage supports later calculation. These examples assume no cache discount, no long-context pricing and no retries. Consult the linked current model pricing for your account.

Execution is synchronous with persistent state. The host must allow the request duration; a terminated worker cannot be resumed in V1. Its 12-minute deadline is shown as failed on refresh and gets an append-only FAILED event when a later review starts. Re-running is explicit. No background worker, resumable pass continuation, semantic repair call or automatic paid retry exists.

Machine checks validate schema, source relationships and decision consistency; they cannot independently prove that every visual interpretation is true. Chart annotations, crops and missing history can remain ambiguous. OTE parameter-dependent approval remains unavailable when the attached version does not specify its parameters. Future strategy snapshots can be evaluated by their ID; the current deterministic locking engine supports ICT V1.0 and fails closed if asked to retarget an unsupported attached strategy.

TAKEN/SKIPPED are user reports, not execution or position lifecycle. Broker calls, automatic execution, TradingView, calendar APIs, market feeds, advanced analytics, coaching and experiments remain deferred. Vercel deployment and broad responsive/accessibility certification remain unverified.

## Activation update — 2026-09-06

Both server keys are populated and the new Supabase schema is available. A live password sign-in, immutable proposal save, four private H4/H1/M15/M5 screenshot uploads, and QUEUED → RUNNING → FAILED review persistence were verified. The initial upload origin mismatch was corrected to compare the browser Host while rejecting untrusted forwarded hosts; 174 tests and the production build pass.

Live Astra success remains blocked: the API returned HTTP 429, code `credit_balance_exhausted`, type `insufficient_quota`. No successful model output or final manual acceptance is claimed. The user must fund the OpenAI API organization associated with the configured key before another paid test. See `AI_LIVE_VERIFICATION.json`. Earlier activation-pending notes above describe the prior day.
