# Deterministic slice acceptance

Connected Supabase and local production-app acceptance completed on 2026-09-05. See PERSISTENCE_INTEGRATION_REVIEW.md and LIVE_VERIFICATION.json for exact evidence. This is not a hosted Vercel deployment claim.

## Short manual check

1. Open http://127.0.0.1:3000/journal. Use the first development login from ignored .local/integration-users.json if signed out, or create your own confirmed user in Supabase Authentication → Users.
2. Inspect the existing browser-test EURUSD LONG plan. Confirm ICT V1.0, Risk Plan V1.0, 0.50%, USD 50, 3R and APPROVED.
3. Open its record, refresh and confirm entry 1.10000, stop 1.09800 and target 1.10600.
4. Append a note. The new note appears after PLAN_LOCKED; original reasoning stays unchanged.
5. Sign out and try Journal: it must ask for sign-in. Sign back in and inspect the same record.
6. For a new proposal, use Analyze → enter parameters → Run risk check → Lock original plan. Editing a checked proposal requires another check. A 0.51% proposal must block under Risk Plan V1.0.
7. Respect actual fixed UTC−5 sessions and daily reservations. Two locks exhaust an account's day; there is no cancellation/release workflow yet.

## Automated verification

Run pnpm lint, pnpm typecheck, pnpm test and pnpm build. Latest result: 122 tests passed, lint passed, strict TypeScript passed, production build passed.

The local PostgreSQL harness runs migrations 0001, 0002 and 0003. It checks original session functions before fixing session classification in its isolated connection for repeatable locking tests. It never modifies the connected project clock.

pnpm test:live requires configured public environment values, two real users in .local/integration-users.json and the first user's existing browser-created account/plan. It uses only user-authenticated clients. Nine real acceptance groups passed, including simultaneous requests for the last daily slot. Use fresh test users/accounts for a complete clean rerun because records and reservations are intentionally immutable.

Future acceptance is needed for actual position lifecycle, Storage uploads, AI evaluation, external feeds, hosted deployment, broad responsive/accessibility coverage and long-duration session-expiry behavior. None is represented as implemented by this phase.

## Screenshot/Astra phase

The earlier results above describe the approved deterministic phase. The expanded suite now passes 172 tests. New AI live and manual acceptance remain pending; use [AI_PHASE_REVIEW.md](AI_PHASE_REVIEW.md) for prerequisites and the complete screenshot → analysis → lock → refresh → Journal sequence. No new live AI verification has been claimed.
