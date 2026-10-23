import { afterEach, describe, expect, it, vi } from "vitest";
import { createStagedItem } from "@/components/evidence/stager-model";
import type { StagedEvidence } from "@/components/evidence/types";
import { UPLOAD_COPY, evidenceUploadForm, evidenceUploadUrl, uploadFailure, uploadStagedEvidence, uploadSummary } from "@/components/evidence/upload";

const TRADE = "7d3c2f9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const NO_WAIT = [0, 0];

let counter = 0;
function item(overrides: Partial<StagedEvidence> = {}): StagedEvidence {
  counter += 1;
  const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  const file = new File([new Uint8Array([137, 80, 78, 71, counter])], `chart-${counter}.png`, { type: "image/png" });
  return { ...createStagedItem(file, "PASTE", "MANAGEMENT", { localId: `local-${counter}`, evidenceId: id, previewUrl: `blob:${counter}` }), ...overrides };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Call {
  url: string;
  init: RequestInit;
  form: FormData;
}

function mockFetch(...responses: (Response | Error | (() => Promise<Response>))[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, form: init?.body as FormData });
    const next = responses.shift();
    if (next === undefined) throw new Error("Unexpected request");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("upload request (spec §7.1–7.2)", () => {
  it("posts one multipart image to the trade's evidence route", () => {
    expect(evidenceUploadUrl(TRADE)).toBe(`/api/trades/${TRADE}/evidence`);
    expect(evidenceUploadUrl("a/b")).toBe("/api/trades/a%2Fb/evidence");
    const staged = item({ label: "ENTRY", timeframe: "M5", caption: "  Sweep of the Asian low  ", captureMethod: "DROP" });
    const form = evidenceUploadForm(staged);
    expect([...form.keys()]).toEqual(["evidenceId", "label", "timeframe", "caption", "captureMethod", "file"]);
    expect(form.get("evidenceId")).toBe(staged.evidenceId);
    expect(form.get("label")).toBe("ENTRY");
    expect(form.get("timeframe")).toBe("M5");
    expect(form.get("caption")).toBe("Sweep of the Asian low");
    expect(form.get("captureMethod")).toBe("DROP");
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe(staged.file.name);
  });

  it("leaves out an empty timeframe and caption", () => {
    const form = evidenceUploadForm(item({ timeframe: null, caption: "   " }));
    expect(form.has("timeframe")).toBe(false);
    expect(form.has("caption")).toBe(false);
  });

  it("sends same-origin POST requests that are never cached", async () => {
    const { calls } = mockFetch(json(201, { id: "server-id", phase: "LIVE", replayed: false }));
    const staged = item();
    const results = await uploadStagedEvidence(TRADE, [staged], { retryDelaysMs: NO_WAIT });
    expect(results).toEqual([{ localId: staged.localId, ok: true, id: "server-id" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`/api/trades/${TRADE}/evidence`);
    expect(calls[0].init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(calls[0].form.get("evidenceId")).toBe(staged.evidenceId);
  });
});

describe("sequential uploads", () => {
  it("sends one image at a time, in order, and reports progress", async () => {
    let releaseFirst: (response: Response) => void = () => undefined;
    const first = () => new Promise<Response>(resolve => { releaseFirst = resolve; });
    const { fetch, calls } = mockFetch(first, json(201, { id: "b" }));
    const items = [item(), item()];
    const progress: [number, number][] = [];
    const started: string[] = [];
    const running = uploadStagedEvidence(TRADE, items, { retryDelaysMs: NO_WAIT, onProgress: (done, total) => progress.push([done, total]), onItemStart: id => started.push(id) });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    // The second request waits for the first.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fetch).toHaveBeenCalledTimes(1);
    releaseFirst(json(201, { id: "a" }));
    const results = await running;
    expect(calls.map(call => call.form.get("evidenceId"))).toEqual(items.map(entry => entry.evidenceId));
    expect(results.map(result => result.id)).toEqual(["a", "b"]);
    expect(progress).toEqual([[0, 2], [1, 2], [2, 2]]);
    expect(started).toEqual(items.map(entry => entry.localId));
  });

  it("skips images that are already saved without a request", async () => {
    const { calls } = mockFetch(json(201, { id: "fresh" }));
    const saved = item({ status: "uploaded" });
    const fresh = item();
    const progress: [number, number][] = [];
    const results = await uploadStagedEvidence(TRADE, [saved, fresh], { retryDelaysMs: NO_WAIT, onProgress: (done, total) => progress.push([done, total]) });
    expect(calls).toHaveLength(1);
    expect(results).toEqual([{ localId: saved.localId, ok: true, id: saved.evidenceId }, { localId: fresh.localId, ok: true, id: "fresh" }]);
    expect(progress).toEqual([[0, 1], [1, 1]]);
  });

  it("falls back to the client evidence id when the response has no id", async () => {
    mockFetch(new Response("", { status: 201 }));
    const staged = item();
    expect(await uploadStagedEvidence(TRADE, [staged], { retryDelaysMs: NO_WAIT })).toEqual([{ localId: staged.localId, ok: true, id: staged.evidenceId }]);
  });
});

describe("idempotent retries", () => {
  it("retries a temporary server error with the same evidence id", async () => {
    const { calls } = mockFetch(json(503, { error: "Private storage upload failed. Please try again." }), json(201, { id: "saved" }));
    const staged = item();
    const results = await uploadStagedEvidence(TRADE, [staged], { retryDelaysMs: NO_WAIT });
    expect(results[0]).toEqual({ localId: staged.localId, ok: true, id: "saved" });
    expect(calls).toHaveLength(2);
    expect(calls.map(call => call.form.get("evidenceId"))).toEqual([staged.evidenceId, staged.evidenceId]);
  });

  it("retries a dropped connection, then stops the batch with connection copy", async () => {
    const { calls } = mockFetch(new TypeError("Failed to fetch"), new TypeError("Failed to fetch"), new TypeError("Failed to fetch"));
    const [first, second] = [item(), item()];
    const settled: string[] = [];
    const results = await uploadStagedEvidence(TRADE, [first, second], { retryDelaysMs: NO_WAIT, onItemSettled: result => settled.push(result.localId) });
    expect(calls).toHaveLength(3);
    expect(results).toEqual([
      { localId: first.localId, ok: false, error: UPLOAD_COPY.network },
      { localId: second.localId, ok: false, error: UPLOAD_COPY.network },
    ]);
    expect(settled).toEqual([first.localId, second.localId]);
  });

  it("gives up after the retries of a server error and continues with the next image", async () => {
    const { calls } = mockFetch(json(500, { error: "The request failed. Please try again." }), json(502, {}), json(504, {}), json(201, { id: "next" }));
    const [first, second] = [item(), item()];
    const results = await uploadStagedEvidence(TRADE, [first, second], { retryDelaysMs: NO_WAIT });
    expect(calls).toHaveLength(4);
    expect(results[0]).toEqual({ localId: first.localId, ok: false, error: UPLOAD_COPY.unavailable });
    expect(results[1]).toEqual({ localId: second.localId, ok: true, id: "next" });
  });

  it("stops before the next request when cancelled", async () => {
    mockFetch();
    const controller = new AbortController();
    controller.abort();
    const staged = item();
    expect(await uploadStagedEvidence(TRADE, [staged], { signal: controller.signal })).toEqual([{ localId: staged.localId, ok: false, error: UPLOAD_COPY.cancelled }]);
  });
});

describe("human error copy", () => {
  it.each([
    [400, "File bytes do not match PNG, JPEG or WEBP type", UPLOAD_COPY.invalidImage, false],
    [400, "The screenshot details were not accepted. Check the label, timeframe and caption.", UPLOAD_COPY.invalidDetails, false],
    [401, "Sign in required", UPLOAD_COPY.session, true],
    [403, "Same-origin request required", UPLOAD_COPY.blocked, true],
    [404, "Trade not found", UPLOAD_COPY.tradeMissing, true],
    [409, "A trade supports 24 active screenshots. Remove one before adding another.", UPLOAD_COPY.limit, true],
    [409, "This upload id was already used for a different image. Stage the image again.", UPLOAD_COPY.conflict, false],
    [413, "Upload exceeds the size limit", UPLOAD_COPY.tooLarge, false],
    [418, null, UPLOAD_COPY.failed, false],
  ] as const)("%i %s", (status, server, message, stop) => {
    const failure = uploadFailure(status, server);
    expect(failure.message).toBe(message);
    expect(failure.stop).toBe(stop);
    expect(failure.retry).toBe(false);
  });

  it("retries 408, 425, 429 and 5xx responses", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) expect(uploadFailure(status, null)).toEqual({ message: UPLOAD_COPY.unavailable, retry: true, stop: false });
  });

  it("never shows server text", () => {
    for (const message of Object.values(UPLOAD_COPY)) {
      expect(message).not.toMatch(/Same-origin|Trade not found|upload id|Private storage|bytes do not match/);
      expect(message).toMatch(/\.$/);
    }
  });

  it("stops the batch at the screenshot limit and fails the rest without requests", async () => {
    const { calls } = mockFetch(json(201, { id: "a" }), json(409, { error: "A trade supports 24 active screenshots. Remove one before adding another." }));
    const items = [item(), item(), item()];
    const results = await uploadStagedEvidence(TRADE, items, { retryDelaysMs: NO_WAIT });
    expect(calls).toHaveLength(2);
    expect(results.map(result => result.ok)).toEqual([true, false, false]);
    expect(results[1].error).toBe(UPLOAD_COPY.limit);
    expect(results[2].error).toBe(UPLOAD_COPY.limit);
  });

  it("continues after a problem with one image", async () => {
    const { calls } = mockFetch(json(413, { error: "Upload exceeds the size limit" }), json(400, { error: "Image cannot be fully decoded" }), json(201, { id: "c" }));
    const results = await uploadStagedEvidence(TRADE, [item(), item(), item()], { retryDelaysMs: NO_WAIT });
    expect(calls).toHaveLength(3);
    expect(results.map(result => result.error ?? result.id)).toEqual([UPLOAD_COPY.tooLarge, UPLOAD_COPY.invalidImage, "c"]);
  });

  it("stops when the session ended or the trade is gone", async () => {
    mockFetch(json(401, { error: "Sign in required" }));
    const signedOut = await uploadStagedEvidence(TRADE, [item(), item()], { retryDelaysMs: NO_WAIT });
    expect(signedOut.map(result => result.error)).toEqual([UPLOAD_COPY.session, UPLOAD_COPY.session]);
    mockFetch(json(404, { error: "Trade not found" }));
    const missing = await uploadStagedEvidence(TRADE, [item(), item()], { retryDelaysMs: NO_WAIT });
    expect(missing.map(result => result.error)).toEqual([UPLOAD_COPY.tradeMissing, UPLOAD_COPY.tradeMissing]);
  });

  it("summarises a run in one sentence", () => {
    expect(uploadSummary([{ localId: "a", ok: true }, { localId: "b", ok: true }]).message).toBe("2 screenshots saved.");
    expect(uploadSummary([{ localId: "a", ok: true }, { localId: "b", ok: false, error: UPLOAD_COPY.tooLarge }])).toEqual({
      saved: 1, failed: 1, message: `1 screenshot saved. 1 screenshot wasn't saved: ${UPLOAD_COPY.tooLarge}`,
    });
    expect(uploadSummary([{ localId: "a", ok: false, error: UPLOAD_COPY.network }, { localId: "b", ok: false, error: UPLOAD_COPY.network }]).message).toBe(
      `2 screenshots weren't saved: ${UPLOAD_COPY.network}`,
    );
  });
});
