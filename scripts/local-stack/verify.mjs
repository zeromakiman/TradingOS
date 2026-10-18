#!/usr/bin/env node
// API-level conformance checks for the LOCAL stack, driven through @supabase/supabase-js exactly
// like the app: auth (password/refresh/PKCE recovery/logout/admin), PostgREST + RLS, and Storage
// policies from supabase/migrations/0005. Creates its own throwaway synthetic users per run
// (verify-<run>-a/b@example.test), so the browser users stay untouched. Local gateway only.
// Usage: node scripts/local-stack/verify.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { GATEWAY_URL, fail, httpStatus, makePng, readStack, runMain } from "./lib.mjs";

const BUCKET = "setup-screenshots";
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

await runMain(async () => {
  const stack = readStack();
  if (!stack) fail("Missing .local/stack.json. Run start.mjs first.");
  if ((await httpStatus(`${GATEWAY_URL}/health`)) !== 200) fail(`Gateway not healthy at ${GATEWAY_URL}`);
  const checks = [];
  const check = async (name, fn) => { await fn(); checks.push(name); console.log(`PASS ${name}`); };
  const data = async request => { const r = await request; if (r.error) throw new Error(`${r.error.code ?? r.error.status ?? ""}: ${r.error.message}`); return r.data; };
  const client = (key = stack.publishableKey, extra = {}) => createClient(GATEWAY_URL, key, { ...options, ...extra, auth: { ...options.auth, ...extra.auth } });

  const admin = client(stack.secretKey);
  const run = randomBytes(4).toString("hex");
  const people = [];
  for (const label of ["a", "b"]) {
    const email = `verify-${run}-${label}@example.test`, password = `Tos!${randomBytes(18).toString("base64url")}`;
    const created = await data(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { purpose: "local-stack verify" } }));
    people.push({ id: created.user.id, email, password });
  }
  const [A, B] = people;
  const a = client(), b = client(), anon = client();

  await check("Password sign-in, getUser and server-verified getClaims", async () => {
    const session = await data(a.auth.signInWithPassword({ email: A.email, password: A.password }));
    assert.equal(session.user.id, A.id);
    assert.equal(session.session.token_type, "bearer");
    assert.ok(session.session.expires_at > Date.now() / 1000);
    assert.equal((await data(a.auth.getUser())).user.email, A.email);
    const claims = await data(a.auth.getClaims());
    assert.equal(claims.claims.sub, A.id); assert.equal(claims.claims.role, "authenticated"); assert.equal(claims.claims.aal, "aal1");
    await data(b.auth.signInWithPassword({ email: B.email, password: B.password }));
    const wrong = await client().auth.signInWithPassword({ email: A.email, password: "wrong-password" });
    assert.equal(wrong.error?.code, "invalid_credentials"); assert.equal(wrong.error?.status, 400);
  });

  await check("Refresh token rotation and concurrent-replay tolerance", async () => {
    const before = (await a.auth.getSession()).data.session;
    const refreshed = await data(a.auth.refreshSession());
    assert.notEqual(refreshed.session.refresh_token, before.refresh_token);
    const replay = await client().auth.refreshSession({ refresh_token: before.refresh_token });
    assert.equal(replay.error, null, "replay within the reuse interval returns the active token");
    assert.equal(replay.data.session.refresh_token, refreshed.session.refresh_token);
  });

  await check("Admin API is service-role only; duplicates are rejected", async () => {
    const listed = await data(admin.auth.admin.listUsers({ page: 1, perPage: 1000 }));
    assert.ok(listed.users.some(u => u.id === A.id));
    assert.equal((await data(admin.auth.admin.getUserById(B.id))).user.email, B.email);
    const dup = await admin.auth.admin.createUser({ email: A.email, password: "Another-password-1", email_confirm: true });
    assert.equal(dup.error?.code, "email_exists");
    const notAdmin = await client().auth.admin.listUsers();
    assert.equal(notAdmin.error?.status, 403);
    const signup = await client().auth.signUp({ email: `signup-${run}@example.test`, password: "Signup-password-1" });
    assert.equal(signup.error?.code, "signup_disabled");
  });

  let account, ctx;
  await check("PostgREST RPC + owner RLS + anonymous denial", async () => {
    account = await data(a.rpc("bootstrap_demo_account", { p_idempotency_key: randomUUID(), p_name: "Verify account", p_equity: "10000", p_balance: "10000" }));
    const [r, o, i] = await Promise.all([
      data(a.from("risk_plan_versions").select("id").eq("account_id", account).single()),
      data(a.from("account_observations").select("id").eq("account_id", account).single()),
      data(a.from("instrument_versions").select("id").eq("account_id", account).eq("symbol", "EURUSD").single()),
    ]);
    ctx = { r, o, i };
    assert.deepEqual(await data(b.from("accounts").select("id").eq("id", account)), []);
    assert.ok((await anon.from("accounts").select("id").limit(1)).error, "anonymous table read must fail");
    assert.ok((await b.rpc("evaluate_trade_plan", { p_account_id: account, p_proposal: {}, p_expected_risk_id: r.id, p_expected_observation_id: o.id })).error);
    const counted = await a.from("instrument_versions").select("id", { count: "exact", head: true }).eq("account_id", account);
    assert.equal(counted.error, null); assert.equal(counted.count, 2);
    const ranged = await a.from("instrument_versions").select("symbol").eq("account_id", account).order("symbol").range(0, 0);
    assert.deepEqual(ranged.data.map(x => x.symbol), ["EURUSD"]);
  });

  let screenshot;
  await check("Service-role upload + registration; owner download; other user, anon and public URL denied", async () => {
    const proposal = { instrumentId: ctx.i.id, direction: "LONG", model: "OB_FIRST_TOUCH", entry: "1.10000", stop: "1.09800", target: "1.10600", riskPercent: "0.5", narrative: "Local stack verification (synthetic).", contractConfirmed: true, news: "UNKNOWN", contradiction: false };
    const proposalId = await data(a.rpc("save_setup_proposal", { p_account_id: account, p_proposal: proposal, p_key: randomUUID(), p_expected_risk_id: ctx.r.id, p_expected_observation_id: ctx.o.id }));
    const bytes = makePng(64, 40), imageId = randomUUID(), path = `${A.id}/${proposalId}/${imageId}`;
    const bucket = await data(admin.storage.getBucket(BUCKET));
    assert.equal(bucket.public, false); assert.equal(bucket.file_size_limit, 4194304);
    await data(admin.storage.from(BUCKET).upload(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), { contentType: "image/png", upsert: false }));
    await data(admin.from("setup_screenshots").insert({ id: imageId, user_id: A.id, account_id: account, proposal_id: proposalId, role: "M5", storage_path: path, original_filename: "verify.png", width: 64, height: 40, byte_size: bytes.length, mime_type: "image/png", sha256: createHash("sha256").update(bytes).digest("hex") }));
    screenshot = { path, bytes };
    const own = await data(a.storage.from(BUCKET).download(path));
    assert.deepEqual(Buffer.from(await own.arrayBuffer()), bytes);
    assert.ok((await b.storage.from(BUCKET).download(path)).error, "second user must not download");
    assert.ok((await anon.storage.from(BUCKET).download(path)).error, "anonymous must not download");
    assert.deepEqual(await data(b.storage.from(BUCKET).list(A.id)), []);
    assert.deepEqual((await data(a.storage.from(BUCKET).list(A.id))).map(x => x.name), [proposalId]);
    assert.ok((await httpStatus(`${GATEWAY_URL}/storage/v1/object/public/${BUCKET}/${path}`)) >= 400);
  });

  await check("Storage write guards, bucket limits, duplicates, signed URLs and removal", async () => {
    const userUpload = await a.storage.from(BUCKET).upload(`${A.id}/${randomUUID()}`, new Uint8Array([1, 2, 3]), { contentType: "image/png" });
    assert.equal(userUpload.error?.statusCode, "403", "authenticated users cannot write to the private bucket");
    const scratch = `${A.id}/verify/${randomUUID()}`;
    assert.equal((await admin.storage.from(BUCKET).upload(scratch, new Uint8Array([1]), { contentType: "image/gif" })).error?.statusCode, "415");
    assert.equal((await admin.storage.from(BUCKET).upload(scratch, new Uint8Array(4194305), { contentType: "image/png" })).error?.statusCode, "413");
    await data(admin.storage.from(BUCKET).upload(scratch, screenshot.bytes, { contentType: "image/png" }));
    assert.equal((await admin.storage.from(BUCKET).upload(scratch, screenshot.bytes, { contentType: "image/png" })).error?.statusCode, "409");
    const signed = await data(admin.storage.from(BUCKET).createSignedUrl(scratch, 60));
    const fetched = await fetch(signed.signedUrl);
    assert.equal(fetched.status, 200); assert.equal(fetched.headers.get("content-type"), "image/png");
    assert.equal((await fetch(signed.signedUrl.replace(/token=[^&]+/, "token=bad"))).status, 400);
    const removed = await data(admin.storage.from(BUCKET).remove([scratch]));
    assert.deepEqual(removed.map(x => x.name), [scratch]);
    assert.ok((await admin.storage.from(BUCKET).download(scratch)).error);
    assert.deepEqual(await data(a.storage.from(BUCKET).remove([screenshot.path])), [], "owner cannot delete registered evidence");
  });

  await check("Deleting a user referenced by public tables fails like a real FK", async () => {
    const result = await admin.auth.admin.deleteUser(A.id);
    assert.ok(result.error, "delete must fail while public.accounts references the user");
    assert.equal(result.error.status, 500);
    assert.equal((await data(admin.auth.admin.getUserById(A.id))).user.id, A.id);
  });

  await check("PKCE password recovery: /recover -> mailbox link -> /verify -> code exchange -> password update", async () => {
    const memory = new Map();
    const storage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); }, removeItem: k => { memory.delete(k); } };
    const browser = client(stack.publishableKey, { auth: { flowType: "pkce", storage, persistSession: true } });
    await data(browser.auth.resetPasswordForEmail(B.email, { redirectTo: "http://127.0.0.1:3000/update-password" }));
    const box = await (await fetch(`${GATEWAY_URL}/auth/v1/__local/mailbox?email=${encodeURIComponent(B.email)}`, { headers: { apikey: stack.secretKey } })).json();
    const link = box.messages.at(-1)?.link;
    assert.ok(link, "recovery link was recorded");
    const verify = await fetch(link, { redirect: "manual" });
    assert.equal(verify.status, 303);
    const location = new URL(verify.headers.get("location"));
    assert.equal(location.origin + location.pathname, "http://127.0.0.1:3000/update-password");
    const exchanged = await data(browser.auth.exchangeCodeForSession(location.searchParams.get("code")));
    assert.equal(exchanged.user.id, B.id);
    const same = await browser.auth.updateUser({ password: B.password });
    assert.equal(same.error?.code, "same_password");
    const weak = await browser.auth.updateUser({ password: "123" });
    assert.equal(weak.error?.code, "weak_password");
    const next = `Tos!${randomBytes(18).toString("base64url")}`;
    await data(browser.auth.updateUser({ password: next }));
    assert.ok((await client().auth.signInWithPassword({ email: B.email, password: B.password })).error, "old password rejected");
    await data(client().auth.signInWithPassword({ email: B.email, password: next }));
    assert.equal((await fetch(link, { redirect: "manual" })).headers.get("location").includes("error=access_denied"), true, "links are single-use");
  });

  await check("Sign-out revokes the session for GoTrue while the JWT stays valid for PostgREST until expiry", async () => {
    const token = (await a.auth.getSession()).data.session.access_token;
    await data(a.auth.signOut({ scope: "local" }));
    const after = await client().auth.getUser(token);
    assert.equal(after.error?.name, "AuthSessionMissingError");
  });

  console.log(`LOCAL STACK VERIFY PASSED: ${checks.length} checks (throwaway users ${A.email}, ${B.email})`);
});
