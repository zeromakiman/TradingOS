import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { EvidenceStager } from "@/components/evidence/evidence-stager";
import {
  DEFAULT_LABEL_BY_TIMING, defaultLabelForTiming, EVIDENCE_LABEL_TEXT, evidenceTagText, labelOptionsForDefault, labelOptionsForTiming, shortFileName, stagedFileName, TIMEFRAME_TEXT,
} from "@/components/evidence/labels";
import {
  capturesPaste, captureAnnouncement, clipboardHasText, clipboardImageFiles, type PageCaptureRole, pageCaptureRole, pageDragDecision, transferHasFiles, type TransferItemLike,
} from "@/components/evidence/paste-model";
import { EvidencePasteTarget } from "@/components/evidence/paste-target";
import {
  capacityMessage, createStagedItem, evidenceFileProblem, isEditable, needsUpload, planStaging, stagedAnnouncement, type StagerAction, stagerReducer,
  uploadStagedBatch,
} from "@/components/evidence/stager-model";
import { CAPTURE_METHODS, EVIDENCE_LABELS, type EvidenceLabel, MAX_EVIDENCE_BYTES, type StagedEvidence, TIMEFRAMES } from "@/components/evidence/types";
import { UPLOAD_COPY, type UploadResult, type uploadStagedEvidence } from "@/components/evidence/upload";
import { type EvidenceStagerApi, randomUuid } from "@/components/evidence/use-evidence-stager";
import type { EvidenceLabel as DomainEvidenceLabel } from "@/domain/timeline";

const element = <P extends object>(component: ComponentType<P>, props: P) => createElement(component, props);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function image(name = "chart.png", type = "image/png", size = 1024): File {
  return new File([new Uint8Array(size)], name, { type });
}

let seedCounter = 0;
function staged(overrides: Partial<StagedEvidence> = {}): StagedEvidence {
  seedCounter += 1;
  const seed = { localId: `local-${seedCounter}`, evidenceId: `00000000-0000-4000-8000-${String(seedCounter).padStart(12, "0")}`, previewUrl: `blob:preview-${seedCounter}` };
  return { ...createStagedItem(image(), "FILE", "PRE_ENTRY", seed), ...overrides };
}

