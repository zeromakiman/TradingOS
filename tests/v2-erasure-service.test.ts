import { afterEach, beforeEach, describe, expect, it, type Mock, type MockInstance, vi } from "vitest";

// docs/V2_ARCHITECTURE.md §10.4: the Delete Trading OS account orchestration (src/lib/erasure.ts) and its server
// action (src/app/actions/erasure.ts), against mocked Supabase clients. Nothing here reaches a network.

const mock = vi.hoisted(() => ({
  calls: [] as string[],
  requireUser: vi.fn(),
  trustedServer: vi.fn(),
  createClient: vi.fn(),
  deleteCookie: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ requireUser: mock.requireUser }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: mock.trustedServer }));
vi.mock("@/lib/supabase/config", () => ({
  publicConfig: () => ({ url: "https://project.supabase.example", key: "sb_publishable_test", cookiePrefix: "sb-test-auth-token" }),
}));
vi.mock("@supabase/supabase-js", async (importOriginal) => ({ ...(await importOriginal<object>()), createClient: mock.createClient }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [{ name: "sb-test-auth-token.0" }, { name: "sb-test-auth-token.1" }, { name: "sb-test-auth-token-user" }, { name: "tos_account" }],
    delete: mock.deleteCookie,
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: mock.revalidatePath }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); },
  unstable_rethrow: (error: unknown) => { if (error instanceof Error && error.message.startsWith("REDIRECT:")) throw error; },
}));

import { deleteTradingOsAccount } from "@/app/actions/erasure";
import {
  ERASE_CONFIRMATION_PHRASE, ERASURE_COPY, type ErasureBucket, type ErasureEvent, type ErasureServices, type ErasureStorageBucket,
  eraseTradingOsAccount, type PasswordCheck,
} from "@/lib/erasure";

const UID = "10000000-0000-4000-8000-000000000001";
const OTHER_UID = "10000000-0000-4000-8000-000000000002";
const EMAIL = "trader@example.test";
const PASSWORD = "correct horse battery staple";
const PROPOSAL = "20000000-0000-4000-8000-000000000001";
const TRADE = "30000000-0000-4000-8000-000000000001";
const object = (parent: string, n: number) => `${UID}/${parent}/${`${n}`.padStart(8, "0")}-0000-4000-8000-000000000000`;
const EVENTS: readonly ErasureEvent[] = [
  "erasure_reauth_rejected", "erasure_reauth_unavailable", "erasure_purge_refused", "erasure_purge_failed",
  "erasure_storage_failed", "erasure_sign_out_failed", "erasure_delete_user_failed", "erasure_failed", "erasure_completed",
];

type Result = { error: { message: string; status?: number; code?: string } | null };
const ok: Result = { error: null };

/** In-memory private buckets with Storage's one-level listing: folders come back with a null id. */
class FakeStorage {
  readonly objects: Record<ErasureBucket, Set<string>> = { "setup-screenshots": new Set(), "trade-evidence": new Set() };
  failRemove = 0;
  failList = false;

  bucket(name: ErasureBucket): ErasureStorageBucket {
    const objects = this.objects[name];
    return {
      list: async (path, { limit, offset }) => {
        mock.calls.push(`list ${name} ${path.replace(UID, "{uid}")} @${offset}`);
        if (this.failList) return { data: null, error: { message: "Storage unavailable" } };
        const children = new Map<string, boolean>();
        for (const key of objects) {
          if (!key.startsWith(`${path}/`)) continue;
          const [head, ...rest] = key.slice(path.length + 1).split("/");
          children.set(head, (children.get(head) ?? false) || rest.length > 0);
        }
        const entries = [...children].sort(([a], [b]) => (a < b ? -1 : 1)).map(([entry, folder]) => ({ name: entry, id: folder ? null : `id-${entry}` }));
        return { data: entries.slice(offset, offset + limit), error: null };
      },
      remove: async (paths) => {
        mock.calls.push(`remove ${name} ${paths.length}`);
        if (this.failRemove > 0) {
          this.failRemove -= 1;
          return { error: { message: "Storage unavailable" } };
        }
        for (const path of paths) objects.delete(path);
        return ok;
      },
    };
  }
}

