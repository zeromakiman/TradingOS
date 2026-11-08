export const RECOVERY_ORIGIN = "https://trading-os-six-brown.vercel.app";
export const RECOVERY_MESSAGE = "If an account can receive recovery email at that address, a reset link will arrive shortly. Check your spam folder. Open the newest link in this browser.";
export const INVALID_RECOVERY = "This recovery link is invalid or expired. Request a new link and open it in the same browser where you requested it.";
/** Links that carry session tokens in the address (`#access_token=…`, the implicit flow) are refused: see recoveryInput. */
export const UNSUPPORTED_RECOVERY_LINK = "Trading OS no longer accepts this kind of recovery link. Request a new link from Forgot password and open it in the same browser where you requested it.";
/**
 * /update-password while signed in with an ordinary session (or a recovery session older than RECOVERY_WINDOW_SECONDS).
 * Changing the password of a signed-in login needs the current password (docs/V2_ARCHITECTURE.md §14.11).
 */
export const RECOVERY_SESSION_REQUIRED = "This page sets a new password only right after you open a recovery link from your email. To change your password while signed in, use Settings → Security, where your current password is required.";
/** A password submission refused because the session is not a recent recovery session; nothing was changed. */
export const RECOVERY_SESSION_EXPIRED = "Your password was not changed. A new password can be set here only within 15 minutes of opening a recovery link. Request a new link, or use Settings → Security, where your current password is required.";

/** How long after opening a recovery link the person can set a new password on /update-password. */
export const RECOVERY_WINDOW_SECONDS = 15 * 60;
/** Tolerated difference between the auth server's clock and this server's. */
const CLOCK_SKEW_SECONDS = 5 * 60;

/** Result of checking the recovery link or session on /update-password; `signedIn`: an ordinary signed-in session. */
export type RecoveryState = { error?: string; success?: string; signedIn?: boolean };

export function recoveryRedirect(origin: string | null, production = process.env.NODE_ENV === "production") {
  if (!production && origin) {
    try {
      const url = new URL(origin);
      if (url.origin === origin && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) return `${url.origin}/update-password`;
    } catch { /* Use the fixed production origin for untrusted input. */ }
  }
  return `${RECOVERY_ORIGIN}/update-password`;
}

/**
 * `session`: no callback values, the browser's own session decides. `code`: a PKCE code, which only the browser holding
 * its verifier cookie can exchange. `invalid`: anything else; `tokenLink` marks a link that carries session tokens.
 */
export type RecoveryInput = { kind: "session" } | { kind: "code"; code: string } | { kind: "invalid"; tokenLink?: true };

/**
 * Reads only recognized recovery parameters; never uses a supplied redirect destination. Session tokens in the address
 * (`#access_token=…&refresh_token=…`) are never adopted: nothing ties them to this browser or to a recovery, so a link
 * carrying someone else's tokens would silently sign this browser into their login (session fixation). The app's own
 * Forgot password uses PKCE (`?code=`), which cannot be replayed in another browser.
 */
export function recoveryInput(search: string, hash: string): RecoveryInput {
  const query = new URLSearchParams(search), fragment = new URLSearchParams(hash.replace(/^#/, ""));
  if ([query, fragment].some(p => p.has("error") || p.has("error_code") || p.has("error_description"))) return { kind: "invalid" };
  if ([query, fragment].some(p => p.has("access_token") || p.has("refresh_token"))) return { kind: "invalid", tokenLink: true };
  if (query.has("code")) return query.get("code") ? { kind: "code", code: query.get("code") as string } : { kind: "invalid" };
  if (query.has("token_hash") || query.has("token")) return { kind: "invalid" };
  return { kind: "session" };
}

/**
 * Whether a session's `amr` claim (authentication methods) has a "recovery" entry from the last
 * RECOVERY_WINDOW_SECONDS. The auth server records it, with the time in seconds, when a recovery link's PKCE code starts
 * the session; an ordinary sign-in records "password". Entries without a time (the RFC 8176 string form some access
 * token hooks produce) never count.
 */
export function isRecentRecovery(amr: unknown, nowSeconds: number): boolean {
  if (!Array.isArray(amr)) return false;
  return amr.some(entry => {
    if (typeof entry !== "object" || entry === null) return false;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    return method === "recovery" && typeof timestamp === "number" && Number.isFinite(timestamp)
      && timestamp >= nowSeconds - RECOVERY_WINDOW_SECONDS && timestamp <= nowSeconds + CLOCK_SKEW_SECONDS;
  });
}
