export const RECOVERY_ORIGIN = "https://trading-os-six-brown.vercel.app";
export const RECOVERY_MESSAGE = "If an account can receive recovery email at that address, a reset link will arrive shortly. Check your spam folder. Open the newest link in this browser.";
export const INVALID_RECOVERY = "This recovery link is invalid or expired. Request a new link and open it in the same browser where you requested it.";

export function recoveryRedirect(origin: string | null, production = process.env.NODE_ENV === "production") {
  if (!production && origin) {
    try {
      const url = new URL(origin);
      if (url.origin === origin && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) return `${url.origin}/update-password`;
    } catch { /* Use the fixed production origin for untrusted input. */ }
  }
  return `${RECOVERY_ORIGIN}/update-password`;
}

export type RecoveryInput = { kind: "session" } | { kind: "code"; code: string } | { kind: "tokens"; access_token: string; refresh_token: string } | { kind: "invalid" };

// Read only recognized recovery parameters; never use a supplied redirect destination.
export function recoveryInput(search: string, hash: string): RecoveryInput {
  const query = new URLSearchParams(search), fragment = new URLSearchParams(hash.replace(/^#/, ""));
  if ([query, fragment].some(p => p.has("error") || p.has("error_code") || p.has("error_description"))) return { kind: "invalid" };
  if (query.has("code")) return query.get("code") ? { kind: "code", code: query.get("code") as string } : { kind: "invalid" };
  if (fragment.has("access_token") || fragment.has("refresh_token")) {
    const access_token = fragment.get("access_token"), refresh_token = fragment.get("refresh_token");
    return fragment.get("type") === "recovery" && access_token && refresh_token ? { kind: "tokens", access_token, refresh_token } : { kind: "invalid" };
  }
  if (query.has("token_hash") || query.has("token")) return { kind: "invalid" };
  return { kind: "session" };
}