interface Fixture {
  storage: FakeStorage;
  services: ErasureServices;
  passwordCheck: PasswordCheck;
  /** The user a VALID re-authentication signed in (the typed password's account). */
  verifiedUser: string;
  purgeResult: { data: unknown; error: Result["error"] };
  signOutResult: Result;
  deleteUserResults: Result[];
  log: ErasureEvent[];
}

function fixture(): Fixture {
  const storage = new FakeStorage();
  const legacy = [object(PROPOSAL, 1), object(PROPOSAL, 2)];
  const evidence = [object(TRADE, 3)];
  for (const path of legacy) storage.objects["setup-screenshots"].add(path);
  for (const path of evidence) storage.objects["trade-evidence"].add(path);
  const f: Fixture = {
    storage,
    passwordCheck: "VALID",
    purgeResult: { data: { storagePaths: { legacy, evidence }, deleted: { accounts: 1, trades: 2 } }, error: null },
    verifiedUser: UID,
    signOutResult: ok,
    deleteUserResults: [],
    log: [],
    services: {
      reauthenticate: async (email, password) => {
        mock.calls.push(`verify ${email === EMAIL} ${password === PASSWORD}`);
        const check = f.passwordCheck;
        return check === "VALID" ? { check, userId: f.verifiedUser } : { check };
      },
      purge: async (userId, confirmation) => {
        mock.calls.push(`purge ${userId === UID ? "{uid}" : userId} ${confirmation}`);
        const result = f.purgeResult;
        // The database is empty after the first successful purge.
        if (!result.error) f.purgeResult = { data: { storagePaths: { legacy: [], evidence: [] }, deleted: { accounts: 0, trades: 0 } }, error: null };
        return result;
      },
      bucket: (name) => storage.bucket(name),
      signOutEverywhere: async () => {
        mock.calls.push("signOut global");
        return f.signOutResult;
      },
      deleteUser: async (id) => {
        mock.calls.push(`deleteUser ${id === UID}`);
        return f.deleteUserResults.shift() ?? ok;
      },
    },
  };
  return f;
}

const request = (changes: Partial<{ email: string | null; confirmation: string; password: string }> = {}) =>
  ({ userId: UID, email: EMAIL, confirmation: "DELETE", password: PASSWORD, ...changes });
const erase = (f: Fixture, changes: Parameters<typeof request>[0] = {}) => eraseTradingOsAccount(request(changes), f.services, (event) => f.log.push(event));
const storageEmpty = (f: Fixture) => f.storage.objects["setup-screenshots"].size + f.storage.objects["trade-evidence"].size === 0;

beforeEach(() => {
  mock.calls.length = 0;
});

