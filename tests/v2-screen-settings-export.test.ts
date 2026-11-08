import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildDataExport, EXPORT_COPY, ExportCancelled, ExportError, type ExportProgress, type ExportTableNames, type Fetcher, formatBytes, progressView,
  screenshotFileName, screenshotPath,
} from "@/components/settings/export-archive";
import { readZip } from "@/lib/zip";

// Settings → Data → "Download my data (.zip)" (docs/V2_ARCHITECTURE.md §10.5): the browser pages every table through
// /api/export, adds the trades CSV and, when asked, every screenshot verified against the manifest's sha256, then
// builds a stored ZIP. The fetcher below plays the export and evidence routes; no network, no database.

const USER = { id: "10000000-0000-4000-8000-000000000001", email: "qa.settings@example.test" };
const SHOT_A = "50000000-0000-4000-8000-00000000000a";
const SHOT_B = "50000000-0000-4000-8000-00000000000b";
const SHOT_C = "50000000-0000-4000-8000-00000000000c";
const TRADE = "a0000000-0000-4000-8000-000000000001";
const EXPORTED_AT = "2026-10-23T14:05:00.000Z";

const TABLES: ExportTableNames = {
  core: ["accounts", "account_profiles"],
  trades: ["trades"],
  ai: ["ai_usage_records"],
  "evidence-manifest": ["trade_evidence", "setup_screenshots"],
};

const bytesA = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const bytesB = new Uint8Array([0xff, 0xd8, 0xff, 9, 9, 9]);
const bytesC = new Uint8Array([0x52, 0x49, 0x46, 0x46, 7]);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function manifestItem(id: string, kind: "V2" | "LEGACY", mimeType: string, bytes: Uint8Array, recordedAt: string, extra: Record<string, unknown> = {}) {
  return {
    id, kind, tradeId: TRADE, proposalId: null, label: "ENTRY", role: null, timeframe: "M5", caption: null, originalFilename: "chart.png", mimeType,
    byteSize: bytes.length, width: 10, height: 10, sha256: sha(bytes), recordedAt, timing: "BEFORE_ENTRY", removedAt: null, captureMethod: "PASTE",
    copiedFrom: null, downloadPath: `/api/${kind === "V2" ? "evidence" : "screenshots"}/${id}`, ...extra,
  };
}

