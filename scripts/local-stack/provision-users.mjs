#!/usr/bin/env node
// Creates (or repairs) the two confirmed SYNTHETIC users on the LOCAL gateway and writes
// .local/integration-users.json in the format scripts/verify-*.mjs expect:
//   {"project": "<NEXT_PUBLIC_SUPABASE_URL>", "users": [{"id","email","password"}, ...]}
// users[0] is the owner (browser user), users[1] the second user for isolation checks.
// Only ever talks to the loopback gateway, using the local secret key from .local/stack.json.
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { GATEWAY_URL, PATHS, fail, httpStatus, log, readStack, runMain } from "./lib.mjs";

const SYNTHETIC_EMAILS = ["v2.owner@example.test", "v2.other@example.test"];
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const newPassword = () => `Tos!${randomBytes(24).toString("base64url")}`;

await runMain(async () => {
  const stack = readStack();
  if (!stack) fail("Missing .local/stack.json. Start the stack first: node scripts/local-stack/start.mjs");
  if ((await httpStatus(`${GATEWAY_URL}/health`)) !== 200) fail(`The local gateway is not healthy at ${GATEWAY_URL}. Run start.mjs first.`);

  const admin = createClient(GATEWAY_URL, stack.secretKey, options);
  const signsIn = async (email, password) => {
    const client = createClient(GATEWAY_URL, stack.publishableKey, options);
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (!error) await client.auth.signOut({ scope: "local" });
    return !error && Boolean(data.session);
  };
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(PATHS.users, "utf8")); } catch { /* first run */ }

  const { data: listed, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listError) fail(`Unable to list users: ${listError.message}`);
  const users = [];
  for (const email of SYNTHETIC_EMAILS) {
    const existing = listed.users.find(u => u.email === email);
    const remembered = previous?.project === GATEWAY_URL ? previous.users?.find(u => u.email === email) : null;
    if (existing && remembered?.id === existing.id && await signsIn(email, remembered.password)) {
      users.push({ id: existing.id, email, password: remembered.password });
      log(`Kept existing user ${email}`);
      continue;
    }
    const password = newPassword();
    if (existing) {
      const { error } = await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
      if (error) fail(`Unable to reset ${email}: ${error.message}`);
      users.push({ id: existing.id, email, password });
      log(`Reset the password of existing user ${email}`);
    } else {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { purpose: "Trading OS local stack synthetic user" } });
      if (error || !data.user) fail(`Unable to create ${email}: ${error?.message ?? "no user returned"}`);
      users.push({ id: data.user.id, email, password });
      log(`Created confirmed user ${email}`);
    }
    if (!(await signsIn(email, password))) fail(`Password sign-in failed for ${email}`);
  }
  fs.writeFileSync(PATHS.users, `${JSON.stringify({ project: GATEWAY_URL, users }, null, 2)}\n`, { mode: 0o600 });
  log(`Wrote ${PATHS.users} (git-ignored): ${users.map(u => `${u.email} (${u.id})`).join(", ")}`);
});
