// /auth/v1/* - a minimal GoTrue (Supabase Auth) emulation for LOCAL synthetic users.
// Implements the endpoints used by @supabase/supabase-js / @supabase/ssr in this app and its scripts:
// password + refresh_token + pkce grants, /user (GET/PUT), /logout, /recover (+ /verify), /settings,
// and the service-role admin API for users. Sessions and refresh tokens persist in Postgres (auth.*).
// Recovery "emails" are never sent; links are appended to .local/logs/auth-mail.jsonl and the log.
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError, iso, readJson, redirect, sendJson } from "./http.mjs";
import { JwtError, looksLikeJwt, nowSeconds, signJwt, verifyJwt } from "./jwt.mjs";

const scrypt = promisify(scryptCallback);
const API_VERSION = { "X-Supabase-Api-Version": "2024-01-01" };
const ACCESS_TOKEN_TTL = 3600; // GOTRUE_JWT_EXP default
const REFRESH_REUSE_INTERVAL_MS = 10_000; // GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL default
const RECOVERY_LINK_TTL_MS = 3_600_000; // GOTRUE_MAILER_OTP_EXP default
const AUTH_CODE_TTL_MS = 300_000; // PKCE auth codes are short-lived
const EMAIL_MIN_INTERVAL_MS = 60_000; // GOTRUE_SMTP_MAX_FREQUENCY default (1 email/minute/user)
const PASSWORD_MIN_LENGTH = 6; // GoTrue default minimum
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const authError = (status, code, message, extra = {}) => new HttpError(status, { code, error_code: code, msg: message, message, ...extra }, API_VERSION);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const newRefreshToken = () => randomBytes(24).toString("base64url");

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return `$scrypt$n=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
async function verifyPassword(password, stored) {
  const match = /^\$scrypt\$n=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored ?? "");
  if (!match || typeof password !== "string") {
    await scrypt("timing-equalizer", "salt", SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }); // unknown users cost the same
    return false;
  }
  const expected = Buffer.from(match[5], "base64url");
  const key = await scrypt(password, Buffer.from(match[4], "base64url"), expected.length, { N: Number(match[1]), r: Number(match[2]), p: Number(match[3]), maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(key, expected);
}

/** Parses a Go-style duration (e.g. "24h", "1h30m", "876000h"). */
function parseDuration(value) {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(value ?? ""));
  if (!match || !value) return null;
  return ((Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0)) * 1000;
}

export function createAuth({ pool, tx, stack, gatewayUrl, siteUrl, mailFile, logger }) {
  const issuer = `${gatewayUrl}/auth/v1`;

  // -------------------------------------------------------------------------------------------
  // Serialization (GoTrue response shapes expected by auth-js)
  // -------------------------------------------------------------------------------------------
  const identityJson = i => ({
    identity_id: i.id, id: i.provider_id, user_id: i.user_id, identity_data: i.identity_data, provider: i.provider,
    last_sign_in_at: iso(i.last_sign_in_at), created_at: iso(i.created_at), updated_at: iso(i.updated_at), email: i.email ?? undefined,
  });
  const userJson = (u, identities = []) => ({
    id: u.id, aud: u.aud ?? "authenticated", role: u.role ?? "authenticated", email: u.email ?? "",
    email_confirmed_at: iso(u.email_confirmed_at), phone: u.phone ?? "", confirmed_at: iso(u.confirmed_at),
    recovery_sent_at: iso(u.recovery_sent_at), last_sign_in_at: iso(u.last_sign_in_at),
    app_metadata: u.raw_app_meta_data ?? {}, user_metadata: u.raw_user_meta_data ?? {},
    identities: identities.map(identityJson), created_at: iso(u.created_at), updated_at: iso(u.updated_at),
    banned_until: iso(u.banned_until), is_anonymous: Boolean(u.is_anonymous),
  });
  async function loadUser(db, where, value, { lock = false } = {}) {
    const { rows } = await db.query(`select * from auth.users where ${where} = $1 and deleted_at is null${lock ? " for update" : ""}`, [value]);
    return rows[0] ?? null;
  }
  async function identities(db, userId) {
    return (await db.query("select * from auth.identities where user_id = $1 order by created_at", [userId])).rows;
  }
  function sessionResponse(user, ids, session, refreshToken) {
    const iat = nowSeconds(), exp = iat + ACCESS_TOKEN_TTL;
    const claims = {
      aud: "authenticated", exp, iat, iss: issuer, sub: user.id, email: user.email ?? "", phone: user.phone ?? "",
      app_metadata: user.raw_app_meta_data ?? {}, user_metadata: user.raw_user_meta_data ?? {}, role: user.role ?? "authenticated",
      aal: session.aal ?? "aal1", amr: session.amr ?? [], session_id: session.id, is_anonymous: Boolean(user.is_anonymous),
    };
    return { access_token: signJwt(claims, stack.jwtSecret), token_type: "bearer", expires_in: ACCESS_TOKEN_TTL, expires_at: exp, refresh_token: refreshToken, user: userJson(user, ids) };
  }
  async function createSession(db, user, method, req) {
    const session = { id: randomUUID(), aal: "aal1", amr: [{ method, timestamp: nowSeconds() }] };
    await db.query(
      "insert into auth.sessions(id, user_id, aal, amr, user_agent, ip, refreshed_at) values ($1, $2, $3, $4, $5, $6, now())",
      [session.id, user.id, session.aal, JSON.stringify(session.amr), String(req.headers["user-agent"] ?? "").slice(0, 500), req.socket.remoteAddress ?? null],
    );
    const refreshToken = newRefreshToken();
    await db.query("insert into auth.refresh_tokens(token, user_id, session_id) values ($1, $2, $3)", [refreshToken, user.id, session.id]);
    await db.query("update auth.users set last_sign_in_at = now(), updated_at = now() where id = $1", [user.id]);
    await db.query("update auth.identities set last_sign_in_at = now() where user_id = $1", [user.id]);
    const fresh = await loadUser(db, "id", user.id);
    return sessionResponse(fresh, await identities(db, user.id), session, refreshToken);
  }
  function allowedRedirect(value) {
    if (!value) return null;
    try {
      const url = new URL(value);
      if (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)) return value;
    } catch { /* fall through to the site URL like GoTrue */ }
    return null;
  }
  function writeMail(entry) {
    fs.mkdirSync(path.dirname(mailFile), { recursive: true });
    fs.appendFileSync(mailFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    logger(`[auth-mail] ${entry.type} link for ${entry.to}: ${entry.link}`);
  }

  // -------------------------------------------------------------------------------------------
  // Caller identity
  // -------------------------------------------------------------------------------------------
  function bearerClaims(creds) {
    if (!creds.bearer || !looksLikeJwt(creds.bearer)) throw authError(401, "no_authorization", "This endpoint requires a valid Bearer token");
    try { return verifyJwt(creds.bearer, stack.jwtSecret); } catch (error) {
      const detail = error instanceof JwtError ? error.message : "invalid token";
      throw authError(403, "bad_jwt", `invalid JWT: unable to parse or verify signature, ${detail}`);
    }
  }
  async function requireUser(db, creds) {
    const claims = bearerClaims(creds);
    if (!UUID_RE.test(String(claims.sub ?? ""))) throw authError(403, "bad_jwt", "invalid claim: missing sub claim");
    if (claims.session_id !== undefined && !UUID_RE.test(String(claims.session_id))) throw authError(403, "bad_jwt", "invalid claim: session_id claim must be a UUID");
    if (claims.session_id) {
      const { rows } = await db.query("select * from auth.sessions where id = $1 and user_id = $2", [claims.session_id, claims.sub]);
      if (!rows[0]) throw authError(403, "session_not_found", "Session from session_id claim in JWT does not exist");
    }
    const user = await loadUser(db, "id", claims.sub);
    if (!user) throw authError(403, "user_not_found", "User from sub claim in JWT does not exist");
    return { claims, user };
  }
  function requireAdmin(creds) {
    const claims = bearerClaims(creds);
    if (claims.role !== "service_role" && claims.role !== "supabase_admin") throw authError(403, "not_admin", "User not allowed");
    return claims;
  }

  // -------------------------------------------------------------------------------------------
  // Grants
  // -------------------------------------------------------------------------------------------
  async function passwordGrant(req, body) {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email && body.phone) throw authError(400, "phone_provider_disabled", "Phone logins are disabled");
    if (!email || typeof body.password !== "string") throw authError(400, "validation_failed", "missing email or phone");
    const user = await loadUser(pool, "email", email);
    const valid = await verifyPassword(body.password, user?.encrypted_password);
    if (!user || !valid) throw authError(400, "invalid_credentials", "Invalid login credentials");
    if (user.banned_until && new Date(user.banned_until) > new Date()) throw authError(400, "user_banned", "User is banned");
    if (!user.email_confirmed_at) throw authError(400, "email_not_confirmed", "Email not confirmed");
    return tx(db => createSession(db, user, "password", req));
  }

  async function refreshGrant(body) {
    if (typeof body.refresh_token !== "string" || !body.refresh_token) throw authError(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
    return tx(async db => {
      const { rows: [token] } = await db.query("select * from auth.refresh_tokens where token = $1 for update", [body.refresh_token]);
      if (!token) throw authError(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
      const { rows: [session] } = await db.query("select * from auth.sessions where id = $1 for update", [token.session_id]);
      if (!session) throw authError(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
      if (session.not_after && new Date(session.not_after) < new Date()) throw authError(400, "session_expired", "Invalid Refresh Token: Session Expired");
      const user = await loadUser(db, "id", session.user_id);
      if (!user) throw authError(400, "user_not_found", "Invalid Refresh Token: User Not Found");
      if (user.banned_until && new Date(user.banned_until) > new Date()) throw authError(400, "user_banned", "User is banned");
      let issued;
      if (token.revoked) {
        // GoTrue tolerates replay of a just-rotated token (concurrent refreshes) within the reuse
        // interval by returning the session's current token; later replay revokes the session family.
        if (Date.now() - new Date(token.updated_at).getTime() > REFRESH_REUSE_INTERVAL_MS) {
          await db.query("update auth.refresh_tokens set revoked = true, updated_at = now() where session_id = $1 and not revoked", [session.id]);
          throw authError(400, "refresh_token_already_used", "Invalid Refresh Token: Already Used");
        }
        const { rows: [active] } = await db.query("select token from auth.refresh_tokens where session_id = $1 and not revoked order by id desc limit 1", [session.id]);
        if (!active) throw authError(400, "refresh_token_already_used", "Invalid Refresh Token: Already Used");
        issued = active.token;
      } else {
        issued = newRefreshToken();
        await db.query("update auth.refresh_tokens set revoked = true, updated_at = now() where id = $1", [token.id]);
        await db.query("insert into auth.refresh_tokens(token, user_id, session_id, parent) values ($1, $2, $3, $4)", [issued, user.id, session.id, token.token]);
      }
      await db.query("update auth.sessions set refreshed_at = now(), updated_at = now() where id = $1", [session.id]);
      return sessionResponse(user, await identities(db, user.id), session, issued);
    });
  }

  async function pkceGrant(req, body) {
    if (typeof body.auth_code !== "string" || typeof body.code_verifier !== "string" || !body.code_verifier) {
      throw authError(400, "validation_failed", "invalid request: both auth code and code verifier should be non-empty");
    }
    return tx(async db => {
      const { rows: [flow] } = await db.query("select * from auth.flow_state where auth_code = $1 for update", [body.auth_code]);
      if (!flow?.auth_code_issued_at || !flow.user_id) throw authError(404, "flow_state_not_found", "invalid flow state, no valid flow state found");
      if (Date.now() - new Date(flow.auth_code_issued_at).getTime() > AUTH_CODE_TTL_MS) {
        await db.query("delete from auth.flow_state where id = $1", [flow.id]);
        throw authError(400, "flow_state_expired", "invalid flow state, flow state has expired");
      }
      const challenge = flow.code_challenge_method === "s256" ? createHash("sha256").update(body.code_verifier).digest("base64url") : body.code_verifier;
      const a = Buffer.from(challenge), b = Buffer.from(flow.code_challenge);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw authError(400, "bad_code_verifier", "code challenge does not match previously saved code verifier");
      await db.query("delete from auth.flow_state where id = $1", [flow.id]);
      const user = await loadUser(db, "id", flow.user_id);
      if (!user) throw authError(404, "user_not_found", "User not found");
      return createSession(db, user, flow.authentication_method === "recovery" ? "recovery" : "otp", req);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Recovery (no email is sent: the link is written to the local mailbox file and the log)
  // -------------------------------------------------------------------------------------------
  async function issueRecovery(db, user, { redirectTo, codeChallenge, codeChallengeMethod, enforceInterval }) {
    if (enforceInterval && user.recovery_sent_at && Date.now() - new Date(user.recovery_sent_at).getTime() < EMAIL_MIN_INTERVAL_MS) {
      const wait = Math.ceil((EMAIL_MIN_INTERVAL_MS - (Date.now() - new Date(user.recovery_sent_at).getTime())) / 1000);
      throw authError(429, "over_email_send_rate_limit", `For security purposes, you can only request this after ${wait} seconds.`);
    }
    let flowStateId = null;
    if (codeChallenge) {
      const method = String(codeChallengeMethod ?? "").toLowerCase();
      if (!["s256", "plain"].includes(method)) throw authError(400, "validation_failed", "code challenge method not supported");
      flowStateId = randomUUID();
      await db.query(
        "insert into auth.flow_state(id, user_id, auth_code, code_challenge_method, code_challenge, provider_type, authentication_method) values ($1, $2, $3, $4, $5, 'recovery', 'recovery')",
        [flowStateId, user.id, randomUUID(), method, codeChallenge],
      );
    }
    const linkToken = randomBytes(32).toString("hex");
    await db.query("delete from auth.one_time_tokens where user_id = $1 and token_type = 'recovery_token'", [user.id]);
    await db.query(
      "insert into auth.one_time_tokens(user_id, token_type, token_hash, relates_to, flow_state_id, redirect_to) values ($1, 'recovery_token', $2, $3, $4, $5)",
      [user.id, sha256(linkToken), user.email, flowStateId, redirectTo],
    );
    await db.query("update auth.users set recovery_token = $2, recovery_sent_at = now(), updated_at = now() where id = $1", [user.id, sha256(linkToken)]);
    const link = `${issuer}/verify?token=${linkToken}&type=recovery&redirect_to=${encodeURIComponent(redirectTo)}`;
    return { link, linkToken };
  }

  async function recover(url, body) {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email)) throw authError(400, "validation_failed", "Unable to validate email address: invalid format");
    const redirectTo = allowedRedirect(url.searchParams.get("redirect_to")) ?? siteUrl;
    await tx(async db => {
      const user = await loadUser(db, "email", email, { lock: true });
      if (!user) return; // Same response for unknown addresses (no account enumeration).
      const { link } = await issueRecovery(db, user, { redirectTo, codeChallenge: body.code_challenge, codeChallengeMethod: body.code_challenge_method, enforceInterval: true });
      writeMail({ to: user.email, type: "recovery", link, redirect_to: redirectTo, pkce: Boolean(body.code_challenge) });
    });
    return {};
  }

  async function consumeRecoveryToken(db, rawToken) {
    if (typeof rawToken !== "string" || !rawToken) return null;
    const { rows: [row] } = await db.query("select * from auth.one_time_tokens where token_hash = $1 and token_type = 'recovery_token' for update", [sha256(rawToken)]);
    if (!row) return null;
    await db.query("delete from auth.one_time_tokens where id = $1", [row.id]);
    if (Date.now() - new Date(row.created_at).getTime() > RECOVERY_LINK_TTL_MS) return null;
    const user = await loadUser(db, "id", row.user_id, { lock: true });
    if (!user) return null;
    // Following a recovery link proves control of the mailbox, so GoTrue confirms the address.
    await db.query("update auth.users set recovery_token = null, email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = $1", [user.id]);
    return { row, user };
  }

  async function verifyLink(req, res, url) {
    const type = url.searchParams.get("type");
    const fallback = allowedRedirect(url.searchParams.get("redirect_to")) ?? siteUrl;
    const fail = (target, code, description, pkce) => {
      const params = new URLSearchParams({ error: "access_denied", error_code: code, error_description: description });
      const target2 = new URL(target);
      if (pkce) for (const [k, v] of params) target2.searchParams.set(k, v);
      target2.hash = params.toString();
      redirect(res, target2.toString());
    };
    if (type !== "recovery") return fail(fallback, "otp_disabled", "Only recovery links are supported by the local stack", false);
    const outcome = await tx(async db => {
      const consumed = await consumeRecoveryToken(db, url.searchParams.get("token"));
      if (!consumed) return null;
      const target = allowedRedirect(url.searchParams.get("redirect_to")) ?? consumed.row.redirect_to ?? siteUrl;
      if (consumed.row.flow_state_id) {
        const { rows: [flow] } = await db.query("update auth.flow_state set auth_code_issued_at = now(), updated_at = now() where id = $1 returning auth_code", [consumed.row.flow_state_id]);
        if (flow) {
          const location = new URL(target);
          location.searchParams.set("code", flow.auth_code);
          return location.toString();
        }
      }
      const session = await createSession(db, consumed.user, "recovery", req);
      const fragment = new URLSearchParams({ access_token: session.access_token, expires_at: String(session.expires_at), expires_in: String(session.expires_in), refresh_token: session.refresh_token, token_type: "bearer", type: "recovery" });
      return `${target.split("#")[0]}#${fragment}`;
    });
    if (!outcome) return fail(fallback, "otp_expired", "Email link is invalid or has expired", true);
    redirect(res, outcome);
  }

  async function verifyOtp(req, body) {
    // verifyOtp({ type: "recovery", token_hash }) - the local "token_hash" is the token from the link.
    if (body.type !== "recovery") throw authError(400, "otp_disabled", "Only recovery verification is supported by the local stack");
    return tx(async db => {
      const consumed = await consumeRecoveryToken(db, body.token_hash ?? body.token);
      if (!consumed) throw authError(403, "otp_expired", "Email link is invalid or has expired");
      return createSession(db, consumed.user, "recovery", req);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Current user
  // -------------------------------------------------------------------------------------------
  async function getUser(creds) {
    const { user } = await requireUser(pool, creds);
    return userJson(user, await identities(pool, user.id));
  }
  async function updateUser(creds, body) {
    return tx(async db => {
      const { claims, user } = await requireUser(db, creds);
      if (typeof body.email === "string" && body.email.trim().toLowerCase() !== (user.email ?? "")) {
        throw authError(501, "not_implemented", "Email changes are not supported by the local stack");
      }
      if (body.password !== undefined) {
        if (typeof body.password !== "string" || body.password.length < PASSWORD_MIN_LENGTH) {
          throw authError(422, "weak_password", `Password should be at least ${PASSWORD_MIN_LENGTH} characters.`, { weak_password: { reasons: ["length"] } });
        }
        if (await verifyPassword(body.password, user.encrypted_password)) throw authError(422, "same_password", "New password should be different from the old password.");
        await db.query("update auth.users set encrypted_password = $2, updated_at = now() where id = $1", [user.id, await hashPassword(body.password)]);
        // GoTrue keeps the current session and revokes every other session of the user.
        await db.query("delete from auth.sessions where user_id = $1 and id is distinct from $2", [user.id, claims.session_id ?? null]);
      }
      if (body.data && typeof body.data === "object") {
        await db.query("update auth.users set raw_user_meta_data = raw_user_meta_data || $2::jsonb, updated_at = now() where id = $1", [user.id, JSON.stringify(body.data)]);
      }
      const fresh = await loadUser(db, "id", user.id);
      return userJson(fresh, await identities(db, user.id));
    });
  }
  async function logout(creds, url) {
    let claims;
    try { claims = bearerClaims(creds); } catch { return; } // auth-js ignores 401/403/404 here anyway
    if (!UUID_RE.test(String(claims.sub ?? "")) || (claims.session_id !== undefined && !UUID_RE.test(String(claims.session_id)))) return;
    const scope = url.searchParams.get("scope") ?? "global";
    if (scope === "local") await pool.query("delete from auth.sessions where id = $1", [claims.session_id ?? null]);
    else if (scope === "others") await pool.query("delete from auth.sessions where user_id = $1 and id is distinct from $2", [claims.sub, claims.session_id ?? null]);
    else await pool.query("delete from auth.sessions where user_id = $1", [claims.sub]);
  }

  // -------------------------------------------------------------------------------------------
  // Admin API (service role only)
  // -------------------------------------------------------------------------------------------
  async function adminCreateUser(body) {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) throw authError(400, "validation_failed", body.phone ? "Phone signups are disabled in the local stack" : "Unable to validate email address: invalid format");
    if (!EMAIL_RE.test(email) || email.length > 255) throw authError(400, "validation_failed", "Unable to validate email address: invalid format");
    if (body.password !== undefined && (typeof body.password !== "string" || body.password.length < PASSWORD_MIN_LENGTH)) {
      throw authError(422, "weak_password", `Password should be at least ${PASSWORD_MIN_LENGTH} characters.`, { weak_password: { reasons: ["length"] } });
    }
    const id = typeof body.id === "string" && UUID_RE.test(body.id) ? body.id : randomUUID();
    const appMetadata = { provider: "email", providers: ["email"], ...(body.app_metadata && typeof body.app_metadata === "object" ? body.app_metadata : {}) };
    const userMetadata = body.user_metadata && typeof body.user_metadata === "object" ? body.user_metadata : {};
    const banMs = body.ban_duration && body.ban_duration !== "none" ? parseDuration(body.ban_duration) : null;
    const encrypted = typeof body.password === "string" ? await hashPassword(body.password) : "";
    return tx(async db => {
      if (await loadUser(db, "email", email)) throw authError(422, "email_exists", "A user with this email address has already been registered");
      await db.query(
        `insert into auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, banned_until)
         values ($1, 'authenticated', $2, $3, $4, case when $5 then now() end, $6, $7, case when $8::bigint is null then null else now() + ($8::bigint * interval '1 millisecond') end)`,
        [id, typeof body.role === "string" && body.role ? body.role : "authenticated", email, encrypted, Boolean(body.email_confirm), JSON.stringify(appMetadata), JSON.stringify(userMetadata), banMs],
      );
      await db.query(
        "insert into auth.identities(provider_id, user_id, identity_data, provider) values ($1, $2, $3, 'email')",
        [id, id, JSON.stringify({ sub: id, email, email_verified: Boolean(body.email_confirm), phone_verified: false })],
      );
      const user = await loadUser(db, "id", id);
      return userJson(user, await identities(db, id));
    });
  }
  async function adminListUsers(url, res) {
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
    const perPage = Math.min(1000, Math.max(1, Number.parseInt(url.searchParams.get("per_page") ?? "50", 10) || 50));
    const total = Number((await pool.query("select count(*) from auth.users where deleted_at is null")).rows[0].count);
    const { rows } = await pool.query("select * from auth.users where deleted_at is null order by created_at desc, id limit $1 offset $2", [perPage, (page - 1) * perPage]);
    const users = [];
    for (const user of rows) users.push(userJson(user, await identities(pool, user.id)));
    const last = Math.max(1, Math.ceil(total / perPage)), links = [];
    if (page < last) links.push(`</admin/users?page=${page + 1}&per_page=${perPage}>; rel="next"`);
    links.push(`</admin/users?page=${last}&per_page=${perPage}>; rel="last"`);
    sendJson(res, 200, { users, aud: "authenticated" }, { ...API_VERSION, "X-Total-Count": String(total), Link: links.join(", ") });
  }
  async function adminGetUser(id) {
    const user = await loadUser(pool, "id", id);
    if (!user) throw authError(404, "user_not_found", "User not found");
    return userJson(user, await identities(pool, id));
  }
  async function adminUpdateUser(id, body) {
    return tx(async db => {
      const user = await loadUser(db, "id", id, { lock: true });
      if (!user) throw authError(404, "user_not_found", "User not found");
      if (typeof body.email === "string" && body.email.trim().toLowerCase() !== user.email) {
        const email = body.email.trim().toLowerCase();
        if (!EMAIL_RE.test(email)) throw authError(400, "validation_failed", "Unable to validate email address: invalid format");
        if (await loadUser(db, "email", email)) throw authError(422, "email_exists", "A user with this email address has already been registered");
        await db.query("update auth.users set email = $2 where id = $1", [id, email]);
        await db.query("update auth.identities set identity_data = identity_data || jsonb_build_object('email', $2::text) where user_id = $1 and provider = 'email'", [id, email]);
      }
      if (body.password !== undefined) {
        if (typeof body.password !== "string" || body.password.length < PASSWORD_MIN_LENGTH) {
          throw authError(422, "weak_password", `Password should be at least ${PASSWORD_MIN_LENGTH} characters.`, { weak_password: { reasons: ["length"] } });
        }
        await db.query("update auth.users set encrypted_password = $2 where id = $1", [id, await hashPassword(body.password)]);
      }
      if (body.email_confirm === true) await db.query("update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1", [id]);
      if (body.email_confirm === false) await db.query("update auth.users set email_confirmed_at = null where id = $1", [id]);
      if (body.user_metadata && typeof body.user_metadata === "object") await db.query("update auth.users set raw_user_meta_data = raw_user_meta_data || $2::jsonb where id = $1", [id, JSON.stringify(body.user_metadata)]);
      if (body.app_metadata && typeof body.app_metadata === "object") await db.query("update auth.users set raw_app_meta_data = raw_app_meta_data || $2::jsonb where id = $1", [id, JSON.stringify(body.app_metadata)]);
      if (typeof body.role === "string" && body.role) await db.query("update auth.users set role = $2 where id = $1", [id, body.role]);
      if (body.ban_duration !== undefined) {
        if (body.ban_duration === "none") await db.query("update auth.users set banned_until = null where id = $1", [id]);
        else {
          const ms = parseDuration(body.ban_duration);
          if (ms === null) throw authError(400, "validation_failed", "invalid format for ban duration");
          await db.query("update auth.users set banned_until = now() + ($2::bigint * interval '1 millisecond') where id = $1", [id, ms]);
          await db.query("delete from auth.sessions where user_id = $1", [id]);
        }
      }
      await db.query("update auth.users set updated_at = now() where id = $1", [id]);
      const fresh = await loadUser(db, "id", id);
      return userJson(fresh, await identities(db, id));
    });
  }
  async function adminDeleteUser(id, body) {
    const existing = await loadUser(pool, "id", id);
    if (!existing) throw authError(404, "user_not_found", "User not found");
    try {
      await tx(async db => {
        if (body.should_soft_delete === true) {
          await db.query("delete from auth.sessions where user_id = $1", [id]);
          await db.query("delete from auth.identities where user_id = $1", [id]);
          await db.query("update auth.users set deleted_at = now(), email = null, phone = null, encrypted_password = '', updated_at = now() where id = $1", [id]);
        } else {
          // Real foreign keys from public tables (no cascade) make this fail exactly like hosted GoTrue.
          await db.query("delete from auth.users where id = $1", [id]);
        }
      });
    } catch (error) {
      if (error.code === "23503") {
        logger(`[auth] delete user ${id} rejected by foreign key ${error.constraint ?? ""} on ${error.table ?? "?"}`);
        throw authError(500, "unexpected_failure", "Database error deleting user");
      }
      throw error;
    }
    return {};
  }
  async function adminGenerateLink(body) {
    if (body.type !== "recovery") throw authError(422, "validation_failed", "Only type=recovery links are supported by the local stack");
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const redirectTo = allowedRedirect(body.redirect_to ?? body.options?.redirect_to ?? body.options?.redirectTo) ?? siteUrl;
    return tx(async db => {
      const user = await loadUser(db, "email", email, { lock: true });
      if (!user) throw authError(404, "user_not_found", "User with this email not found");
      const { link, linkToken } = await issueRecovery(db, user, { redirectTo, enforceInterval: false });
      const fresh = await loadUser(db, "id", user.id);
      return { ...userJson(fresh, await identities(db, user.id)), action_link: link, email_otp: "", hashed_token: linkToken, redirect_to: redirectTo, verification_type: "recovery" };
    });
  }
  function mailbox(url) {
    const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
    let lines = [];
    try { lines = fs.readFileSync(mailFile, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); } catch { /* empty */ }
    return { messages: lines.filter(m => !email || m.to === email).slice(-20) };
  }

  // -------------------------------------------------------------------------------------------
  // Router
  // -------------------------------------------------------------------------------------------
  const OPEN_ROUTES = new Set(["GET /verify", "GET /health", "GET /.well-known/jwks.json", "GET /authorize", "GET /callback"]);
  return async function handleAuth(req, res, url, creds) {
    const route = url.pathname.slice("/auth/v1".length) || "/";
    const key = `${req.method} ${route}`;
    if (!OPEN_ROUTES.has(key)) {
      if (!creds.apikey) throw new HttpError(401, { message: "No API key found in request", hint: "No `apikey` request header or url param was found." });
      if (!creds.keyRole) throw new HttpError(401, { message: "Invalid API key", hint: "Double check your Supabase `anon` or `service_role` API key." });
    }
    const json = (status, body) => sendJson(res, status, body, API_VERSION);
    if (key === "GET /health") return json(200, { version: "local-stack", name: "GoTrue", description: "Local GoTrue-compatible emulation (synthetic users only)" });
    if (key === "GET /settings") {
      return json(200, { external: { email: true, phone: false, anonymous_users: false }, disable_signup: true, mailer_autoconfirm: false, phone_autoconfirm: false, sms_provider: "", saml_enabled: false, password_min_length: PASSWORD_MIN_LENGTH });
    }
    if (key === "GET /.well-known/jwks.json") return json(200, { keys: [] }); // HS256 secret: auth-js verifies via GET /user
    if (key === "GET /verify") return verifyLink(req, res, url);
    if (key === "GET /authorize" || key === "GET /callback") throw authError(400, "provider_disabled", "OAuth providers are not available in the local stack");
    if (key === "POST /signup") throw authError(422, "signup_disabled", "Signups not allowed for this instance");
    if (key === "POST /token") {
      const body = await readJson(req);
      const grant = url.searchParams.get("grant_type");
      if (grant === "password") return json(200, await passwordGrant(req, body));
      if (grant === "refresh_token") return json(200, await refreshGrant(body));
      if (grant === "pkce") return json(200, await pkceGrant(req, body));
      throw authError(400, "validation_failed", `unsupported_grant_type: ${grant ?? "missing"}`);
    }
    if (key === "GET /user") return json(200, await getUser(creds));
    if (key === "PUT /user") return json(200, await updateUser(creds, await readJson(req)));
    if (key === "POST /logout") { await logout(creds, url); res.writeHead(204, API_VERSION); return res.end(); }
    if (key === "POST /recover") return json(200, await recover(url, await readJson(req)));
    if (key === "POST /verify") return json(200, await verifyOtp(req, await readJson(req)));
    if (key === "POST /otp" || key === "POST /magiclink" || key === "POST /resend") throw authError(501, "not_implemented", "Email OTP and magic links are not supported by the local stack");

    if (route.startsWith("/admin/") || route === "/__local/mailbox") {
      requireAdmin(creds);
      if (key === "GET /__local/mailbox") return json(200, mailbox(url));
      if (key === "POST /admin/users") return json(200, await adminCreateUser(await readJson(req)));
      if (key === "GET /admin/users") return adminListUsers(url, res);
      if (key === "POST /admin/generate_link") return json(200, await adminGenerateLink(await readJson(req)));
      const match = /^\/admin\/users\/([^/]+)$/.exec(route);
      if (match) {
        if (!UUID_RE.test(match[1])) throw authError(404, "user_not_found", "User not found");
        if (req.method === "GET") return json(200, await adminGetUser(match[1]));
        if (req.method === "PUT") return json(200, await adminUpdateUser(match[1], await readJson(req)));
        if (req.method === "DELETE") return json(200, await adminDeleteUser(match[1], await readJson(req)));
      }
    }
    throw authError(404, "not_found", "Not found (not implemented by the local GoTrue emulation)");
  };
}
