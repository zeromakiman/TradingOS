# Password recovery

Production: https://trading-os-six-brown.vercel.app

Deployed release: `69f4d2bed477c76d4c21f861cbe5681f5bf5a363`, Vercel deployment `dpl_8Cxi2zNDGhSp2q6mNAna1R3XQN5U` (READY). The production recovery redirect below has already been added and verified; the existing Site URL and login redirect were preserved. Both local and hosted isolated-user recovery acceptance passed. Personal inbox delivery remains a user-side check.

From login, choose **Forgot password?** and enter the account email. The response is intentionally generic for eligible, unknown, rate-limited or undeliverable addresses. Use the newest recovery email and open it in the same browser where it was requested. On **Set a new password**, enter matching passwords (8–256 characters and any stronger Supabase project requirements). Success signs out the current browser and redirects to login with a confirmation message. Sign in using the new password.

## Supabase dashboard

In **Authentication → URL Configuration → Redirect URLs**, add exactly:

`https://trading-os-six-brown.vercel.app/update-password`

Preserve Site URL `https://trading-os-six-brown.vercel.app` and the existing redirect `https://trading-os-six-brown.vercel.app/login`. Keep public signup disabled. No wildcard is needed.

For local `next dev`, add only the origins you actually use, for example `http://127.0.0.1:3000/update-password` and/or `http://localhost:3000/update-password`. Development accepts loopback request origins only; production always uses the fixed production callback, regardless of request headers. A local production-mode build also deliberately requests the production callback.

Keep the **Reset password** email template's normal `{{ .ConfirmationURL }}` link. A template hard-coded to `/login` or `{{ .SiteURL }}` cannot complete recovery. Supabase's SMTP delivery restrictions and rate limits still apply. Existing emails addressed to the old login callback do not change retroactively: request a fresh link from `/forgot-password` after deployment/configuration.

## Session/security design

This section describes the V2 code (`src/app/password-actions.ts`, `src/lib/password-recovery.ts`, `src/components/password-recovery.tsx`).

`requestPasswordRecovery` uses the existing writable Supabase SSR cookie adapter and `resetPasswordForEmail`. The SDK stores the PKCE verifier cookie (HttpOnly, like every Supabase auth cookie the server writes: `src/lib/cookie-security.ts`). `/update-password` is reachable before authentication so it can establish the recovery session; it exposes no trading data. It removes every code, token and provider error detail from the browser URL on load and, once the Next.js router's own effect has run, tells the router the clean address (a deferred `history.replaceState(null, …)`, `startRecovery`) for every outcome, refused token and error links included, so neither a reload nor a later router update brings back a spent code, session tokens or error details; then it calls a server action:

- A PKCE link (`?code=`) is the only accepted link. The action exchanges the code; the code's sign-in keeps only All Accounts and the person's own account ids in the trading-account context cookies (`keepOwnAccountContext`).
- A link carrying session tokens (`#access_token=…&refresh_token=…`, in the fragment or the query) is never adopted: the page says "Trading OS no longer accepts this kind of recovery link…" and links to Forgot password, without contacting the server. `token_hash`/`token` links and error parameters are refused as invalid as well.
- The form is enabled only for a session that a recovery link started within the last 15 minutes: `getUser` validates the session first, then `getClaims` must show an `amr` entry `{method: "recovery"}` whose timestamp is from the last 15 minutes (`isRecentRecovery`).
- A signed-in visitor without such a session sees "Change your password in Settings", with a button to Settings → Security (which asks for the current password) and a Forgot password link.

The password submission checks the 15-minute recovery session again, because the action can be called directly: any other session gets "Your password was not changed…" and nothing is changed (no `updateUser`, no sign-out, no cookie cleanup). Otherwise it calls `updateUser({ password })` with the user's session, never an administrative password-update API, requests global sign-out, clears the local auth cookies and both trading-account context cookies (`tos_account`, `tos_last_account`), and redirects only to `/login?reason=password_updated`. Possession of a URL alone does not authorize an update.

Hosted assumption, to verify on the hosted project before release (verified against the local gateway only; a pre-deployment check in [DEPLOYMENT.md](DEPLOYMENT.md)): GoTrue's PKCE exchange of a recovery link issues `amr: [{method: "recovery", timestamp}]` (from the flow state's authentication method) and keeps it across refreshes; the local gateway does the same. A custom access-token hook that rewrites `amr` into strings would disable recovery.

Server secrets never enter browser code. Passwords, codes, session tokens and provider error payloads are not logged or returned as diagnostics. Recovery responses are private/no-store; the callback uses `Referrer-Policy: no-referrer`. Invalid/expired callback input cannot fall back to an existing session. A later refresh without callback credentials still requires a valid authenticated session. No caller-controlled return URL is used. Existing trading authorization, RLS and AI-disabled behavior are unchanged.

PKCE recovery must finish in the browser/device that holds the verifier cookie. If a link is expired, used, from an older request or opened elsewhere, request a fresh one. [Supabase PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow)

## Verification scope

V1 local checks (when this flow was released): 370 tests passed (325 existing plus 45 focused recovery/proxy checks), TypeScript passed, lint had no errors/warnings, and the production build passed. V2 covers the rules above in `tests/password-recovery.test.ts` (recovery window with a pinned clock, token links, ordinary and old sessions refused with nothing changed, context cookies cleared), `tests/v2-screen-auth.test.ts` (each page state), `tests/v2-supabase-server-cookies.test.ts` (HttpOnly/Secure session and PKCE verifier cookies through the real `@supabase/ssr`) and `tests/v2-proxy.test.ts`. Live isolated-user acceptance covers recovery requests and PKCE verifier cookies, real Supabase recovery-session establishment, mismatch, password update, old-password rejection, new-password sign-in and signed-out route protection. Test credentials are rotated only for the existing isolated test user and kept in ignored local files.

The generated-link acceptance uses a real Supabase recovery token without relying on mailbox delivery. It does not claim that an email was delivered to the user's inbox or that a mailed PKCE link was clicked. Final hosted results and dashboard status are recorded in `PASSWORD_RECOVERY_VERIFICATION.json`. A personal inbox check should request one new email and follow it in the same browser; never paste a password or recovery link into chat.

AI remains `AI_ENABLED=false`; production requires no OpenAI key and no paid OpenAI calls are used.

## Files changed

- `src/app/login/page.tsx`: recovery link and password-updated confirmation.
- `src/app/forgot-password/page.tsx`, `src/app/update-password/page.tsx`: recovery pages.
- `src/app/password-actions.ts`: reset request, verified recovery session and authenticated password update.
- `src/components/password-recovery.tsx`, `src/lib/password-recovery.ts`: callback parsing, URL cleanup and form/session states.
- `src/proxy.ts`, `next.config.ts`: recovery entry access, private caching and callback referrer policy.
- `tests/password-recovery.test.ts`, `tests/audit-routes.test.ts`: focused recovery and protected-route tests (V2 adds `tests/v2-screen-auth.test.ts`, `tests/v2-supabase-server-cookies.test.ts` and `tests/v2-proxy.test.ts`).
- `docs/DEPLOYMENT.md`, `docs/PRODUCTION_DEPLOYMENT.md`, this guide and `docs/PASSWORD_RECOVERY_VERIFICATION.json`: operational instructions and recorded verification.

No application dependencies, database migrations, trading logic or AI settings changed. Ignored `.local/` helpers performed acceptance and retained test credentials; they were not deployed.