function page(part: string, table: string, rows: unknown[], next: string | null, manifest?: unknown[]) {
  return { exportedAt: EXPORTED_AT, schema: "2.0", part, user: USER, tables: { [table]: rows }, ...(manifest ? { manifest } : {}), next };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Scenario {
  images?: Record<string, Response | (() => Response)>;
  exportStatus?: number;
  /** Override one export URL. */
  override?: (url: URL) => Response | null;
}

/** The export and evidence routes for one synthetic user. */
function routes(scenario: Scenario = {}) {
  const calls: string[] = [];
  const fetcher = vi.fn<Fetcher>(async (input, init) => {
    calls.push(input);
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
    const url = new URL(input, "http://127.0.0.1:3000");
    const overridden = scenario.override?.(url);
    if (overridden) return overridden;
    if (url.pathname === "/api/export") {
      if (scenario.exportStatus) return json({ error: "nope" }, scenario.exportStatus);
      const part = url.searchParams.get("part");
      const table = url.searchParams.get("table");
      const after = url.searchParams.get("after");
      if (part === "trades-csv") return new Response("﻿id,symbol\r\n\"t1\",\"EURUSD\"\r\n", { headers: { "Content-Type": "text/csv" } });
      if (part === "core" && table === "accounts") {
        return after === null ? json(page("core", "accounts", [{ id: "acc-1" }], "cursor-1")) : json(page("core", "accounts", [{ id: "acc-2" }], null));
      }
      if (part === "evidence-manifest" && table === "trade_evidence") {
        return json(page(part, table, [{ id: SHOT_B }, { id: SHOT_A }], null, [
          manifestItem(SHOT_B, "V2", "image/jpeg", bytesB, "2026-10-14T13:10:00.000Z"),
          manifestItem(SHOT_A, "V2", "image/png", bytesA, "2026-10-14T13:00:00.000Z", { removedAt: "2026-10-15T08:00:00.000Z" }),
        ]));
      }
      if (part === "evidence-manifest" && table === "setup_screenshots") {
        return json(page(part, table, [{ id: SHOT_C }], null, [manifestItem(SHOT_C, "LEGACY", "image/webp", bytesC, "2026-10-14T12:00:00.000Z")]));
      }
      return json(page(part ?? "", table ?? "", [{ id: `${table}-row` }], null));
    }
    const image = scenario.images?.[url.pathname];
    if (image) return typeof image === "function" ? image() : image;
    if (url.pathname === `/api/evidence/${SHOT_A}`) return new Response(bytesA);
    if (url.pathname === `/api/evidence/${SHOT_B}`) return new Response(bytesB);
    if (url.pathname === `/api/screenshots/${SHOT_C}`) return new Response(bytesC);
    return json({ error: "Image not found" }, 404);
  });
  return { fetcher, calls };
}

const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe("buildDataExport", () => {
  it("pages every table, reassembles each part and verifies every screenshot into one archive", async () => {
    const { fetcher, calls } = routes();
    const progress: ExportProgress[] = [];
    const result = await buildDataExport({ tables: TABLES, includeScreenshots: true, fetcher, onProgress: event => progress.push(event) });

    expect(result.fileName).toBe("trading-os-export-2026-10-23.zip");
    expect(result.tables).toBe(6);
    expect(result.screenshots).toEqual({ expected: 3, included: 3, issues: [] });
    // Keyset paging follows the cursor; nothing but the owner routes is ever requested.
    expect(calls).toContain("/api/export?part=core&table=accounts&after=cursor-1");
    expect(calls.every(call => call.startsWith("/api/export?") || /^\/api\/(evidence|screenshots)\/[0-9a-f-]{36}$/.test(call))).toBe(true);

    const entries = new Map(readZip(result.archive).map(entry => [entry.name, entry.data]));
    const root = "trading-os-export-2026-10-23";
    expect([...entries.keys()]).toEqual([
      `${root}/README.txt`, `${root}/core.json`, `${root}/trades.json`, `${root}/ai.json`, `${root}/evidence-manifest.json`, `${root}/trades.csv`,
      `${root}/screenshots/${SHOT_C}.webp`, `${root}/screenshots/${SHOT_A}.png`, `${root}/screenshots/${SHOT_B}.jpg`,
    ]);
    const core = JSON.parse(text(entries.get(`${root}/core.json`) as Uint8Array));
    expect(core).toMatchObject({ exportedAt: EXPORTED_AT, schema: "2.0", part: "core", user: USER });
    expect(core.tables.accounts).toEqual([{ id: "acc-1" }, { id: "acc-2" }]);
    expect(core.tables.account_profiles).toEqual([{ id: "account_profiles-row" }]);
    expect(core).not.toHaveProperty("next");
    // The manifest of both evidence tables, merged in the whole-part order (recorded time, then id).
    const manifest = JSON.parse(text(entries.get(`${root}/evidence-manifest.json`) as Uint8Array));
    expect(manifest.manifest.map((item: { id: string }) => item.id)).toEqual([SHOT_C, SHOT_A, SHOT_B]);
    expect(manifest.manifest[1].removedAt).toBe("2026-10-15T08:00:00.000Z");
    expect(entries.get(`${root}/screenshots/${SHOT_A}.png`)).toEqual(bytesA);
    expect(text(entries.get(`${root}/trades.csv`) as Uint8Array)).toContain("EURUSD");
    const readme = text(entries.get(`${root}/README.txt`) as Uint8Array);
    expect(readme).toContain("Screenshots: 3 of 3 included, each verified against its recorded SHA-256 fingerprint.");
    expect(readme).toContain(`Exported at: ${EXPORTED_AT} (UTC)`);

    expect(progress[0]).toEqual({ step: "records", done: 0, total: 7, part: "core" });
    expect(progress).toContainEqual({ step: "records", done: 7, total: 7, part: "trades-csv" });
    expect(progress).toContainEqual({ step: "screenshots", done: 3, total: 3 });
    expect(progress.at(-1)).toEqual({ step: "archive" });
  });

  it("leaves screenshots out when not requested, but keeps their records", async () => {
    const { fetcher, calls } = routes();
    const result = await buildDataExport({ tables: TABLES, includeScreenshots: false, fetcher });
    expect(result.screenshots).toBeNull();
    expect(calls.some(call => call.startsWith("/api/evidence") || call.startsWith("/api/screenshots"))).toBe(false);
    const names = readZip(result.archive).map(entry => entry.name);
    expect(names.some(name => name.includes("/screenshots/"))).toBe(false);
    expect(text(readZip(result.archive)[0].data)).toContain("Screenshots were not included in this export.");
  });

  it("never packages bytes that differ from the recorded fingerprint and reports missing images", async () => {
    const tampered = new Uint8Array(bytesB);
    tampered[3] = 0;
    const { fetcher } = routes({
      images: { [`/api/evidence/${SHOT_B}`]: () => new Response(tampered), [`/api/screenshots/${SHOT_C}`]: () => json({ error: "Saved image is unavailable" }, 404) },
    });
    const result = await buildDataExport({ tables: TABLES, includeScreenshots: true, fetcher });
    expect(result.screenshots?.included).toBe(1);
    expect(result.screenshots?.issues).toEqual([
      { id: SHOT_C, problem: "MISSING", detail: "The image could not be downloaded (HTTP 404)." },
      { id: SHOT_B, problem: "MISMATCH", detail: "The SHA-256 fingerprint differs from the one recorded." },
    ]);
    const entries = readZip(result.archive);
    expect(entries.some(entry => entry.name.endsWith(`${SHOT_B}.jpg`))).toBe(false);
    const issues = entries.find(entry => entry.name.endsWith("screenshots/issues.json"));
    expect(JSON.parse(text(issues?.data as Uint8Array))).toHaveLength(2);
  });

  it("treats a size mismatch as a mismatch without hashing", async () => {
    const digest = vi.fn(async (bytes: Uint8Array) => sha(bytes));
    const { fetcher } = routes({ images: { [`/api/evidence/${SHOT_A}`]: () => new Response(new Uint8Array([1, 2])) } });
    const result = await buildDataExport({ tables: TABLES, includeScreenshots: true, fetcher, digest });
    expect(result.screenshots?.issues).toEqual([{ id: SHOT_A, problem: "MISMATCH", detail: `Downloaded 2 bytes; ${bytesA.length} were recorded.` }]);
    expect(digest).toHaveBeenCalledTimes(2);
  });

  it("refuses a manifest download route that is not the owner route of that exact item", () => {
    expect(screenshotPath({ id: SHOT_A, kind: "V2", downloadPath: `/api/evidence/${SHOT_A}` })).toBe(`/api/evidence/${SHOT_A}`);
    expect(screenshotPath({ id: SHOT_A, kind: "V2", downloadPath: `/api/evidence/${SHOT_B}` })).toBeNull();
    expect(screenshotPath({ id: SHOT_A, kind: "LEGACY", downloadPath: `/api/evidence/${SHOT_A}` })).toBeNull();
    expect(screenshotPath({ id: SHOT_A, kind: "V2", downloadPath: `https://elsewhere.example/api/evidence/${SHOT_A}` })).toBeNull();
    expect(screenshotPath({ id: SHOT_A, kind: "V2", downloadPath: `/api/evidence/${SHOT_A}?variant=thumb` })).toBeNull();
    expect(screenshotFileName({ id: SHOT_A, mimeType: "image/jpeg" })).toBe(`screenshots/${SHOT_A}.jpg`);
  });

  it.each([
    [401, EXPORT_COPY.session],
    [403, EXPORT_COPY.session],
    [503, EXPORT_COPY.unavailable],
    [400, EXPORT_COPY.unavailable],
  ])("maps HTTP %i of the export route to human copy", async (status, copy) => {
    const { fetcher } = routes({ exportStatus: status });
    await expect(buildDataExport({ tables: TABLES, includeScreenshots: true, fetcher })).rejects.toThrow(new ExportError(copy));
  });

  it("stops when the session ends during the screenshot downloads", async () => {
    const { fetcher } = routes({ images: { [`/api/evidence/${SHOT_A}`]: () => json({ error: "Authentication required" }, 401) } });
    await expect(buildDataExport({ tables: TABLES, includeScreenshots: true, fetcher })).rejects.toThrow(EXPORT_COPY.session);
  });

  it("rejects pages it does not recognize and cursors that do not advance", async () => {
    const wrongPart = routes({ override: url => (url.searchParams.get("table") === "trades" ? json(page("core", "trades", [], null)) : null) });
    await expect(buildDataExport({ tables: TABLES, includeScreenshots: false, fetcher: wrongPart.fetcher })).rejects.toThrow(EXPORT_COPY.format);
    const looping = routes({ override: url => (url.searchParams.get("table") === "trades" ? json(page("trades", "trades", [{ id: "x" }], "same")) : null) });
    await expect(buildDataExport({ tables: TABLES, includeScreenshots: false, fetcher: looping.fetcher })).rejects.toThrow(EXPORT_COPY.format);
    const html = routes({ override: url => (url.searchParams.get("table") === "trades" ? new Response("<html>login</html>", { status: 200 }) : null) });
    await expect(buildDataExport({ tables: TABLES, includeScreenshots: false, fetcher: html.fetcher })).rejects.toThrow(EXPORT_COPY.format);
  });

  it("reports a dropped connection and a cancellation distinctly", async () => {
    const offline: Fetcher = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(buildDataExport({ tables: TABLES, includeScreenshots: false, fetcher: offline })).rejects.toThrow(EXPORT_COPY.network);

    const controller = new AbortController();
    const { fetcher } = routes({
      override: url => {
        if (url.searchParams.get("table") === "trades") controller.abort();
        return null;
      },
    });
    await expect(buildDataExport({ tables: TABLES, includeScreenshots: true, fetcher, signal: controller.signal })).rejects.toBeInstanceOf(ExportCancelled);
  });

  it("refuses screenshots larger than one archive can hold before downloading any", async () => {
    const { fetcher, calls } = routes();
    await expect(buildDataExport({ tables: TABLES, includeScreenshots: true, fetcher, maxScreenshotBytes: 10 })).rejects.toThrow(EXPORT_COPY.tooLarge);
    expect(calls.some(call => call.startsWith("/api/evidence"))).toBe(false);
  });
});

describe("export progress copy", () => {
  it("names the step, the part being read and the screenshot count", () => {
    expect(progressView({ step: "records", done: 3, total: 7, part: "trades" }, true)).toEqual({
      step: "Step 1 of 3", title: "Reading your records", detail: "42% · Trades and journal", fraction: 3 / 7,
    });
    expect(progressView({ step: "records", done: 7, total: 7, part: "trades-csv" }, false).detail).toBe("100% · Trades spreadsheet");
    expect(progressView({ step: "screenshots", done: 34, total: 155 }, true)).toMatchObject({ step: "Step 2 of 3", detail: "34 of 155 screenshots" });
    expect(progressView({ step: "archive" }, false)).toMatchObject({ step: "Step 2 of 2", title: "Building the archive", fraction: null });
  });

  it("formats archive sizes in decimal units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(32_400_000)).toBe("32.4 MB");
    expect(formatBytes(1_250_000_000)).toBe("1.3 GB");
    expect(formatBytes(150_000)).toBe("150 kB");
  });
});