describe("evidence vocabulary", () => {
  it("matches the domain and database vocabularies exactly", () => {
    expectTypeOf<EvidenceLabel>().toEqualTypeOf<DomainEvidenceLabel>();
    expect(EVIDENCE_LABELS).toEqual(["HTF", "CONTEXT", "PRE_ENTRY", "ENTRY", "MANAGEMENT", "EXIT", "OTHER"]);
    expect(TIMEFRAMES).toEqual(["DAILY", "H4", "H1", "M30", "M15", "M5", "M3", "OTHER"]);
    expect(CAPTURE_METHODS).toEqual(["PASTE", "DROP", "FILE", "CAMERA"]);
    expect(MAX_EVIDENCE_BYTES).toBe(4_194_304);
  });

  it("defaults the label by timing (draft → Pre-entry, live → Management, after close → Exit)", () => {
    expect(defaultLabelForTiming("BEFORE_ENTRY")).toBe("PRE_ENTRY");
    expect(defaultLabelForTiming("WHILE_LIVE")).toBe("MANAGEMENT");
    expect(defaultLabelForTiming("AFTER_CLOSE")).toBe("EXIT");
    expect(Object.keys(DEFAULT_LABEL_BY_TIMING)).toEqual(["BEFORE_ENTRY", "WHILE_LIVE", "AFTER_CLOSE"]);
  });

  it("offers Pre-entry only before entry: the band's default plus HTF, Context, Entry and Other (spec §7.1, §5.3)", () => {
    expect(labelOptionsForTiming("BEFORE_ENTRY")).toEqual(["HTF", "CONTEXT", "PRE_ENTRY", "ENTRY", "OTHER"]);
    expect(labelOptionsForTiming("WHILE_LIVE")).toEqual(["HTF", "CONTEXT", "ENTRY", "MANAGEMENT", "OTHER"]);
    expect(labelOptionsForTiming("AFTER_CLOSE")).toEqual(["HTF", "CONTEXT", "ENTRY", "EXIT", "OTHER"]);
    for (const timing of ["WHILE_LIVE", "AFTER_CLOSE"] as const) expect(labelOptionsForTiming(timing)).not.toContain("PRE_ENTRY");
    // An existing label stays selectable (a draft screenshot that became "While live" after a back-dated entry).
    expect(labelOptionsForTiming("WHILE_LIVE", "PRE_ENTRY")).toEqual(["HTF", "CONTEXT", "PRE_ENTRY", "ENTRY", "MANAGEMENT", "OTHER"]);
    expect(labelOptionsForTiming("AFTER_CLOSE", "EXIT")).toEqual(labelOptionsForTiming("AFTER_CLOSE"));
    // A stager's default label stands for its timing.
    for (const timing of ["BEFORE_ENTRY", "WHILE_LIVE", "AFTER_CLOSE"] as const) expect(labelOptionsForDefault(defaultLabelForTiming(timing))).toEqual(labelOptionsForTiming(timing));
    expect(labelOptionsForDefault("HTF")).toEqual(["HTF", "CONTEXT", "ENTRY", "OTHER"]);
  });

  it("has words for every value and never shows raw codes", () => {
    for (const label of EVIDENCE_LABELS) expect(EVIDENCE_LABEL_TEXT[label]).not.toMatch(/_/);
    expect(EVIDENCE_LABEL_TEXT.PRE_ENTRY).toBe("Pre-entry");
    expect(TIMEFRAME_TEXT.DAILY).toBe("Daily");
    expect(evidenceTagText("ENTRY", "M5")).toBe("Entry · M5");
    expect(evidenceTagText("OTHER", null)).toBe("Other");
  });

  it("names staged files in words: pasted images and photos by how they were captured", () => {
    expect(stagedFileName("image.png", "PASTE")).toBe("Pasted screenshot");
    expect(stagedFileName("IMG_2041.jpg", "CAMERA")).toBe("Photo");
    expect(stagedFileName("image.png", "DROP")).toBe("Dropped image");
    expect(stagedFileName("eurusd-m5.png", "FILE")).toBe("eurusd-m5.png");
    expect(stagedFileName("\u0007", "FILE")).toBe("Chosen image");
    expect(shortFileName("a-very-long-screenshot-name-from-the-trading-platform-export.png", 30)).toBe("a-very-long-screenshot-na….png");
    expect(shortFileName("short.png", 30)).toBe("short.png");
  });
});

describe("client checks (spec §7.1)", () => {
  it("accepts PNG, JPEG and WEBP from 1 byte up to exactly 4 MiB", () => {
    expect(evidenceFileProblem(image("a.png", "image/png", 1))).toBeNull();
    expect(evidenceFileProblem(image("a.jpg", "image/jpeg", MAX_EVIDENCE_BYTES))).toBeNull();
    expect(evidenceFileProblem({ name: "a.webp", type: "image/webp", size: MAX_EVIDENCE_BYTES })).toBeNull();
  });

  it("rejects other types, empty files and files over 4 MiB with human copy", () => {
    expect(evidenceFileProblem({ name: "loop.gif", type: "image/gif", size: 10 })).toBe("“loop.gif” can't be added: use a PNG, JPEG or WEBP image.");
    expect(evidenceFileProblem({ name: "notes.pdf", type: "application/pdf", size: 10 })).toBe("“notes.pdf” can't be added: use a PNG, JPEG or WEBP image.");
    expect(evidenceFileProblem({ name: "photo.heic", type: "", size: 10 })).toBe("“photo.heic” can't be added: use a PNG, JPEG or WEBP image.");
    expect(evidenceFileProblem({ name: "blank.png", type: "image/png", size: 0 })).toBe("“blank.png” is empty.");
    expect(evidenceFileProblem({ name: "huge.png", type: "image/png", size: MAX_EVIDENCE_BYTES + 1 })).toBe("“huge.png” is larger than 4 MB. Save a smaller screenshot and try again.");
    expect(evidenceFileProblem({ name: "", type: "text/plain", size: 3 })).toBe("This file can't be added: use a PNG, JPEG or WEBP image.");
  });

  it("stages valid files up to the capacity and explains the rest", () => {
    const files = [image("1.png"), { name: "x.gif", type: "image/gif", size: 5 }, image("2.png"), image("3.png")];
    const plan = planStaging(files, 1, 3);
    expect(plan.accepted.map(file => file.name)).toEqual(["1.png", "2.png"]);
    expect(plan.errors).toEqual(["“x.gif” can't be added: use a PNG, JPEG or WEBP image.", "Up to 3 screenshots can be added here; 1 image wasn't added."]);
    expect(planStaging([image("a.png"), image("b.png")], 0, 0).errors).toEqual(["No more screenshots can be added here. Remove one first."]);
    expect(capacityMessage(1, 3)).toBe("Up to 1 screenshot can be added here; 3 images weren't added.");
  });

  it("reports one message for repeated identical problems", () => {
    const gif = { name: "x.gif", type: "image/gif", size: 5 };
    expect(planStaging([gif, gif], 0, 24).errors).toHaveLength(1);
  });
});

