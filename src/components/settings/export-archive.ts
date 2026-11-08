import { z } from "zod";
import { compareInstants } from "@/domain/time-display";
import { createZip, type ZipEntryInput } from "@/lib/zip";

/**
 * "Download my data (.zip)" (docs/V2_ARCHITECTURE.md §10.5), built entirely in the browser:
 *
 *   1. every table of every JSON part is read page by page through `GET /api/export?part=…&table=…[&after=…]` (the
 *      user's own session, keyset pages of at most ~3 MB, so no response limit can truncate it), and reassembled into
 *      one document per part, exactly the shape the whole-part response has;
 *   2. the trades spreadsheet (`part=trades-csv`);
 *   3. optionally every screenshot through the owner-only evidence routes, each checked against the byte size and
 *      SHA-256 fingerprint recorded in the manifest (a mismatch is reported and never packaged as if it were genuine);
 *   4. a stored ZIP (src/lib/zip.ts) with a README.
 *
 * Client-safe: no server imports. The fetch function, digest and clock are injectable for tests.
 */

export const EXPORT_JSON_PARTS = ["core", "trades", "ai", "evidence-manifest"] as const;
export type ExportJsonPart = (typeof EXPORT_JSON_PARTS)[number];
/** Table names of each JSON part, in export order (the server page passes `EXPORT_TABLES` from src/lib/export.ts). */
export type ExportTableNames = Readonly<Record<ExportJsonPart, readonly string[]>>;

export const PART_LABELS: Readonly<Record<ExportJsonPart, string>> = Object.freeze({
  core: "Accounts and settings",
  trades: "Trades and journal",
  ai: "AI history",
  "evidence-manifest": "Screenshot records",
});

export const EXPORT_COPY = {
  session: "Your session has ended. Sign in again, then start the export again. Nothing was downloaded.",
  unavailable: "Your data could not be read right now. Nothing was changed and nothing was downloaded. Please try again.",
  network: "The connection dropped during the export. Nothing was downloaded. Check your connection and try again.",
  format: "The export returned data this page doesn't recognize. Nothing was downloaded. Reload the page and try again.",
  noDigest: "This browser can't verify screenshots on this connection. Export without screenshots, or open Trading OS over HTTPS.",
  tooLarge: "Your screenshots are larger than a browser can package at once. Export without screenshots: their records are still included.",
  archive: "The archive could not be built. Nothing was downloaded. Try again, or export without screenshots.",
} as const;

/** A failure with human copy; nothing was downloaded. */
export class ExportError extends Error {
  override name = "ExportError";
}

