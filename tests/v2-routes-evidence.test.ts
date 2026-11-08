import { createHash } from "node:crypto";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

// Evidence pipeline (docs/V2_ARCHITECTURE.md §7.2–7.4, §10.2–10.3): the upload route (same origin, session, RLS
// ownership, bounded body, magic bytes + full decode, trusted upload without overwrite, replay detection by sha256,
// service registration with the verified user id, cleanup with fixed log events), the owner-only delivery routes with
// the 640×640 WEBP thumbnail, and the Before-entry-only copy of a duplicated draft.

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({ session: null as unknown, trusted: null as unknown, trustedError: null as Error | null, revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => m.session, requireUser: async () => m.session }));
vi.mock("@/lib/supabase/admin", () => ({
  trustedServer: () => {
    if (m.trustedError) throw m.trustedError;
    return m.trusted;
  },
}));

import { GET as evidenceGet } from "@/app/api/evidence/[id]/route";
import { GET as screenshotGet } from "@/app/api/screenshots/[id]/route";
import { POST } from "@/app/api/trades/[id]/evidence/route";
import { LEDGER_COLUMNS } from "@/domain/ledger";
import { copiedEvidenceId, copyEvidence, type EvidenceServices, evidenceThumbnail } from "@/lib/evidence";

class Chain {
  private readonly predicates: ((row: Row) => boolean)[] = [];
  private single = false;
  constructor(private readonly rows: Row[], readonly filters: string[]) {}
  select(): this { return this; }
  eq(column: string, value: unknown): this { this.filters.push(`${column}=${value}`); this.predicates.push(row => row[column] === value); return this; }
  in(column: string, values: unknown[]): this { this.predicates.push(row => values.includes(row[column])); return this; }
  order(): this { return this; }
  limit(): this { return this; }
  maybeSingle(): this { this.single = true; return this; }
  // biome-ignore lint/suspicious/noThenProperty: models the thenable PostgREST query builder of supabase-js.
  then<A>(resolve: (value: { data: unknown; error: { message: string } | null }) => A): Promise<A> {
    const rows = this.rows.filter(row => this.predicates.every(predicate => predicate(row)));
    return Promise.resolve({ data: this.single ? rows[0] ?? null : rows, error: null }).then(resolve);
  }
}

const USER = "10000000-0000-4000-8000-000000000001";
const TRADE = "a0000000-0000-4000-8000-000000000001";
const NEW_TRADE = "a0000000-0000-4000-8000-000000000002";
const EVIDENCE = "e0000000-0000-4000-8000-000000000001";
const PATH = `${USER}/${TRADE}/${EVIDENCE}`;

class UserDb {
  readonly filters: string[] = [];
  readonly failing = new Set<string>();
  readonly objects = new Map<string, Uint8Array>();
  schema: { data: unknown; error: { code?: string; message: string } | null } = { data: "2.0", error: null };
  user: { id: string } | null = { id: USER };
  readonly auth = { getUser: vi.fn(async () => ({ data: { user: this.user }, error: null })) };
  readonly storage = {
    from: (bucket: string) => ({
      download: vi.fn(async (path: string) => {
        const bytes = this.objects.get(`${bucket}:${path}`);
        return bytes ? { data: new Blob([new Uint8Array(bytes)]), error: null } : { data: null, error: { message: "SECRET object missing", statusCode: "404" } };
      }),
    }),
  };
  constructor(readonly tables: Record<string, Row[]> = {}) {}
  from(table: string) {
    if (this.failing.has(table)) return new FailingChain();
    return new Chain(this.tables[table] ?? [], this.filters);
  }
  async rpc(fn: string) {
    if (fn !== "trading_os_schema") throw new Error(`unexpected user rpc ${fn}`);
    return this.schema;
  }
}