describe("stager state machine", () => {
  it("creates staged items with the default label, no timeframe, an empty caption and the capture method", () => {
    const file = image("paste.png");
    const item = createStagedItem(file, "PASTE", "MANAGEMENT", { localId: "l1", evidenceId: "e1", previewUrl: "blob:1" });
    expect(item).toEqual({ localId: "l1", evidenceId: "e1", previewUrl: "blob:1", file, label: "MANAGEMENT", timeframe: null, caption: "", captureMethod: "PASTE", status: "staged" });
  });

  it("adds, edits, replaces and removes staged items", () => {
    const first = staged();
    const second = staged();
    let items = stagerReducer([], { type: "add", items: [first, second] });
    expect(items).toHaveLength(2);
    items = stagerReducer(items, { type: "update", localId: first.localId, patch: { label: "ENTRY", timeframe: "M5", caption: "x".repeat(250) } });
    expect(items[0]).toMatchObject({ label: "ENTRY", timeframe: "M5", status: "staged" });
    expect(items[0].caption).toHaveLength(200);
    const replacement = image("better.png");
    items = stagerReducer(items, { type: "replace", localId: first.localId, file: replacement, captureMethod: "FILE", evidenceId: "new-id", previewUrl: "blob:new" });
    expect(items[0]).toMatchObject({ file: replacement, evidenceId: "new-id", previewUrl: "blob:new", label: "ENTRY", timeframe: "M5", status: "staged" });
    items = stagerReducer(items, { type: "remove", localId: second.localId });
    expect(items.map(item => item.localId)).toEqual([first.localId]);
  });

  it("moves through uploading to uploaded or failed, and editing a failed item stages it again", () => {
    const item = staged();
    let items = stagerReducer([item], { type: "uploading", localId: item.localId });
    expect(items[0].status).toBe("uploading");
    expect(needsUpload(items[0])).toBe(false);
    items = stagerReducer(items, { type: "failed", localId: item.localId, error: "Screenshot storage is temporarily unavailable." });
    expect(items[0]).toMatchObject({ status: "failed", error: "Screenshot storage is temporarily unavailable." });
    expect(needsUpload(items[0])).toBe(true);
    items = stagerReducer(items, { type: "update", localId: item.localId, patch: { caption: "retry" } });
    expect(items[0].status).toBe("staged");
    expect(items[0]).not.toHaveProperty("error");
    items = stagerReducer(items, { type: "uploading", localId: item.localId });
    items = stagerReducer(items, { type: "uploaded", localId: item.localId });
    expect(items[0].status).toBe("uploaded");
    expect(stagerReducer(items, { type: "failed", localId: item.localId, error: "late" })[0].status).toBe("uploaded");
  });

  it("never edits, replaces or removes an image while it is being sent", () => {
    const item = { ...staged(), status: "uploading" as const };
    const items = [item];
    expect(isEditable(item)).toBe(false);
    expect(stagerReducer(items, { type: "update", localId: item.localId, patch: { label: "EXIT" } })).toBe(items);
    expect(stagerReducer(items, { type: "replace", localId: item.localId, file: image(), captureMethod: "FILE", evidenceId: "x", previewUrl: "blob:x" })).toBe(items);
    expect(stagerReducer(items, { type: "remove", localId: item.localId })).toBe(items);
    expect(stagerReducer(items, { type: "clear" })).toBe(items);
  });

  it("clears everything not in flight, or only the saved items", () => {
    const saved = { ...staged(), status: "uploaded" as const };
    const failed = { ...staged(), status: "failed" as const, error: "x" };
    const sending = { ...staged(), status: "uploading" as const };
    const waiting = staged();
    expect(stagerReducer([saved, failed, sending, waiting], { type: "clearUploaded" })).toEqual([failed, sending, waiting]);
    expect(stagerReducer([saved, failed, sending, waiting], { type: "clear" })).toEqual([sending]);
  });

  it("keeps the same array when nothing changes (no re-render)", () => {
    const items = [staged()];
    expect(stagerReducer(items, { type: "remove", localId: "missing" })).toBe(items);
    expect(stagerReducer(items, { type: "add", items: [] })).toBe(items);
    expect(stagerReducer(items, { type: "clearUploaded" })).toBe(items);
  });

  it("announces what happened after the stager's own controls added files", () => {
    expect(stagedAnnouncement(1, 0)).toBe("1 screenshot ready to save.");
    expect(stagedAnnouncement(2, 1)).toBe("2 screenshots ready to save. 1 file wasn't added.");
    expect(stagedAnnouncement(0, 3)).toBe("3 files weren't added.");
  });
});