describe("eraseTradingOsAccount", () => {
  it("re-authenticates, purges the session user through the trusted server, deletes registered objects, sweeps both prefixes, signs out everywhere, then deletes the auth user", async () => {
    const f = fixture();
    f.storage.objects["trade-evidence"].add(`${UID}/${TRADE}/orphan-of-a-failed-upload`);
    expect(await erase(f)).toEqual({ ok: true });
    expect(mock.calls).toEqual([
      "verify true true",
      `purge {uid} ${ERASE_CONFIRMATION_PHRASE}`,
      "remove setup-screenshots 2",
      "list setup-screenshots {uid} @0",
      "remove trade-evidence 1",
      "list trade-evidence {uid} @0",
      `list trade-evidence {uid}/${TRADE} @0`,
      "remove trade-evidence 1",
      "list trade-evidence {uid} @0",
      "signOut global",
      "deleteUser true",
    ]);
    expect(storageEmpty(f)).toBe(true);
    expect(f.log).toEqual(["erasure_completed"]);
  });

  it.each([
    [{ confirmation: "delete" }, ERASURE_COPY.confirmationRequired],
    [{ confirmation: " DELETE" }, ERASURE_COPY.confirmationRequired],
    [{ confirmation: "" }, ERASURE_COPY.confirmationRequired],
    [{ password: "" }, ERASURE_COPY.passwordRequired],
    [{ password: "x".repeat(1025) }, ERASURE_COPY.passwordRequired],
  ])("rejects %j before calling any service", async (changes, copy) => {
    const f = fixture();
    expect(await erase(f, changes)).toEqual({ ok: false, error: copy });
    expect(mock.calls).toEqual([]);
    expect(f.log).toEqual([]);
  });

  it.each([
    ["REJECTED", ERASURE_COPY.passwordRejected, "erasure_reauth_rejected"],
    ["UNAVAILABLE", ERASURE_COPY.signInUnavailable, "erasure_reauth_unavailable"],
  ] as const)("stops before the purge when re-authentication is %s", async (check, copy, event) => {
    const f = fixture();
    f.passwordCheck = check;
    expect(await erase(f)).toEqual({ ok: false, error: copy });
    expect(mock.calls).toEqual(["verify true true"]);
    expect(f.log).toEqual([event]);
  });

  it("stops before the purge when re-authentication throws or the account has no email", async () => {
    const f = fixture();
    f.services.reauthenticate = async () => { throw new Error(`network down for ${EMAIL}`); };
    expect(await erase(f)).toEqual({ ok: false, error: ERASURE_COPY.signInUnavailable });
    expect(await erase(f, { email: null })).toEqual({ ok: false, error: ERASURE_COPY.incomplete });
    expect(mock.calls).toEqual([]);
    expect(f.log).toEqual(["erasure_reauth_unavailable", "erasure_failed"]);
  });

  it("never purges when the typed password signed in another account, and never purges anyone but the session user", async () => {
    const f = fixture();
    f.verifiedUser = OTHER_UID;
    expect(await erase(f)).toEqual({ ok: false, error: ERASURE_COPY.passwordRejected });
    expect(mock.calls).toEqual(["verify true true"]);
    expect(f.log).toEqual(["erasure_reauth_rejected"]);
    // The purge names the user of the verified session only: the request's userId, never anything from the form.
    const g = fixture();
    expect(await erase(g)).toEqual({ ok: true });
    expect(mock.calls.filter((call) => call.startsWith("purge"))).toEqual([`purge {uid} ${ERASE_CONFIRMATION_PHRASE}`]);
  });

  it("explains a purge refused for an in-flight AI request and touches nothing else", async () => {
    const f = fixture();
    f.purgeResult = { data: null, error: { message: "AI_REQUEST_IN_PROGRESS: An AI request of this user is still running" } };
    expect(await erase(f)).toEqual({ ok: false, error: ERASURE_COPY.aiInProgress });
    expect(mock.calls).toEqual(["verify true true", `purge {uid} ${ERASE_CONFIRMATION_PHRASE}`]);
    expect(f.log).toEqual(["erasure_purge_refused"]);
  });

  it.each([
    ["an incomplete purge", { data: null, error: { message: "PURGE_INCOMPLETE: trades" } }],
    ["a database that still requires the retired self-service re-authentication", { data: null, error: { message: "REAUTH_REQUIRED: Erasure requires a password sign-in within the last 5 minutes." } }],
    ["a path outside the user's prefix", { data: { storagePaths: { legacy: [`20000000-0000-4000-8000-000000000009/${PROPOSAL}/${TRADE}`], evidence: [] }, deleted: {} }, error: null }],
    ["a malformed result", { data: { storagePaths: { legacy: [] }, deleted: {} }, error: null }],
  ])("never deletes storage or the login after %s", async (_name, purgeResult) => {
    const f = fixture();
    f.purgeResult = purgeResult;
    expect(await erase(f)).toEqual({ ok: false, error: ERASURE_COPY.incomplete });
    expect(mock.calls).toEqual(["verify true true", `purge {uid} ${ERASE_CONFIRMATION_PHRASE}`]);
    expect(f.log).toEqual(["erasure_purge_failed"]);
  });

  it("reports a purge call that throws as an incomplete deletion", async () => {
    const f = fixture();
    f.services.purge = async () => { throw new Error("fetch failed"); };
    expect(await erase(f)).toEqual({ ok: false, error: ERASURE_COPY.incomplete });
    expect(mock.calls).toEqual(["verify true true"]);
    expect(f.log).toEqual(["erasure_purge_failed"]);
  });

  it("keeps the auth user after a storage failure, and a retry converges through the prefix sweep", async () => {
    const f = fixture();
    f.storage.failRemove = 1;
    expect(await erase(f)).toEqual({ ok: false, error: ERASURE_COPY.incomplete });
    expect(mock.calls).not.toContain("signOut global");
    expect(mock.calls.some((call) => call.startsWith("deleteUser"))).toBe(false);
    expect(f.log).toEqual(["erasure_storage_failed"]);
    expect(storageEmpty(f)).toBe(false);

    mock.calls.length = 0;
    expect(await erase(f)).toEqual({ ok: true });
    // The second purge returns no paths: the database rows are already gone, the sweep finds the objects anyway.
    expect(mock.calls.filter((call) => call.startsWith("remove"))).toEqual(["remove setup-screenshots 2", "remove trade-evidence 1"]);
    expect(mock.calls.slice(-2)).toEqual(["signOut global", "deleteUser true"]);
    expect(storageEmpty(f)).toBe(true);
  });

  it("fails the storage step when listing fails or a listing never empties", async () => {
    const f = fixture();
    f.storage.failList = true;
    expect(await erase(f)).toEqual({ ok: false, error: ERASURE_COPY.incomplete });
    const g = fixture();
    g.storage.bucket = (name) => ({
      list: async () => ({ data: [{ name: `stuck-${name}`, id: "object" }], error: null }),
      remove: async () => ok,
    });
    expect(await erase(g)).toEqual({ ok: false, error: ERASURE_COPY.incomplete });
    expect([...f.log, ...g.log]).toEqual(["erasure_storage_failed", "erasure_storage_failed"]);
  });

  it("refuses listings that would leave the user's prefix", async () => {
    for (const name of ["", ".", "..", "a/b"]) {
      const f = fixture();
      f.storage.bucket = () => ({ list: async () => ({ data: [{ name, id: "object" }], error: null }), remove: async () => ok });
      expect(await erase(f), name).toEqual({ ok: false, error: ERASURE_COPY.incomplete });
    }
  });

  it("removes in batches of 100 and pages through large folders", async () => {
    const f = fixture();
    const legacy = Array.from({ length: 250 }, (_, n) => object(PROPOSAL, n + 10));
    for (const path of legacy) f.storage.objects["setup-screenshots"].add(path);
    f.purgeResult = { data: { storagePaths: { legacy, evidence: [] }, deleted: {} }, error: null };
    // 120 orphans in one folder: the sweep must read two listing pages.
    for (let n = 0; n < 120; n += 1) f.storage.objects["trade-evidence"].add(object(TRADE, n + 500));
    expect(await erase(f)).toEqual({ ok: true });
    expect(mock.calls.filter((call) => call.startsWith("remove setup-screenshots"))).toEqual([
      "remove setup-screenshots 100", "remove setup-screenshots 100", "remove setup-screenshots 50", "remove setup-screenshots 2",
    ]);
    expect(mock.calls).toContain(`list trade-evidence {uid}/${TRADE} @100`);
    expect(storageEmpty(f)).toBe(true);
  });

  it("surfaces a failed auth-user deletion with retry copy, and treats an already-deleted user as done", async () => {
    const f = fixture();
    f.deleteUserResults = [{ error: { message: "Database error deleting user", status: 500 } }];
    expect(await erase(f)).toEqual({ ok: false, error: ERASURE_COPY.incomplete });
    expect(f.log).toEqual(["erasure_delete_user_failed"]);
    f.deleteUserResults = [{ error: { message: "User not found", status: 404, code: "user_not_found" } }];
    expect(await erase(f)).toEqual({ ok: true });
    const g = fixture();
    g.services.deleteUser = async () => { throw new Error("fetch failed"); };
    expect(await erase(g)).toEqual({ ok: false, error: ERASURE_COPY.incomplete });
    expect(g.log).toEqual(["erasure_delete_user_failed"]);
  });

  it("still deletes the auth user when the global sign-out fails", async () => {
    const f = fixture();
    f.signOutResult = { error: { message: "session_not_found" } };
    expect(await erase(f)).toEqual({ ok: true });
    expect(mock.calls.slice(-2)).toEqual(["signOut global", "deleteUser true"]);
    expect(f.log).toEqual(["erasure_sign_out_failed", "erasure_completed"]);
    const g = fixture();
    g.services.signOutEverywhere = async () => { throw new Error("network"); };
    expect(await erase(g)).toEqual({ ok: true });
  });
});