class FailingChain {
  select(): this { return this; }
  eq(): this { return this; }
  maybeSingle(): this { return this; }
  // biome-ignore lint/suspicious/noThenProperty: models the thenable PostgREST query builder of supabase-js.
  then<A>(resolve: (value: { data: null; error: { message: string } }) => A): Promise<A> {
    return Promise.resolve({ data: null, error: { message: "SECRET relation detail" } }).then(resolve);
  }
}

class Trusted {
  readonly objects = new Map<string, Uint8Array>();
  uploadError: { message: string; statusCode?: string; status?: number } | null = null;
  removeError: { message: string } | null = null;
  registerResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };
  readonly upload = vi.fn(async (path: string, bytes: Uint8Array, _options: { contentType: string; upsert: boolean }) => {
    if (this.uploadError) return { data: null, error: this.uploadError };
    if (this.objects.has(path)) return { data: null, error: { message: "The resource already exists", statusCode: "409" } };
    this.objects.set(path, bytes);
    return { data: { path }, error: null };
  });
  readonly download = vi.fn(async (path: string) => {
    const bytes = this.objects.get(path);
    return bytes ? { data: new Blob([new Uint8Array(bytes)]), error: null } : { data: null, error: { message: "missing" } };
  });
  readonly remove = vi.fn(async (paths: string[]) => {
    if (this.removeError) return { data: null, error: this.removeError };
    for (const path of paths) this.objects.delete(path);
    return { data: [], error: null };
  });
  readonly rpc = vi.fn(async (_fn: string, _args: Row) => this.registerResult);
  readonly storage = { from: (_bucket: string) => ({ upload: this.upload, download: this.download, remove: this.remove }) };
}

let png: Buffer;
let bigPng: Buffer;
let log: MockInstance;
let user: UserDb;
let trusted: Trusted;