/** The person cancelled the export. */
export class ExportCancelled extends Error {
  override name = "ExportCancelled";
  constructor() {
    super("Export cancelled.");
  }
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DOWNLOAD_PATH = new RegExp(`^/api/(evidence|screenshots)/(${UUID})$`);
const MIME_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

/** One evidence manifest item; every other field the server sends is kept as is. */
const manifestItemSchema = z.looseObject({
  id: z.uuid(),
  kind: z.enum(["V2", "LEGACY"]),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  byteSize: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  recordedAt: z.string().min(1),
  removedAt: z.string().nullable(),
  downloadPath: z.string(),
});
export type ExportManifestItem = z.output<typeof manifestItemSchema>;

const rowSchema = z.record(z.string(), z.unknown());
const pageSchema = z.object({
  exportedAt: z.string().min(1),
  schema: z.string().min(1),
  part: z.string(),
  user: z.object({ id: z.string(), email: z.string().nullable() }),
  tables: z.record(z.string(), z.array(rowSchema)),
  manifest: z.array(manifestItemSchema).optional(),
  next: z.string().min(1).nullable(),
});
type ExportPage = z.output<typeof pageSchema>;

/** The reassembled document of one JSON part (the whole-part response shape). */
export interface ExportPartDocument {
  exportedAt: string;
  schema: string;
  part: ExportJsonPart;
  user: { id: string; email: string | null };
  tables: Record<string, Record<string, unknown>[]>;
  manifest?: ExportManifestItem[];
}

export type ExportProgress =
  | { step: "records"; done: number; total: number; part: ExportJsonPart | "trades-csv" }
  | { step: "screenshots"; done: number; total: number }
  | { step: "archive" };

export interface ScreenshotIssue {
  id: string;
  /** MISSING: the image could not be downloaded; MISMATCH: its bytes differ from the recorded size or fingerprint. */
  problem: "MISSING" | "MISMATCH";
  detail: string;
}

export interface ExportScreenshotSummary {
  expected: number;
  included: number;
  issues: ScreenshotIssue[];
}

export interface ExportResult {
  fileName: string;
  archive: Uint8Array;
  tables: number;
  rows: number;
  /** Null when screenshots were not requested. */
  screenshots: ExportScreenshotSummary | null;
}

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface ExportOptions {
  tables: ExportTableNames;
  includeScreenshots: boolean;
  fetcher?: Fetcher;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
  /** Lower-case hex SHA-256 of the bytes; defaults to Web Crypto. */
  digest?: (bytes: Uint8Array) => Promise<string>;
  /** Parallel screenshot downloads. */
  concurrency?: number;
  /** Largest total screenshot size packaged in one archive (a stored ZIP without ZIP64 stays below 4 GiB). */
  maxScreenshotBytes?: number;
}

const MAX_PAGES_PER_TABLE = 100_000;
const DEFAULT_CONCURRENCY = 4;
export const MAX_SCREENSHOT_BYTES = 3_500_000_000;

function cancelled(signal: AbortSignal | undefined, error?: unknown): boolean {
  return Boolean(signal?.aborted) || (error instanceof DOMException && error.name === "AbortError");
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ExportCancelled();
}

function statusCopy(status: number): string {
  return status === 401 || status === 403 ? EXPORT_COPY.session : EXPORT_COPY.unavailable;
}

async function request(fetcher: Fetcher, url: string, accept: string, signal: AbortSignal | undefined): Promise<Response> {
  throwIfCancelled(signal);
  let response: Response;
  try {
    response = await fetcher(url, { method: "GET", credentials: "same-origin", cache: "no-store", headers: { Accept: accept }, signal });
  } catch (error) {
    if (cancelled(signal, error)) throw new ExportCancelled();
    throw new ExportError(EXPORT_COPY.network);
  }
  return response;
}

async function readBody<T>(read: () => Promise<T>, signal: AbortSignal | undefined, failure: string): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (cancelled(signal, error)) throw new ExportCancelled();
    throw new ExportError(failure);
  }
}

function exportUrl(part: string, table?: string, after?: string | null): string {
  const params = new URLSearchParams({ part });
  if (table !== undefined) params.set("table", table);
  if (after) params.set("after", after);
  return `/api/export?${params}`;
}

async function readPage(fetcher: Fetcher, part: ExportJsonPart, table: string, after: string | null, signal: AbortSignal | undefined): Promise<ExportPage> {
  const response = await request(fetcher, exportUrl(part, table, after), "application/json", signal);
  if (!response.ok) throw new ExportError(statusCopy(response.status));
  const body = await readBody(() => response.json() as Promise<unknown>, signal, EXPORT_COPY.format);
  const page = pageSchema.safeParse(body);
  if (!page.success || page.data.part !== part || !Object.hasOwn(page.data.tables, table)) throw new ExportError(EXPORT_COPY.format);
  return page.data;
}

