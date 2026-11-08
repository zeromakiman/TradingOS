// Minimal HS256 JWT helpers (Node crypto only). Used for API-role tokens, GoTrue-style sessions and
// signed storage URLs. Only HS256 is accepted, matching the PostgREST jwt-secret configuration.
import { createHmac, timingSafeEqual } from "node:crypto";

export class JwtError extends Error {
  constructor(message, reason = "invalid") { super(message); this.reason = reason; }
}
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = part => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const looksLikeJwt = value => typeof value === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);

export function signJwt(payload, secret) {
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

/** Verifies signature and expiry; returns the claims or throws JwtError. */
export function verifyJwt(token, secret, { allowExpired = false } = {}) {
  if (!looksLikeJwt(token)) throw new JwtError("token is malformed", "malformed");
  const [rawHeader, rawPayload, rawSignature] = token.split(".");
  let header, payload;
  try { header = decode(rawHeader); payload = decode(rawPayload); } catch { throw new JwtError("token is malformed", "malformed"); }
  if (header?.alg !== "HS256") throw new JwtError("signing method is not HS256", "algorithm");
  const expected = createHmac("sha256", secret).update(`${rawHeader}.${rawPayload}`).digest();
  const actual = Buffer.from(rawSignature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new JwtError("signature is invalid", "signature");
  if (!payload || typeof payload !== "object") throw new JwtError("token is malformed", "malformed");
  if (!allowExpired && typeof payload.exp === "number" && payload.exp <= nowSeconds()) throw new JwtError("token is expired", "expired");
  return payload;
}