describe("uploading a staged batch", () => {
  it("claims every image, then moves each to uploaded or failed as the uploader reports", async () => {
    const [good, bad] = [staged(), staged()];
    const actions: StagerAction[] = [];
    const uploader: typeof uploadStagedEvidence = async (_tradeId, items, options = {}) => {
      const results = items.map((item, index) => ({ localId: item.localId, ok: index === 0, ...(index === 0 ? { id: item.evidenceId } : { error: "This image is larger than 4 MB." }) }));
      for (const result of results) {
        options.onItemStart?.(result.localId);
        options.onItemSettled?.(result);
      }
      return results;
    };
    const started: string[] = [];
    const results = await uploadStagedBatch("trade", [good, bad], uploader, action => actions.push(action), { onItemStart: id => started.push(id) });
    expect(results.map(result => result.ok)).toEqual([true, false]);
    expect(started).toEqual([good.localId, bad.localId]);
    // The whole batch is claimed before the first request, then each image settles as reported.
    expect(actions).toEqual([
      { type: "uploading", localId: good.localId },
      { type: "uploading", localId: bad.localId },
      { type: "uploaded", localId: good.localId },
      { type: "failed", localId: bad.localId, error: "This image is larger than 4 MB." },
    ]);
    let items: StagedEvidence[] = [good, bad];
    for (const action of actions) items = stagerReducer(items, action);
    expect(items.map(item => item.status)).toEqual(["uploaded", "failed"]);
  });

  it("fails the unsettled images when an uploader throws, so none stays uploading", async () => {
    const [first, second] = [staged(), staged()];
    const actions: StagerAction[] = [];
    const uploader: typeof uploadStagedEvidence = async (_tradeId, items, options = {}) => {
      options.onItemStart?.(items[0].localId);
      options.onItemSettled?.({ localId: items[0].localId, ok: true, id: items[0].evidenceId });
      options.onItemStart?.(items[1].localId);
      throw new Error("demo uploader crashed");
    };
    const results = await uploadStagedBatch("trade", [first, second], uploader, action => actions.push(action));
    expect(results).toEqual([{ localId: first.localId, ok: true, id: first.evidenceId }, { localId: second.localId, ok: false, error: UPLOAD_COPY.failed }]);
    let items: StagedEvidence[] = [first, second];
    for (const action of actions) items = stagerReducer(items, action);
    expect(items.map(item => item.status)).toEqual(["uploaded", "failed"]);
  });

  it("sends exactly what the cards show: queued images can't be removed, relabelled or replaced mid-batch", async () => {
    const [first, second, third] = [staged(), staged({ label: "MANAGEMENT" }), staged()];
    // The hook's state: every dispatch goes through the reducer, as `useEvidenceStager` does.
    let items: StagedEvidence[] = [first, second, third];
    const dispatch = (action: StagerAction) => {
      items = stagerReducer(items, action);
    };
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const sent: StagedEvidence[] = [];
    const uploader: typeof uploadStagedEvidence = async (_tradeId, batch, options = {}) => {
      const results: UploadResult[] = [];
      for (const [index, item] of batch.entries()) {
        options.onItemStart?.(item.localId);
        if (index === 0) await gate;
        sent.push(item);
        const result = { localId: item.localId, ok: true, id: item.evidenceId };
        results.push(result);
        options.onItemSettled?.(result);
      }
      return results;
    };

    const upload = uploadStagedBatch("trade", items.filter(needsUpload), uploader, dispatch);
    // The first image is being sent; the two waiting their turn are already claimed.
    expect(items.map(item => item.status)).toEqual(["uploading", "uploading", "uploading"]);
    expect(items.some(isEditable)).toBe(false);
    const claimed = items;
    dispatch({ type: "remove", localId: second.localId });
    dispatch({ type: "update", localId: second.localId, patch: { label: "EXIT" } });
    dispatch({ type: "replace", localId: third.localId, file: image("newer.png"), captureMethod: "FILE", evidenceId: "replacement-id", previewUrl: "blob:replacement" });
    dispatch({ type: "clear" });
    expect(items).toBe(claimed);
    // An image added meanwhile waits for the next save.
    const late = staged();
    dispatch({ type: "add", items: [late] });
    release();
    const results = await upload;

    const facts = (item: StagedEvidence) => [item.localId, item.evidenceId, item.label, item.file];
    expect(sent.map(facts)).toEqual([first, second, third].map(facts));
    expect(results.map(result => [result.localId, result.ok])).toEqual([[first.localId, true], [second.localId, true], [third.localId, true]]);
    expect(items.map(item => [item.localId, item.label, item.status])).toEqual([
      [first.localId, "PRE_ENTRY", "uploaded"], [second.localId, "MANAGEMENT", "uploaded"], [third.localId, "PRE_ENTRY", "uploaded"], [late.localId, "PRE_ENTRY", "staged"],
    ]);
    expect(stagerReducer(items, { type: "clearUploaded" })).toEqual([late]);
  });

  it("fails the images an upload stopped before sending, and they can be edited again", async () => {
    const [first, second] = [staged(), staged()];
    let items: StagedEvidence[] = [first, second];
    const dispatch = (action: StagerAction) => {
      items = stagerReducer(items, action);
    };
    // Like uploadStagedEvidence after a lost session: the rest is reported failed without a request.
    const uploader: typeof uploadStagedEvidence = async (_tradeId, batch, options = {}) => {
      const results = batch.map(item => ({ localId: item.localId, ok: false, error: UPLOAD_COPY.session }));
      options.onItemStart?.(batch[0].localId);
      for (const result of results) options.onItemSettled?.(result);
      return results;
    };
    await uploadStagedBatch("trade", items.filter(needsUpload), uploader, dispatch);
    expect(items.map(item => [item.status, item.error])).toEqual([["failed", UPLOAD_COPY.session], ["failed", UPLOAD_COPY.session]]);
    expect(items.every(isEditable)).toBe(true);
  });

  it("settles images an uploader returned without reporting, so none stays uploading", async () => {
    const [first, second] = [staged(), staged()];
    let items: StagedEvidence[] = [first, second];
    const dispatch = (action: StagerAction) => {
      items = stagerReducer(items, action);
    };
    const uploader: typeof uploadStagedEvidence = async (_tradeId, batch) => [{ localId: batch[0].localId, ok: true, id: batch[0].evidenceId }];
    const results = await uploadStagedBatch("trade", items.filter(needsUpload), uploader, dispatch);
    expect(results).toEqual([{ localId: first.localId, ok: true, id: first.evidenceId }, { localId: second.localId, ok: false, error: UPLOAD_COPY.failed }]);
    expect(items.map(item => item.status)).toEqual(["uploaded", "failed"]);
  });

  it("does nothing for an empty batch", async () => {
    const uploader = vi.fn<typeof uploadStagedEvidence>();
    expect(await uploadStagedBatch("trade", [], uploader, () => undefined)).toEqual([]);
    expect(uploader).not.toHaveBeenCalled();
  });
});