describe("deleteTradingOsAccount server action", () => {
  // `session` is the cookie session of the request; `verifier` the non-persisting client of the password re-entry;
  // `trusted` the secret-key client, the only one that may call the purge.
  let session: { rpc: Mock; auth: { signOut: Mock } };
  let verifier: { rpc: Mock; auth: { signInWithPassword: Mock; signOut: Mock } };
  let trustedRpc: Mock;
  let deleteUser: Mock;
  let storage: FakeStorage;
  let logs: MockInstance[];

  const form = (fields: Record<string, string> = { confirmation: "DELETE", password: PASSWORD }) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  };
  const logged = () => logs.flatMap((spy) => spy.mock.calls.map((call: unknown[]) => call.map(String).join(" ")));
  const PURGE_CALL = `trusted rpc purge_user_trading_data {"p_user_id":"${UID}","p_confirm":"${ERASE_CONFIRMATION_PHRASE}"}`;

  beforeEach(() => {
    vi.clearAllMocks();
    logs = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "info").mockImplementation(() => {})];
    storage = new FakeStorage();
    storage.objects["trade-evidence"].add(object(TRADE, 1));
    // A user token can no longer execute any purge function (0019); neither user client may even try.
    const denied = { data: null, error: { message: "permission denied for function purge_user_trading_data", code: "42501" } };
    session = {
      rpc: vi.fn(async (name: string) => { mock.calls.push(`session rpc ${name}`); return denied; }),
      auth: { signOut: vi.fn(async (options: unknown) => { mock.calls.push(`session signOut ${JSON.stringify(options)}`); return ok; }) },
    };
    verifier = {
      rpc: vi.fn(async (name: string) => { mock.calls.push(`verifier rpc ${name}`); return denied; }),
      auth: {
        signInWithPassword: vi.fn(async () => { mock.calls.push("verifier signIn"); return { data: { user: { id: UID } }, error: null }; }),
        signOut: vi.fn(async (options: unknown) => { mock.calls.push(`verifier signOut ${JSON.stringify(options)}`); return ok; }),
      },
    };
    trustedRpc = vi.fn(async (name: string, args: unknown) => {
      mock.calls.push(`trusted rpc ${name} ${JSON.stringify(args)}`);
      return { data: { storagePaths: { legacy: [], evidence: [object(TRADE, 1)] }, deleted: { trade_evidence: 1 } }, error: null };
    });
    deleteUser = vi.fn(async () => { mock.calls.push("admin deleteUser"); return { data: { user: null }, error: null }; });
    mock.requireUser.mockImplementation(async (writable: boolean) => {
      mock.calls.push(`requireUser ${writable}`);
      return { db: session, user: { id: UID, email: EMAIL } };
    });
    mock.trustedServer.mockImplementation(() => {
      mock.calls.push("trustedServer");
      return { rpc: trustedRpc, storage: { from: (name: ErasureBucket) => storage.bucket(name) }, auth: { admin: { deleteUser } } };
    });
    mock.createClient.mockImplementation(() => verifier);
    mock.revalidatePath.mockImplementation(() => { mock.calls.push("revalidate"); });
    mock.deleteCookie.mockImplementation((name: string) => { mock.calls.push(`delete cookie ${name}`); });
  });
  afterEach(() => {
    for (const spy of logs) spy.mockRestore();
  });

  it("ends the verifier session before the trusted server purges the session user, then clears auth and account cookies and redirects", async () => {
    await expect(deleteTradingOsAccount({}, form())).rejects.toThrow("REDIRECT:/login?reason=account_deleted");
    expect(mock.createClient).toHaveBeenCalledWith("https://project.supabase.example", "sb_publishable_test", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    expect(verifier.auth.signInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
    expect(deleteUser).toHaveBeenCalledWith(UID);
    // No user token calls the purge: neither the cookie session nor the fresh sign-in, which only proves the password.
    expect(session.rpc).not.toHaveBeenCalled();
    expect(verifier.rpc).not.toHaveBeenCalled();
    expect(mock.calls).toEqual([
      "requireUser true",
      "trustedServer",
      "verifier signIn",
      'verifier signOut {"scope":"local"}',
      PURGE_CALL,
      "list setup-screenshots {uid} @0",
      "remove trade-evidence 1",
      "list trade-evidence {uid} @0",
      'session signOut {"scope":"global"}',
      "admin deleteUser",
      // The deleted user's trading-account ids leave the browser with the login (src/lib/account-context.ts).
      "delete cookie tos_account",
      "delete cookie tos_last_account",
      "delete cookie sb-test-auth-token.0",
      "delete cookie sb-test-auth-token.1",
      "delete cookie sb-test-auth-token-user",
      "revalidate",
    ]);
    expect(mock.revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(storage.objects["trade-evidence"].size).toBe(0);
    expect(logged()).toEqual([JSON.stringify({ event: "erasure_completed" })]);
  });

  it("validates the typed confirmation before creating the trusted client", async () => {
    expect(await deleteTradingOsAccount({}, form({ confirmation: "delete", password: PASSWORD }))).toEqual({ error: ERASURE_COPY.confirmationRequired });
    expect(await deleteTradingOsAccount({}, form({ confirmation: "DELETE" }))).toEqual({ error: ERASURE_COPY.passwordRequired });
    expect(mock.trustedServer).not.toHaveBeenCalled();
    expect(session.rpc).not.toHaveBeenCalled();
  });

  /** Nothing was purged, stored objects stay, and the account keeps its login, sessions and cookies. */
  const expectNothingDeleted = () => {
    expect(trustedRpc).not.toHaveBeenCalled();
    expect(verifier.rpc).not.toHaveBeenCalled();
    expect(session.rpc).not.toHaveBeenCalled();
    expect(mock.calls.filter((call) => call.startsWith("list") || call.startsWith("remove"))).toEqual([]);
    expect(session.auth.signOut).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(mock.deleteCookie).not.toHaveBeenCalled();
  };

  it("stops before the purge when the password is wrong, and keeps the session", async () => {
    verifier.auth.signInWithPassword.mockResolvedValue({ data: { user: null }, error: { name: "AuthApiError", message: "Invalid login credentials", status: 400 } });
    expect(await deleteTradingOsAccount({}, form())).toEqual({ error: ERASURE_COPY.passwordRejected });
    expectNothingDeleted();
  });

  it("rejects a password that signs in a different account, and ends that session at once", async () => {
    verifier.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: OTHER_UID } }, error: null });
    expect(await deleteTradingOsAccount({}, form())).toEqual({ error: ERASURE_COPY.passwordRejected });
    expect(verifier.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expectNothingDeleted();
    expect(logged()).toEqual([JSON.stringify({ event: "erasure_reauth_rejected" })]);
  });

  it.each([503, 429])("reports a sign-in outage (HTTP %i) as such and deletes nothing", async (status) => {
    verifier.auth.signInWithPassword.mockResolvedValue({ data: { user: null }, error: { name: "AuthApiError", message: "Unavailable", status } });
    expect(await deleteTradingOsAccount({}, form())).toEqual({ error: ERASURE_COPY.signInUnavailable });
    expectNothingDeleted();
  });

  it("still erases when ending the verifier session fails: the global sign-out revokes it as well", async () => {
    verifier.auth.signOut.mockRejectedValue(new Error("network"));
    await expect(deleteTradingOsAccount({}, form())).rejects.toThrow("REDIRECT:/login?reason=account_deleted");
    expect(trustedRpc).toHaveBeenCalledOnce();
    expect(session.auth.signOut).toHaveBeenCalledWith({ scope: "global" });
  });

  it("explains a purge the database refused while AI is in flight, and deletes nothing else", async () => {
    trustedRpc.mockResolvedValue({ data: null, error: { message: "AI_REQUEST_IN_PROGRESS: An AI request of this user is still running; retry once it has finished.", code: "P0001" } });
    expect(await deleteTradingOsAccount({}, form())).toEqual({ error: ERASURE_COPY.aiInProgress });
    expect(trustedRpc).toHaveBeenCalledOnce();
    expect(mock.calls.filter((call) => call.startsWith("list") || call.startsWith("remove"))).toEqual([]);
    expect(session.auth.signOut).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(mock.deleteCookie).not.toHaveBeenCalled();
    expect(logged()).toEqual([JSON.stringify({ event: "erasure_purge_refused" })]);
  });

  it("deletes nothing when the secret key is missing", async () => {
    mock.trustedServer.mockImplementation(() => { throw new Error("Server storage credentials are not configured. Add SUPABASE_SECRET_KEY to .env.local and restart."); });
    expect(await deleteTradingOsAccount({}, form())).toEqual({ error: ERASURE_COPY.incomplete });
    expect(verifier.auth.signInWithPassword).not.toHaveBeenCalled();
    expect(session.rpc).not.toHaveBeenCalled();
    expect(logged()).toEqual([JSON.stringify({ event: "erasure_failed" })]);
  });

  it("keeps the login when storage deletion fails after the purge", async () => {
    storage.failRemove = 1;
    expect(await deleteTradingOsAccount({}, form())).toEqual({ error: ERASURE_COPY.incomplete });
    expect(trustedRpc).toHaveBeenCalledOnce();
    expect(session.auth.signOut).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(mock.deleteCookie).not.toHaveBeenCalled();
  });

  it("surfaces a failed auth-user deletion with retry copy instead of redirecting", async () => {
    deleteUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthApiError", message: "Database error deleting user", status: 500 } });
    expect(await deleteTradingOsAccount({}, form())).toEqual({ error: ERASURE_COPY.incomplete });
    expect(mock.revalidatePath).not.toHaveBeenCalled();
    expect(logged()).toEqual([JSON.stringify({ event: "erasure_delete_user_failed" })]);
  });

  it("lets the sign-in redirect of an expired session through", async () => {
    mock.requireUser.mockRejectedValue(new Error("REDIRECT:/login?reason=session"));
    await expect(deleteTradingOsAccount({}, form())).rejects.toThrow("REDIRECT:/login?reason=session");
    expect(mock.trustedServer).not.toHaveBeenCalled();
  });

  it("logs fixed events only: never the email, password, user id, storage paths or error texts", async () => {
    const run = async (setup: () => void) => {
      setup();
      await deleteTradingOsAccount({}, form()).catch(() => undefined);
    };
    await run(() => {});
    await run(() => verifier.auth.signInWithPassword.mockResolvedValue({ data: { user: null }, error: { name: "AuthApiError", message: `Invalid login for ${EMAIL}`, status: 400 } }));
    await run(() => {
      verifier.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: UID } }, error: null });
      trustedRpc.mockResolvedValue({ data: null, error: { message: `PURGE_INCOMPLETE: trades of ${UID}` } });
    });
    await run(() => {
      storage.failRemove = 5;
      trustedRpc.mockResolvedValue({ data: { storagePaths: { legacy: [], evidence: [object(TRADE, 1)] }, deleted: {} }, error: null });
    });
    await run(() => { mock.requireUser.mockRejectedValue(new Error(`Sign-in service down for ${EMAIL} ${PASSWORD}`)); });
    const lines = logged();
    expect(lines.map((line) => JSON.parse(line).event).sort())
      .toEqual(["erasure_completed", "erasure_failed", "erasure_purge_failed", "erasure_reauth_rejected", "erasure_storage_failed"]);
    for (const line of lines) {
      expect(EVENTS).toContain(JSON.parse(line).event);
      expect(Object.keys(JSON.parse(line))).toEqual(["event"]);
      for (const secret of [EMAIL, PASSWORD, UID, TRADE, "PURGE_INCOMPLETE", "Invalid login"]) expect(line).not.toContain(secret);
    }
  });
});
