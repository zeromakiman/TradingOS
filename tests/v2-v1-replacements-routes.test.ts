import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

// V2 replacement of the V1 upload-route tests (tests/setup-routes.test.ts and tests/audit-routes.test.ts exercised
// POST /api/setups/[id]/screenshots, which V2 removed: docs/V2_ARCHITECTURE.md §1.2 keeps only the legacy download
// route). The same boundaries are asserted here on V2's only upload route, POST /api/trades/[id]/evidence, where
// tests/v2-routes-evidence.test.ts does not already cover them.

const m = vi.hoisted(() => ({ session: null as unknown, trusted: null as unknown, revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => m.session, requireUser: async () => m.session }));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => m.trusted }));

import { POST } from "@/app/api/trades/[id]/evidence/route";

const USER = "10000000-0000-4000-8000-000000000001";
const TRADE = "a0000000-0000-4000-8000-000000000001";
const EVIDENCE = "e0000000-0000-4000-8000-000000000001";
const PATH = `${USER}/${TRADE}/${EVIDENCE}`;

class UserDb {
  user: { id: string } | null = { id: USER };
  tradeLookup: { data: unknown; error: { message: string } | null } = { data: { id: TRADE }, error: null };
  readonly lookups: string[][] = [];
  readonly auth = { getUser: vi.fn(async () => ({ data: { user: this.user }, error: null })) };
  async rpc(fn: string) {
    if (fn !== "trading_os_schema") throw new Error(`unexpected rpc ${fn}`);
    return { data: "2.0", error: null };
  }
  from(table: string) {
    const filters: string[] = [table];
    this.lookups.push(filters);
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push(`${column}=${value}`);
        return chain;
      },
      maybeSingle: async () => (table === "trades" ? this.tradeLookup : { data: null, error: null }),
    };
    return chain;
  }
}

class Trusted {
  uploadError: { message: string; statusCode?: string } | null = null;
  readonly upload = vi.fn(async (_path: string, _bytes: Uint8Array, _options: { contentType: string; upsert: boolean }) =>
    this.uploadError ? { data: null, error: this.uploadError } : { data: { path: PATH }, error: null });
  readonly download = vi.fn(async () => ({ data: null, error: { message: "missing" } }));
  readonly remove = vi.fn(async () => ({ data: [], error: null }));
  readonly rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({
    data: { id: EVIDENCE, tradeId: TRADE, phase: "PRE_ENTRY", stateAtCreation: "DRAFT", recordedAt: "2026-10-14T14:00:00.000Z", replayed: false }, error: null,
  }));
  readonly storage = { from: () => ({ upload: this.upload, download: this.download, remove: this.remove }) };
}

let png: Buffer;
let user: UserDb;
let trusted: Trusted;
let log: MockInstance;

const context = { params: Promise.resolve({ id: TRADE }) };

function form(extra: Record<string, string> = {}, file: { bytes: Uint8Array; type: string; name: string } = { bytes: png, type: "image/png", name: "chart.png" }) {
  const data = new FormData();
  for (const [key, value] of Object.entries({ evidenceId: EVIDENCE, label: "PRE_ENTRY", captureMethod: "PASTE", ...extra })) data.set(key, value);
  data.set("file", new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  return data;
}

function upload(headers: Record<string, string> = { origin: "http://localhost" }, body: FormData | string = form(), url = `http://localhost/api/trades/${TRADE}/evidence`) {
  return new Request(url, { method: "POST", headers, body });
}

beforeEach(async () => {
  vi.clearAllMocks();
  png ??= await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer();
  user = new UserDb();
  trusted = new Trusted();
  m.session = user;
  m.trusted = trusted;
  log = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => log.mockRestore());

describe("POST /api/trades/[id]/evidence keeps the V1 upload boundaries", () => {
  it("accepts the browser's Host when Next serves the request on its internal bind hostname", async () => {
    const request = upload({ origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" }, form(), `http://localhost:3000/api/trades/${TRADE}/evidence`);
    const response = await POST(request, context);
    expect(response.status).toBe(201);
    expect(trusted.upload).toHaveBeenCalledTimes(1);
  });

  it("never trusts an attacker-controlled forwarded Host", async () => {
    const request = upload({ origin: "https://attacker.invalid", host: "localhost:3000", "x-forwarded-host": "attacker.invalid" }, form(), `http://localhost:3000/api/trades/${TRADE}/evidence`);
    expect((await POST(request, context)).status).toBe(403);
    expect(user.auth.getUser).not.toHaveBeenCalled();
    expect(trusted.upload).not.toHaveBeenCalled();
  });

  it("stores and registers for the verified user, ignoring identity and path fields sent in the form", async () => {
    const response = await POST(upload(undefined, form({ user_id: "forged", userId: "forged", storagePath: "forged/path", tradeId: "forged" })), context);
    expect(response.status).toBe(201);
    expect(user.lookups[0]).toEqual(["trades", `id=${TRADE}`, `user_id=${USER}`]);
    expect(trusted.upload.mock.calls[0][0]).toBe(PATH);
    expect(trusted.rpc).toHaveBeenCalledWith("register_trade_evidence", expect.objectContaining({ p_user_id: USER, p_record: expect.objectContaining({ tradeId: TRADE, storagePath: PATH }) }));
    expect(JSON.stringify(trusted.rpc.mock.calls)).not.toContain("forged");
  });

  it("stops before storage when the ownership read fails, without revealing the database error", async () => {
    user.tradeLookup = { data: null, error: { message: "SECRET relation detail" } };
    const response = await POST(upload(), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("SECRET");
    expect(trusted.upload).not.toHaveBeenCalled();
    expect(trusted.rpc).not.toHaveBeenCalled();
  });

  it("answers a body that is not a multipart form as a validation error, before storage", async () => {
    const response = await POST(upload({ origin: "http://localhost", "content-type": "text/plain" }, "invalid"), context);
    expect(response.status).toBe(400);
    expect(trusted.upload).not.toHaveBeenCalled();
  });

  it("refuses markup disguised as a PNG before storage", async () => {
    const response = await POST(upload(undefined, form({}, { bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), type: "image/png", name: "chart.png" })), context);
    expect(response.status).toBe(400);
    expect(trusted.upload).not.toHaveBeenCalled();
    expect(trusted.rpc).not.toHaveBeenCalled();
  });

  it("contains a storage failure: no registration, and the storage message never reaches the response or the log", async () => {
    trusted.uploadError = { message: "SECRET bucket path detail", statusCode: "500" };
    const response = await POST(upload(), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("SECRET");
    expect(trusted.rpc).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRET|10000000|a0000000/);
  });
});