describe("evidence ids", () => {
  afterEach(() => {
    Reflect.deleteProperty(crypto, "randomUUID");
  });

  it("are random v4 UUIDs, also outside secure contexts where crypto.randomUUID is missing", () => {
    expect(randomUuid()).toMatch(UUID_V4);
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    const ids = new Set(Array.from({ length: 50 }, () => randomUuid()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});

describe("page capture rules (spec §7.1, §13.4)", () => {
  const fileItem = (file: File): TransferItemLike => ({ kind: "file", type: file.type, getAsFile: () => file });
  const textItem: TransferItemLike = { kind: "string", type: "text/plain", getAsFile: () => null };

  it("reads clipboard images from items, and from files when items carry none", () => {
    const shot = image("image.png");
    expect(clipboardImageFiles({ items: [textItem, fileItem(shot), fileItem(new File(["x"], "a.txt", { type: "text/plain" }))] })).toEqual([shot]);
    expect(clipboardImageFiles({ items: [], files: [shot, new File(["x"], "a.txt", { type: "text/plain" })] })).toEqual([shot]);
    expect(clipboardImageFiles(null)).toEqual([]);
    expect(clipboardHasText({ types: ["text/html", "text/plain", "Files"] })).toBe(true);
    expect(clipboardHasText({ types: ["Files"] })).toBe(false);
    expect(transferHasFiles({ types: ["Files"] })).toBe(true);
    expect(transferHasFiles({ types: ["text/uri-list"] })).toBe(false);
  });

  it("captures pastes outside text fields, and in text fields only where allowed and without copied text", () => {
    const body = { tagName: "BODY" };
    const priceInput = { tagName: "INPUT", type: "text" };
    const composer = { tagName: "TEXTAREA" };
    const checkbox = { tagName: "INPUT", type: "checkbox" };
    const allow = (element: Element) => element === (composer as unknown as Element);
    expect(capturesPaste({ target: body, hasText: true })).toBe(true);
    expect(capturesPaste({ target: checkbox, hasText: false })).toBe(true);
    expect(capturesPaste({ target: priceInput, hasText: false })).toBe(false);
    expect(capturesPaste({ target: priceInput, hasText: false, allowInTextFields: allow })).toBe(false);
    expect(capturesPaste({ target: composer, hasText: false, allowInTextFields: allow })).toBe(true);
    // Copying a table can carry a rendered image: the words still go into the note.
    expect(capturesPaste({ target: composer, hasText: true, allowInTextFields: allow })).toBe(false);
    expect(capturesPaste({ target: { tagName: "DIV", isContentEditable: true }, hasText: false })).toBe(false);
  });

  it("lets the most recently enabled target capture; disabled targets protect the page only when none is enabled", () => {
    const base = { disabled: false, enabledTargets: 1, isLatest: true, modalOpen: false };
    expect(pageCaptureRole(base)).toBe("capture");
    expect(pageCaptureRole({ ...base, modalOpen: true })).toBe("protect");
    expect(pageCaptureRole({ ...base, enabledTargets: 2, isLatest: false })).toBe("ignore");
    // Today: every composer takes its own drops and mounts a disabled target.
    expect(pageCaptureRole({ disabled: true, enabledTargets: 0, isLatest: false, modalOpen: false })).toBe("protect");
    expect(pageCaptureRole({ disabled: true, enabledTargets: 0, isLatest: false, modalOpen: true })).toBe("protect");
    expect(pageCaptureRole({ disabled: true, enabledTargets: 1, isLatest: false, modalOpen: false })).toBe("ignore");
  });

  it("refuses file drops beside a composer instead of letting the browser open them over unsaved drafts", () => {
    const drag = (role: PageCaptureRole, changes: Partial<Parameters<typeof pageDragDecision>[0]> = {}) =>
      pageDragDecision({ role, hasFiles: true, overFileInput: false, defaultPrevented: false, ...changes });
    // Only disabled targets mounted (several composers on one page): dropped next to them, refused.
    const protect = pageCaptureRole({ disabled: true, enabledTargets: 0, isLatest: false, modalOpen: false });
    expect(drag(protect)).toBe("block");
    // Dropped on a composer: its own handler took the files first.
    expect(drag(protect, { defaultPrevented: true })).toBe("leave");
    expect(drag(protect, { overFileInput: true })).toBe("leave");
    expect(drag(protect, { hasFiles: false })).toBe("leave");
    expect(drag("capture")).toBe("copy");
    expect(drag("capture", { defaultPrevented: true })).toBe("leave");
    expect(drag("ignore")).toBe("leave");
  });

  it("announces captures in words", () => {
    expect(captureAnnouncement(1, "PASTE")).toBe("Pasted 1 screenshot.");
    expect(captureAnnouncement(3, "DROP")).toBe("Dropped 3 files.");
  });
});

const visibleText = (markup: string) => [markup.replace(/<[^>]+>/g, " "), ...[...markup.matchAll(/(?:aria-label|title|alt|placeholder)="([^"]*)"/g)].map(match => match[1])].join(" ");
const RAW_CODES = /\b(PRE_ENTRY|MANAGEMENT|CONTEXT|HTF_|EXIT|ENTRY|OTHER|PASTE|DROP|CAMERA|FILE|staged|uploading|uploaded|failed)\b/;

function stagerApi(items: StagedEvidence[], overrides: Partial<EvidenceStagerApi> = {}): EvidenceStagerApi {
  const noop = () => undefined;
  return {
    items, errors: [], defaultLabel: "PRE_ENTRY", max: 24, remaining: 24 - items.length, pendingCount: items.filter(needsUpload).length,
    addFiles: () => ({ added: [], errors: [] }), update: noop, replace: () => null, remove: noop, clear: noop, clearUploaded: noop, dismissErrors: noop,
    markUploading: noop, markUploaded: noop, markFailed: noop, uploadAll: async () => [], ...overrides,
  };
}

describe("<EvidenceStager>", () => {
  it("offers a drop zone, a multi-file picker and the mobile camera", () => {
    const markup = renderToStaticMarkup(createElement(EvidenceStager, { stager: stagerApi([]) }));
    expect(markup).toContain("Add screenshots");
    expect(markup).toContain("Paste with Ctrl+V, drop images here, or choose files. PNG, JPEG or WEBP, up to 4 MB each.");
    expect(markup).toMatch(/<input[^>]*type="file"[^>]*accept="image\/png,image\/jpeg,image\/webp"[^>]*multiple=""/);
    expect(markup).toMatch(/<input[^>]*type="file"[^>]*accept="image\/\*"[^>]*capture="environment"/);
    expect(markup).toContain("Choose files");
    expect(markup).toContain("Take photo");
    expect(markup).toMatch(/role="status"[^>]*aria-live="polite"/);
    expect(markup).not.toContain("Screenshots to save");
  });

  it("shows each staged image with its label, timeframe and caption controls, and status in words", () => {
    const items = [
      staged({ captureMethod: "PASTE", label: "MANAGEMENT", timeframe: "M5", caption: "Liquidity grab" }),
      staged({ status: "uploading" }),
      staged({ status: "uploaded" }),
      staged({ status: "failed", error: "This image is larger than 4 MB. Save a smaller screenshot and try again." }),
    ];
    const markup = renderToStaticMarkup(createElement(EvidenceStager, { stager: stagerApi(items) }));
    expect(markup).toContain('aria-label="Screenshots to save"');
    expect(markup).toContain('alt="Preview: Pasted screenshot"');
    expect(markup).toMatch(/<option value="MANAGEMENT" selected="">Management<\/option>/);
    expect(markup).toMatch(/<option value="M5" selected="">M5<\/option>/);
    expect(markup).toContain('value="Liquidity grab"');
    expect(markup).toContain("Label<span class=\"sr-only\"> of Pasted screenshot</span>");
    expect(markup).toContain("Uploading…");
    expect(markup).toContain("Saved");
    expect(markup).toContain("This image is larger than 4 MB. Save a smaller screenshot and try again.");
    expect(markup).toContain("Replace image");
    expect(markup).toContain('aria-label="Remove Pasted screenshot"');
    expect(visibleText(markup)).not.toMatch(RAW_CODES);
  });

  it("never offers Pre-entry in a live or after-close stager (spec §7.1, §5.3)", () => {
    // Options of the one item's label select (it comes before its timeframe select).
    const options = (markup: string) =>
      [...markup.slice(markup.indexOf("Label<span"), markup.indexOf("Timeframe<span")).matchAll(/<option value="[A-Z_]+"[^>]*>([^<]+)<\/option>/g)].map(match => match[1]);
    for (const compact of [false, true]) {
      const live = renderToStaticMarkup(createElement(EvidenceStager, { stager: stagerApi([staged({ label: "MANAGEMENT" })], { defaultLabel: "MANAGEMENT" }), compact }));
      expect(options(live)).toEqual(["HTF (higher timeframe)", "Context", "Entry", "Management", "Other"]);
      expect(live).not.toContain('value="PRE_ENTRY"');
      const closed = renderToStaticMarkup(createElement(EvidenceStager, { stager: stagerApi([staged({ label: "EXIT" })], { defaultLabel: "EXIT" }), compact }));
      expect(options(closed)).toEqual(["HTF (higher timeframe)", "Context", "Entry", "Exit", "Other"]);
      expect(closed).not.toContain('value="PRE_ENTRY"');
      const draft = renderToStaticMarkup(createElement(EvidenceStager, { stager: stagerApi([staged()], { defaultLabel: "PRE_ENTRY" }), compact }));
      expect(options(draft)).toEqual(["HTF (higher timeframe)", "Context", "Pre-entry", "Entry", "Other"]);
    }
  });

  it("lists rejected files in an alert", () => {
    const markup = renderToStaticMarkup(createElement(EvidenceStager, { stager: stagerApi([], { errors: ["“loop.gif” can't be added: use a PNG, JPEG or WEBP image."] }) }));
    expect(markup).toMatch(/role="alert"/);
    expect(markup).toContain("A file wasn&#x27;t added");
    expect(markup).toContain("“loop.gif” can&#x27;t be added: use a PNG, JPEG or WEBP image.");
  });

  it("compact: attach buttons and small previews without the drop zone or captions", () => {
    const markup = renderToStaticMarkup(createElement(EvidenceStager, { stager: stagerApi([staged()]), compact: true }));
    expect(markup).toContain("Attach screenshots");
    expect(markup).not.toContain("drop images here");
    expect(markup).not.toContain("Caption");
    expect(markup).toContain("Label<span");
    expect(markup).toContain("Timeframe<span");
    const full = renderToStaticMarkup(createElement(EvidenceStager, { stager: stagerApi([staged()], { remaining: 0 }), compact: true }));
    expect(full).toContain("No more screenshots can be added here.");
    expect(full).toMatch(/<button[^>]*disabled=""[^>]*>.*Attach screenshots/);
  });

  it("hides the controls without showLabels and blocks adding when full", () => {
    const full = stagerApi([staged()], { remaining: 0 });
    const markup = renderToStaticMarkup(createElement(EvidenceStager, { stager: full, showLabels: false }));
    expect(markup).not.toContain("<select");
    expect(markup).toContain("Pre-entry");
    expect(markup).toContain("No more screenshots can be added here.");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>.*Choose files/);
  });
});

describe("<EvidencePasteTarget>", () => {
  it("renders its children and a polite live region, and no overlay until a drag starts", () => {
    const markup = renderToStaticMarkup(element(EvidencePasteTarget, { onFiles: vi.fn(), children: createElement("main", null, "Trade") }));
    expect(markup).toContain("<main>Trade</main>");
    expect(markup).toMatch(/<p class="sr-only" role="status" aria-live="polite" aria-atomic="true"><\/p>/);
    expect(markup).not.toContain("Drop screenshots to add them");
  });
});

describe("<EvidenceStager> layout follows its own width (container queries)", () => {
  // Plan Trade's evidence section, a live trade's card on Today and a phone are all narrow; the page width says nothing
  // about the room the stager has, so its layout queries the stager and each card instead of the viewport.
  const markup = () => renderToStaticMarkup(createElement(EvidenceStager, { stager: stagerApi([staged({ label: "MANAGEMENT", timeframe: "M5" }), staged()]) }));

  it("is a size container and lays out two previews per row only when the stager itself is wide", () => {
    const html = markup();
    // (React hoists the previews as image preloads before the markup.)
    expect(html).toContain('<div class="@container flex min-w-0 flex-col gap-3">');
    expect(html).toContain('<ul aria-label="Screenshots to save" class="grid gap-3 @[64rem]:grid-cols-2">');
    expect(html).not.toContain("sm:grid-cols-2");
  });

  it("puts an image beside its controls only where the card has room, and the two selects on one line only when both stay readable", () => {
    const html = markup();
    expect(html.match(/<li class="@container min-w-0 rounded-card border border-border bg-surface p-2"><div class="flex min-w-0 flex-col gap-3 @\[30rem\]:flex-row">/g)).toHaveLength(2);
    expect(html).toMatch(/<img [^>]*class="aspect-\[16\/10\] max-h-48 w-full max-w-sm [^"]*@\[30rem\]:w-28"/);
    expect(html.match(/<div class="grid gap-2 @\[26rem\]:grid-cols-2">/g)).toHaveLength(2);
    expect(html).not.toContain('class="grid grid-cols-2 gap-2"');
  });
});
