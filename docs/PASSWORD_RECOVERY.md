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

`requestPasswordRecovery` uses the existing writable Supabase SSR cookie adapter and `resetPasswordForEmail`. The SDK stores the PKCE verifier cookie. `/update-password` is reachable before authentication so it can establish the recovery session; it exposes no trading data. It removes callback values from the browser URL, then calls a server action to exchange a PKCE code or validate legacy dashboard recovery fragments with `setSession`. Supabase `getUser` verifies the resulting session before the password form is enabled.

The password submission independently calls `getUser`, then `updateUser({ password })` using the user's session. It does not use an administrative password-update API. It requests global sign-out, clears local auth cookies and redirects only to `/login?reason=password_updated`. Existing authenticated users may also use this page; possession of a URL alone does not authorize an update. Supabase may require a fresh recovery session under stricter project policies.

Server secrets never enter browser code. Passwords, codes, session tokens and provider error payloads are not logged or returned as diagnostics. Recovery responses are private/no-store; the callback uses `Referrer-Policy: no-referrer`. Invalid/expired callback input cannot fall back to an existing session. A later refresh without callback credentials still requires a valid authenticated session. No caller-controlled return URL is used. Existing trading authorization, RLS and AI-disabled behavior are unchanged.

PKCE recovery must finish in the browser/device that holds the verifier cookie. If a link is expired, used, from an older request or opened elsewhere, request a fresh one. [Supabase PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow)

## Verification scope

Local checks: 370 tests pass (325 existing plus 45 focused recovery/proxy checks), TypeScript passes, lint has no errors/warnings, and the production build passes. Live isolated-user acceptance covers recovery requests and PKCE verifier cookies, real Supabase recovery-session establishment, mismatch, password update, old-password rejection, new-password sign-in and signed-out route protection. Test credentials are rotated only for the existing isolated test user and kept in ignored local files.

The generated-link acceptance uses a real Supabase recovery token without relying on mailbox delivery. It does not claim that an email was delivered to the user's inbox or that a mailed PKCE link was clicked. Final hosted results and dashboard status are recorded in `PASSWORD_RECOVERY_VERIFICATION.json`. A personal inbox check should request one new email and follow it in the same browser; never paste a password or recovery link into chat.

AI remains `AI_ENABLED=false`; production requires no OpenAI key and no paid OpenAI calls are used.

## Files changed

- `src/app/login/page.tsx`: recovery link and password-updated confirmation.
- `src/app/forgot-password/page.tsx`, `src/app/update-password/page.tsx`: recovery pages.
- `src/app/password-actions.ts`: reset request, verified recovery session and authenticated password update.
- `src/components/password-recovery.tsx`, `src/lib/password-recovery.ts`: callback parsing, URL cleanup and form/session states.
- `src/proxy.ts`, `next.config.ts`: recovery entry access, private caching and callback referrer policy.
- `tests/password-recovery.test.ts`, `tests/audit-routes.test.ts`: focused recovery and protected-route tests.
- `docs/DEPLOYMENT.md`, `docs/PRODUCTION_DEPLOYMENT.md`, this guide and `docs/PASSWORD_RECOVERY_VERIFICATION.json`: operational instructions and recorded verification.

No application dependencies, database migrations, trading logic or AI settings changed. Ignored `.local/` helpers performed acceptance and retained test credentials; they were not deployed.