const context = (id = TRADE) => ({ params: Promise.resolve({ id }) });
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function upload(fields: Record<string, string> = {}, file: { bytes: Uint8Array; type: string; name: string } | null = { bytes: png, type: "image/png", name: "../../\u0007chart.png" }, origin = "http://localhost") {
  const form = new FormData();
  const values = { evidenceId: EVIDENCE, label: "PRE_ENTRY", captureMethod: "PASTE", ...fields };
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  if (file) form.set("file", new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  return new Request(`http://localhost/api/trades/${TRADE}/evidence`, { method: "POST", headers: { origin }, body: form });
}

function registered(replayed: boolean) {
  return { data: { id: EVIDENCE, tradeId: TRADE, phase: "PRE_ENTRY", stateAtCreation: "DRAFT", recordedAt: "2026-10-14T14:00:00.000Z", replayed }, error: null };
}

beforeEach(async () => {
  vi.clearAllMocks();
  png ??= await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer();
  bigPng ??= await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#204060" } }).png().toBuffer();
  log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  user = new UserDb({ trades: [{ id: TRADE, user_id: USER }] });
  trusted = new Trusted();
  trusted.registerResult = registered(false);
  m.session = user;
  m.trusted = trusted;
  m.trustedError = null;
});

afterEach(() => log.mockRestore());

const events = () => log.mock.calls.map(call => JSON.parse(String(call[0])).event);

// ---------------------------------------------------------------------------------------------------------------------
describe("POST /api/trades/[id]/evidence", () => {
  it("stores the image at {uid}/{trade}/{evidenceId} without overwrite and registers it for the verified user", async () => {
    const response = await POST(upload({ caption: "  London sweep  ", timeframe: "M5" }), context());
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ id: EVIDENCE, phase: "PRE_ENTRY", replayed: false });
    expect(trusted.upload).toHaveBeenCalledWith(PATH, expect.anything(), { contentType: "image/png", upsert: false });
    expect(trusted.rpc).toHaveBeenCalledWith("register_trade_evidence", {
      p_user_id: USER,
      p_record: {
        id: EVIDENCE, tradeId: TRADE, storagePath: PATH, label: "PRE_ENTRY", timeframe: "M5", caption: "London sweep", originalFilename: "../../chart.png",
        mimeType: "image/png", byteSize: png.length, sha256: sha(png), width: 8, height: 8, captureMethod: "PASTE",
      },
    });
    expect(user.filters).toEqual(expect.arrayContaining([`id=${TRADE}`, `user_id=${USER}`]));
    expect(m.revalidate).toHaveBeenCalledWith(`/trades/${TRADE}`);
  });

  it("treats a retry with the same evidence id and bytes as a replay", async () => {
    trusted.objects.set(PATH, png);
    trusted.registerResult = registered(true);
    const response = await POST(upload(), context());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: EVIDENCE, phase: "PRE_ENTRY", replayed: true });
    expect(trusted.download).toHaveBeenCalledWith(PATH);
    expect(trusted.remove).not.toHaveBeenCalled();
  });

  it("refuses an evidence id already holding different bytes, before registration", async () => {
    trusted.objects.set(PATH, Buffer.from("other image"));
    const response = await POST(upload(), context());
    expect(response.status).toBe(409);
    expect(trusted.rpc).not.toHaveBeenCalled();
    expect(trusted.objects.get(PATH)?.toString()).toBe("other image");
  });

  it("returns 409 at the evidence limit and removes the rejected object", async () => {
    trusted.registerResult = { data: null, error: { message: "EVIDENCE_LIMIT: A trade supports 24 active screenshots. Remove one before adding another." } };
    const response = await POST(upload(), context());
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("A trade supports 24 active screenshots. Remove one before adding another.");
    expect(trusted.remove).toHaveBeenCalledWith([PATH]);
    expect(trusted.objects.has(PATH)).toBe(false);
  });

  it("keeps the object when a lost registration response did register it", async () => {
    trusted.registerResult = { data: null, error: { message: "fetch failed" } };
    user.tables.trade_evidence = [{ id: EVIDENCE, storage_path: PATH, user_id: USER, phase: "PRE_ENTRY" }];
    const response = await POST(upload(), context());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: EVIDENCE, phase: "PRE_ENTRY", replayed: true });
    expect(trusted.remove).not.toHaveBeenCalled();
  });

  it("cleans up after a failed registration and logs fixed events only", async () => {
    trusted.registerResult = { data: null, error: { message: "SECRET internal registration detail" } };
    trusted.removeError = { message: "SECRET cleanup detail" };
    const response = await POST(upload(), context());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/SECRET|10000000/);
    expect(trusted.remove).toHaveBeenCalledWith([PATH]);
    expect(events()).toEqual(["storage_registration_failed", "storage_cleanup_failed", "request_failed"]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRET|10000000|a0000000/);
  });

  it("reports a storage outage without registering anything", async () => {
    trusted.uploadError = { message: "SECRET bucket detail", statusCode: "500" };
    const response = await POST(upload(), context());
    expect(response.status).toBe(503);
    expect(trusted.rpc).not.toHaveBeenCalled();
    expect(events()).toContain("storage_upload_failed");
    m.trustedError = new Error("Server storage credentials are not configured. Add SUPABASE_SECRET_KEY to .env.local and restart.");
    const misconfigured = await POST(upload(), context());
    expect(misconfigured.status).toBe(503);
    expect(await misconfigured.text()).not.toContain("SUPABASE_SECRET_KEY");
  });

  const rejected: [string, () => Request, number, string][] = [
    ["a cross-origin request", () => upload({}, undefined, "https://attacker.example"), 403, TRADE],
    ["a malformed trade id", () => upload(), 404, "not-a-uuid"],
    ["another user's trade", () => upload(), 404, NEW_TRADE],
    ["a label outside the list", () => upload({ label: "SELFIE" }), 400, TRADE],
    ["a missing evidence id", () => upload({ evidenceId: "" }), 400, TRADE],
    ["a client-claimed DUPLICATE capture", () => upload({ captureMethod: "DUPLICATE" }), 400, TRADE],
    ["a missing file", () => upload({}, null), 400, TRADE],
    ["bytes that do not match the type", () => upload({}, { bytes: png, type: "image/jpeg", name: "x.jpg" }), 400, TRADE],
    ["a truncated image", () => upload({}, { bytes: png.subarray(0, 40), type: "image/png", name: "x.png" }), 400, TRADE],
  ];
  it.each(rejected)("rejects %s before storage", async (_label, request, status, id) => {
    const response = await POST(request(), context(id));
    expect(response.status).toBe(status);
    expect(trusted.upload).not.toHaveBeenCalled();
    expect(trusted.rpc).not.toHaveBeenCalled();
  });

  it("rejects a body above 4 MiB + 64 KiB by header and by streamed size", async () => {
    const declared = upload();
    declared.headers.set("content-length", String(4 * 1024 * 1024 + 64 * 1024 + 1));
    expect((await POST(declared, context())).status).toBe(413);
    // A chunked body without Content-Length is counted while it streams.
    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let sent = 0; sent < 4 * 1024 * 1024 + 70 * 1024; sent += chunk.length) controller.enqueue(chunk);
        controller.close();
      },
    });
    const streamed = new Request(`http://localhost/api/trades/${TRADE}/evidence`, {
      method: "POST", headers: { origin: "http://localhost", "content-type": "multipart/form-data; boundary=x" }, body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(streamed.headers.get("content-length")).toBeNull();
    expect((await POST(streamed, context())).status).toBe(413);
    expect(trusted.upload).not.toHaveBeenCalled();
  });

  it("answers 401 without a session and refuses writes on an outdated schema", async () => {
    user.user = null;
    expect((await POST(upload(), context())).status).toBe(401);
    user.user = { id: USER };
    user.schema = { data: null, error: { code: "PGRST202", message: "missing" } };
    const outdated = await POST(upload(), context());
    expect(outdated.status).toBe(503);
    expect((await outdated.json()).error).toBe("Database update required — this deployment expects Trading OS database version 2.0. No changes were made.");
    expect(trusted.upload).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("GET /api/evidence/[id] and /api/screenshots/[id]", () => {
  beforeEach(() => {
    user.tables.trade_evidence = [{ id: EVIDENCE, user_id: USER, storage_path: PATH, mime_type: "image/png" }];
    user.tables.setup_screenshots = [{ id: EVIDENCE, user_id: USER, storage_path: PATH, mime_type: "image/png" }];
    user.objects.set(`trade-evidence:${PATH}`, bigPng);
    user.objects.set(`setup-screenshots:${PATH}`, png);
  });
  const get = (path: string) => new Request(`http://localhost${path}`);

  it("serves the owner's bytes privately, read with the user's session (RLS twice)", async () => {
    const response = await evidenceGet(get(`/api/evidence/${EVIDENCE}`), context(EVIDENCE));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(Buffer.from(await response.arrayBuffer()).equals(bigPng)).toBe(true);
    expect(user.filters).toEqual(expect.arrayContaining([`id=${EVIDENCE}`, `user_id=${USER}`]));
  });

  it("returns a WEBP thumbnail that fits inside 640×640 and never enlarges a small image", async () => {
    const thumb = await evidenceGet(get(`/api/evidence/${EVIDENCE}?variant=thumb`), context(EVIDENCE));
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/webp");
    const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 640, 480]);
    const legacy = await screenshotGet(get(`/api/screenshots/${EVIDENCE}?variant=thumb`), context(EVIDENCE));
    expect(legacy.headers.get("content-type")).toBe("image/webp");
    const small = await sharp(Buffer.from(await legacy.arrayBuffer())).metadata();
    expect([small.width, small.height]).toEqual([8, 8]);
    expect((await sharp(await evidenceThumbnail(bigPng)).metadata()).width).toBe(640);
  });

  it.each([
    ["a malformed id", "/api/evidence/nope", "nope", 404],
    ["an unknown or foreign id", `/api/evidence/${NEW_TRADE}`, NEW_TRADE, 404],
    ["an unknown variant", `/api/evidence/${EVIDENCE}?variant=original`, EVIDENCE, 400],
  ])("answers %s safely", async (_label, path, id, status) => {
    const response = await evidenceGet(get(path), context(id));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("hides storage and database details", async () => {
    user.objects.clear();
    const missing = await evidenceGet(get(`/api/evidence/${EVIDENCE}`), context(EVIDENCE));
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain("SECRET");
    user.failing.add("trade_evidence");
    const outage = await evidenceGet(get(`/api/evidence/${EVIDENCE}`), context(EVIDENCE));
    expect(outage.status).toBe(503);
    expect(await outage.text()).not.toContain("SECRET");
    user.user = null;
    expect((await evidenceGet(get(`/api/evidence/${EVIDENCE}`), context(EVIDENCE))).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("copy on duplicate (§7.4): only Before-entry evidence", () => {
  const SOURCE = TRADE;
  const PROPOSAL = "70000000-0000-4000-8000-000000000001";
  const id = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  function sourceLedger(): Row {
    const row: Row = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null]));
    return {
      ...row, id: SOURCE, account_id: "20000000-0000-4000-8000-000000000001", origin: "PLANNED", created_at: "2026-10-14T10:00:00.000Z", currency: "USD",
      revision_count: 1, latest_revision: 1, latest_proposal_id: PROPOSAL, latest_revision_at: "2026-10-14T10:00:00.000Z",
      plan_id: "80000000-0000-4000-8000-000000000001", locked_at: "2026-10-14T11:00:00.000Z", entered_at: "2026-10-14T12:00:00.000Z", entry_time_known: true,
      entry_recorded_at: "2026-10-14T12:30:00.000Z", entry_price: "1.1", quantity: "0.25", lifecycle: "LIVE", tags: [], evidence_count: 0, journal_count: 0, ai_review_count: 0,
    };
  }

  function evidence(n: number, phase: string, recordedAt: string, bytes: Buffer, extra: Row = {}): Row {
    return {
      id: id(n), trade_id: SOURCE, user_id: USER, storage_path: `${USER}/${SOURCE}/${id(n)}`, label: "PRE_ENTRY", timeframe: null, caption: null,
      original_filename: `${n}.png`, mime_type: "image/png", byte_size: bytes.length, sha256: sha(bytes), width: 8, height: 8, phase, recorded_at: recordedAt, ...extra,
    };
  }

  it("copies active pre-entry items (legacy into the V2 bucket) with deterministic ids and DUPLICATE provenance", async () => {
    const db = new UserDb({
      trade_ledger: [sourceLedger()],
      trades: [{ id: NEW_TRADE, user_id: USER, duplicated_from: SOURCE }],
      trade_revisions: [{ proposal_id: PROPOSAL, trade_id: SOURCE, user_id: USER }],
      trade_evidence: [
        evidence(1, "PRE_ENTRY", "2026-10-14T10:30:00.000Z", png),
        evidence(2, "PRE_ENTRY", "2026-10-14T12:10:00.000Z", png),
        evidence(3, "LIVE", "2026-10-14T12:40:00.000Z", png),
        evidence(4, "PRE_ENTRY", "2026-10-14T10:40:00.000Z", png),
      ],
      trade_evidence_labels: [{ id: 1, evidence_id: id(1), trade_id: SOURCE, user_id: USER, label: "HTF", timeframe: "H4", caption: "Daily bias" }],
      trade_evidence_removals: [{ evidence_id: id(4), trade_id: SOURCE, user_id: USER }],
      setup_screenshots: [
        { id: id(5), proposal_id: PROPOSAL, user_id: USER, role: "H1", storage_path: `${USER}/${PROPOSAL}/${id(5)}`, original_filename: "h1.png", mime_type: "image/png", byte_size: png.length, sha256: sha(png), width: 8, height: 8, uploaded_at: "2026-10-14T10:20:00.000Z" },
        { id: id(6), proposal_id: PROPOSAL, user_id: USER, role: "M5", storage_path: `${USER}/${PROPOSAL}/${id(6)}`, original_filename: "m5.png", mime_type: "image/png", byte_size: png.length, sha256: sha(png), width: 8, height: 8, uploaded_at: "2026-10-14T12:45:00.000Z" },
      ],
      setup_screenshot_removals: [],
    });
    db.objects.set(`trade-evidence:${USER}/${SOURCE}/${id(1)}`, png);
    db.objects.set(`setup-screenshots:${USER}/${PROPOSAL}/${id(5)}`, png);
    const stored: Row[] = [];
    const services: EvidenceServices = {
      upload: vi.fn(async () => ({ error: null })),
      download: vi.fn(async () => ({ data: null, error: { message: "unused" } })),
      remove: vi.fn(async () => ({ error: null })),
      register: vi.fn(async (_user, record) => {
        stored.push(record);
        return { data: { id: record.id, tradeId: NEW_TRADE, phase: "PRE_ENTRY", stateAtCreation: "DRAFT", recordedAt: "2026-10-14T13:00:00.000Z", replayed: false }, error: null };
      }),
      registeredPhase: vi.fn(async () => null),
    };
    expect(await copyEvidence({ db: db as never, userId: USER, services }, SOURCE, NEW_TRADE)).toEqual({ copied: 2, skipped: 0, failed: 0 });
    expect(stored).toEqual([
      expect.objectContaining({ id: copiedEvidenceId(NEW_TRADE, id(5)), tradeId: NEW_TRADE, label: "HTF", timeframe: "H1", captureMethod: "DUPLICATE", copiedFrom: id(5), sha256: sha(png), storagePath: `${USER}/${NEW_TRADE}/${copiedEvidenceId(NEW_TRADE, id(5))}` }),
      expect.objectContaining({ id: copiedEvidenceId(NEW_TRADE, id(1)), label: "HTF", timeframe: "H4", caption: "Daily bias", captureMethod: "DUPLICATE", copiedFrom: id(1) }),
    ]);
    expect(copiedEvidenceId(NEW_TRADE, id(1))).toBe(copiedEvidenceId(NEW_TRADE, id(1)));
    expect(copiedEvidenceId(NEW_TRADE, id(1))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("copies nothing into a trade that is not a duplicate of the source, and counts changed bytes as failures", async () => {
    const db = new UserDb({
      trade_ledger: [sourceLedger()], trades: [{ id: NEW_TRADE, user_id: USER, duplicated_from: null }], trade_revisions: [],
      trade_evidence: [evidence(1, "PRE_ENTRY", "2026-10-14T10:30:00.000Z", png)], trade_evidence_labels: [], trade_evidence_removals: [],
    });
    const services = { upload: vi.fn(), download: vi.fn(), remove: vi.fn(), register: vi.fn(), registeredPhase: vi.fn() } as unknown as EvidenceServices;
    expect(await copyEvidence({ db: db as never, userId: USER, services }, SOURCE, NEW_TRADE)).toEqual({ copied: 0, skipped: 0, failed: 0 });
    db.tables.trades = [{ id: NEW_TRADE, user_id: USER, duplicated_from: SOURCE }];
    db.objects.set(`trade-evidence:${USER}/${SOURCE}/${id(1)}`, Buffer.from("tampered"));
    expect(await copyEvidence({ db: db as never, userId: USER, services }, SOURCE, NEW_TRADE)).toEqual({ copied: 0, skipped: 0, failed: 1 });
    expect(services.upload).not.toHaveBeenCalled();
  });
});
