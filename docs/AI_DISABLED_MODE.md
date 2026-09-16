# AI-disabled application mode

Verified 2026-09-06. Live OpenAI use is paused. `AI_ENABLED=false` is set in the ignored local environment and in `.env.example`; absent or unrecognized flag values also disable AI. An existing API key does not enable it.

## Behavior

- The workspace says **AI analysis is currently disabled**, without an application error or billing requirement. Analyze and its mode selector are disabled; upload, risk, lock and human-decision controls remain available, including when historical reviews say RUNNING.
- An authenticated same-origin Analyze POST returns HTTP 200 with `{status:"DISABLED",message:"AI analysis is currently disabled"}`. It does not load evidence, write a new review, or call the provider. Authentication and CSRF checks still run.
- Orchestration and the provider independently enforce the switch, protecting against direct invocation and stale browser controls. The explicit paid smoke script also stops before any network activity when AI is off.
- `AI_ENABLED=true` with a missing/blank key or invalid model settings produces a configuration notice in the AI section and HTTP 503 from its endpoint. Other pages still render. Enabled valid settings retain the existing Astra integration.
- No schema, prompt, migration, screenshot or evaluation history was deleted or rewritten. AI history remains readable while new analysis is off.

## Configuration and dependencies

Normal use requires the Supabase public URL/publishable key and the installed database migrations. Validated screenshot uploads also require the server-only Supabase secret key and private Storage bucket. These are Supabase dependencies, not OpenAI dependencies.

`OPENAI_API_KEY` is optional for normal usage. The running verification server was explicitly started with this value empty and an invalid AI model name, proving that disabled AI settings do not prevent startup or page rendering. The saved local key, if present, remains private and ignored by Git; no key value was printed or copied into reports.

For a future explicitly authorized activation, set `AI_ENABLED=true`, provide a valid server-only `OPENAI_API_KEY`, keep valid Astra model settings and restart. No live OpenAI requests are authorized during current development. Automated provider tests use mocked transports; they do not spend credits.

## Results

- **189 tests passed across nine files**, preserving the prior 174 tests. Fifteen added cases cover default-off behavior, malformed flags, missing keys, bad AI settings, API authentication, direct orchestration/provider bypass attempts and non-AI UI controls.
- Lint, strict TypeScript and production build passed. Build and runtime were verified with an empty OpenAI key.
- **Ten real non-AI acceptance checks passed** against the configured Supabase project: sign-in; account/proposal/risk save; screenshot upload/private retrieval; anonymous denial; disabled direct Analyze with no review creation; current-risk lock; appended trade events/note/human decision; all implemented pages; unchanged failed-review history and readable old screenshots; sign-out/in and reload persistence.
- See `NON_AI_VERIFICATION.json`. Run `node scripts/verify-non-ai-live.mjs` for a deliberate repeat using the ignored integration users and synthetic demo records. It requires a real risk-eligible session for its lock assertion and never contacts OpenAI.
- OpenAI requests in this development/acceptance run: **zero**.

All implemented non-AI features work without an OpenAI key. Analytics/Edge is still an unimplemented feature, as it was before this change; the disabled sidebar item is not an AI dependency. Broker execution, full position lifecycle and advanced analytics were not added by this configuration change. Browser visual certification is separate from the HTTP and server-rendered UI checks above.

## Changed files

- `src/ai/availability.ts`: central safe availability state and execution guard.
- `src/ai/provider.ts`, `src/lib/setup-analysis.ts`, `src/app/api/setups/[id]/analyze/route.ts`: independent no-request gates.
- `src/app/analyze/[id]/page.tsx`, `src/components/setup-controls.tsx`: nonfatal availability display and independent non-AI controls.
- `.env.example`, ignored `.env.local`: explicit default-off configuration.
- `scripts/verify-ai-live.mjs`: feature/key preflight before all network activity.
- `scripts/verify-non-ai-live.mjs`: OpenAI-free Supabase/application acceptance.
- `tests/ai-disabled.test.ts`, `tests/setup-ai.test.ts`: disabled-state coverage and explicit enablement for mocked provider tests.
- `README.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/AI_PHASE_REVIEW.md`, this guide and `docs/NON_AI_VERIFICATION.json`: current behavior and evidence.