/** Every row of one table (and, for evidence tables, the manifest items of those rows). */
async function readTable(
  fetcher: Fetcher, part: ExportJsonPart, table: string, signal: AbortSignal | undefined,
): Promise<{ first: ExportPage; rows: Record<string, unknown>[]; manifest: ExportManifestItem[] }> {
  const rows: Record<string, unknown>[] = [];
  const manifest: ExportManifestItem[] = [];
  const seen = new Set<string>();
  let first: ExportPage | null = null;
  let after: string | null = null;
  for (let count = 0; count < MAX_PAGES_PER_TABLE; count += 1) {
    const page = await readPage(fetcher, part, table, after, signal);
    first ??= page;
    rows.push(...page.tables[table]);
    if (page.manifest) manifest.push(...page.manifest);
    if (page.next === null) return { first, rows, manifest };
    // A cursor that does not advance would loop forever.
    if (seen.has(page.next)) throw new ExportError(EXPORT_COPY.format);
    seen.add(page.next);
    after = page.next;
  }
  throw new ExportError(EXPORT_COPY.format);
}

/** Manifest order of the whole-part response: recorded time, then id. */
function sortManifest(items: ExportManifestItem[]): ExportManifestItem[] {
  return [...items].sort((a, b) => {
    try {
      const byTime = compareInstants(a.recordedAt, b.recordedAt);
      if (byTime !== 0) return byTime;
    } catch {
      // Unparseable times keep id order below.
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The download route of a manifest item, accepted only when it is the owner route of exactly that item. */
export function screenshotPath(item: Pick<ExportManifestItem, "id" | "kind" | "downloadPath">): string | null {
  const match = DOWNLOAD_PATH.exec(item.downloadPath);
  if (!match || match[2] !== item.id) return null;
  return (item.kind === "V2" ? match[1] === "evidence" : match[1] === "screenshots") ? item.downloadPath : null;
}

/** Archive file name of one screenshot: `screenshots/<manifest id>.<extension>`. */
export function screenshotFileName(item: Pick<ExportManifestItem, "id" | "mimeType">): string {
  return `screenshots/${item.id}.${MIME_EXTENSIONS[item.mimeType]}`;
}

/** The recorded time as the archive entry's modification time; undefined (now) when it cannot be read. */
function validDate(value: string): Date | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Web Crypto SHA-256; unavailable outside secure contexts (plain HTTP on a non-loopback host). */
export async function webCryptoSha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new ExportError(EXPORT_COPY.noDigest);
  return hex(await subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

type ScreenshotOutcome = { item: ExportManifestItem; bytes: Uint8Array } | { item: ExportManifestItem; issue: ScreenshotIssue };

async function downloadScreenshot(
  fetcher: Fetcher, item: ExportManifestItem, digest: (bytes: Uint8Array) => Promise<string>, signal: AbortSignal | undefined,
): Promise<ScreenshotOutcome> {
  const path = screenshotPath(item);
  if (path === null) return { item, issue: { id: item.id, problem: "MISSING", detail: "The manifest has no download route for this screenshot." } };
  const response = await request(fetcher, path, item.mimeType, signal);
  if (response.status === 401 || response.status === 403) throw new ExportError(EXPORT_COPY.session);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { item, issue: { id: item.id, problem: "MISSING", detail: `The image could not be downloaded (HTTP ${response.status}).` } };
  }
  const bytes = new Uint8Array(await readBody(() => response.arrayBuffer(), signal, EXPORT_COPY.network));
  if (bytes.length !== item.byteSize) {
    return { item, issue: { id: item.id, problem: "MISMATCH", detail: `Downloaded ${bytes.length} bytes; ${item.byteSize} were recorded.` } };
  }
  const fingerprint = await digest(bytes);
  if (fingerprint !== item.sha256) return { item, issue: { id: item.id, problem: "MISMATCH", detail: "The SHA-256 fingerprint differs from the one recorded." } };
  return { item, bytes };
}

/** Runs `task` over `items` with at most `limit` in flight; results keep the input order. */
async function pool<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>, onDone: (count: number) => void): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
      done += 1;
      onDone(done);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

function readme(input: { exportedAt: string; schema: string; screenshots: ExportScreenshotSummary | null }): string {
  const screenshotLine = input.screenshots === null
    ? "Screenshots were not included in this export. Their records are in evidence-manifest.json."
    : input.screenshots.issues.length === 0
      ? `Screenshots: ${input.screenshots.included} of ${input.screenshots.expected} included, each verified against its recorded SHA-256 fingerprint.`
      : `Screenshots: ${input.screenshots.included} of ${input.screenshots.expected} included and verified. ${input.screenshots.issues.length} could not be included; see screenshots/issues.json.`;
  return [
    "Trading OS data export",
    "",
    `Exported at: ${input.exportedAt} (UTC)`,
    `Format version: ${input.schema}`,
    "",
    "Files",
    "- core.json: your login email, trading accounts and their profile history, strategy versions with their written rules, risk plan versions, instruments, account values, external losses, configuration history, daily notes and platform connections.",
    "- trades.json: every trade with its draft revisions, risk checks, plans, entries, exits, skips and cancellations, live-first details, journal entries, tags, reviews and platform executions.",
    "- ai.json: AI preferences, requests, results and usage records.",
    "- evidence-manifest.json: one record per screenshot, removed ones included: label, timeframe, caption, file name, size, dimensions, SHA-256 fingerprint, recorded time, timing (before entry, while live, after close) and removal time.",
    "- trades.csv: one row per trade, for spreadsheets.",
    ...(input.screenshots === null ? [] : [
      "- screenshots/: each screenshot as <id>.<extension>; the id matches its record in evidence-manifest.json.",
      ...(input.screenshots.issues.length > 0 ? ["- screenshots/issues.json: screenshots that could not be downloaded or did not match their recorded fingerprint."] : []),
    ]),
    "",
    screenshotLine,
    "Numbers are exact decimal strings. Times are ISO 8601 timestamps in UTC.",
    "",
  ].join("\r\n");
}

/** Reads everything, verifies the screenshots and packages the archive. Throws ExportError or ExportCancelled. */
export async function buildDataExport(options: ExportOptions): Promise<ExportResult> {
  const fetcher: Fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const { signal, onProgress } = options;
  const digest = options.digest ?? webCryptoSha256;
  const totalTables = EXPORT_JSON_PARTS.reduce((sum, part) => sum + options.tables[part].length, 0);
  const totalRecords = totalTables + 1;
  let doneRecords = 0;
  let rowCount = 0;
  onProgress?.({ step: "records", done: 0, total: totalRecords, part: EXPORT_JSON_PARTS[0] });

  const documents = new Map<ExportJsonPart, ExportPartDocument>();
  for (const part of EXPORT_JSON_PARTS) {
    const document: ExportPartDocument = { exportedAt: "", schema: "", part, user: { id: "", email: null }, tables: {} };
    const manifest: ExportManifestItem[] = [];
    for (const table of options.tables[part]) {
      const { first, rows, manifest: items } = await readTable(fetcher, part, table, signal);
      if (document.exportedAt === "") Object.assign(document, { exportedAt: first.exportedAt, schema: first.schema, user: first.user });
      document.tables[table] = rows;
      rowCount += rows.length;
      manifest.push(...items);
      doneRecords += 1;
      onProgress?.({ step: "records", done: doneRecords, total: totalRecords, part });
    }
    if (part === "evidence-manifest") document.manifest = sortManifest(manifest);
    documents.set(part, document);
  }

  const csvResponse = await request(fetcher, exportUrl("trades-csv"), "text/csv", signal);
  if (!csvResponse.ok) throw new ExportError(statusCopy(csvResponse.status));
  const csv = await readBody(() => csvResponse.text(), signal, EXPORT_COPY.network);
  onProgress?.({ step: "records", done: totalRecords, total: totalRecords, part: "trades-csv" });

  const first = documents.get("core");
  const exportedAt = first?.exportedAt || new Date().toISOString();
  const schema = first?.schema || "2.0";
  const day = /^\d{4}-\d{2}-\d{2}/.exec(exportedAt)?.[0] ?? new Date().toISOString().slice(0, 10);
  const root = `trading-os-export-${day}`;

  let screenshots: ExportScreenshotSummary | null = null;
  const images: ZipEntryInput[] = [];
  if (options.includeScreenshots) {
    const items = documents.get("evidence-manifest")?.manifest ?? [];
    const totalBytes = items.reduce((sum, item) => sum + item.byteSize, 0);
    if (totalBytes > (options.maxScreenshotBytes ?? MAX_SCREENSHOT_BYTES)) throw new ExportError(EXPORT_COPY.tooLarge);
    // Fail before downloading anything when this browser cannot verify fingerprints.
    if (items.length > 0 && !options.digest && !globalThis.crypto?.subtle) throw new ExportError(EXPORT_COPY.noDigest);
    onProgress?.({ step: "screenshots", done: 0, total: items.length });
    const outcomes = await pool(
      items,
      options.concurrency ?? DEFAULT_CONCURRENCY,
      item => downloadScreenshot(fetcher, item, digest, signal),
      done => onProgress?.({ step: "screenshots", done, total: items.length }),
    );
    throwIfCancelled(signal);
    const issues: ScreenshotIssue[] = [];
    for (const outcome of outcomes) {
      if ("issue" in outcome) issues.push(outcome.issue);
      else images.push({ name: `${root}/${screenshotFileName(outcome.item)}`, data: outcome.bytes, modifiedAt: validDate(outcome.item.recordedAt) });
    }
    screenshots = { expected: items.length, included: images.length, issues };
  }

  onProgress?.({ step: "archive" });
  const text = (name: string, data: string): ZipEntryInput => ({ name: `${root}/${name}`, data });
  const entries: ZipEntryInput[] = [
    text("README.txt", readme({ exportedAt, schema, screenshots })),
    ...EXPORT_JSON_PARTS.map(part => text(`${part}.json`, `${JSON.stringify(documents.get(part), null, 2)}\n`)),
    text("trades.csv", csv),
    ...images,
    ...(screenshots && screenshots.issues.length > 0 ? [text("screenshots/issues.json", `${JSON.stringify(screenshots.issues, null, 2)}\n`)] : []),
  ];
  throwIfCancelled(signal);
  let archive: Uint8Array;
  try {
    archive = createZip(entries);
  } catch {
    throw new ExportError(EXPORT_COPY.archive);
  }
  return { fileName: `${root}.zip`, archive, tables: totalTables, rows: rowCount, screenshots };
}

// ---------------------------------------------------------------------------------------------------------
// Progress copy
// ---------------------------------------------------------------------------------------------------------

export interface ProgressView {
  /** "Step 1 of 3" */
  step: string;
  title: string;
  /** "45% · Trades and journal" or "34 of 155 screenshots" */
  detail: string;
  /** 0–1, or null while indeterminate. */
  fraction: number | null;
}

export function progressView(progress: ExportProgress, includeScreenshots: boolean): ProgressView {
  const steps = includeScreenshots ? 3 : 2;
  if (progress.step === "records") {
    const what = progress.part === "trades-csv" ? "Trades spreadsheet" : PART_LABELS[progress.part];
    return {
      step: `Step 1 of ${steps}`,
      title: "Reading your records",
      detail: `${progress.total > 0 ? Math.floor((Math.min(progress.done, progress.total) / progress.total) * 100) : 0}% · ${what}`,
      fraction: progress.total > 0 ? Math.min(1, progress.done / progress.total) : null,
    };
  }
  if (progress.step === "screenshots") {
    return {
      step: `Step 2 of ${steps}`,
      title: "Downloading and verifying screenshots",
      detail: `${progress.done} of ${progress.total} screenshots`,
      fraction: progress.total > 0 ? progress.done / progress.total : 1,
    };
  }
  return { step: `Step ${steps} of ${steps}`, title: "Building the archive", detail: "Packaging your files in this browser", fraction: null };
}

/** "32.4 MB" (decimal units, like file managers on most systems). */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB"] as const;
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
