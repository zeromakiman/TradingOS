"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionState } from "@/app/actions/state";
import { useTimeDisplay } from "@/components/shell/time-display";
import { JournalComposer, type JournalComposerActions } from "@/components/trade/journal/composer";
import { JOURNAL_KINDS } from "@/components/trade/journal/composer-model";
import { TradeTimeline } from "@/components/trade/journal/timeline";
import { Button } from "@/components/ui/button";
import { buildTimeline, type TimelineEvidence, type TimelineJournalEntry, type TimelineTrade } from "@/domain/timeline";
import { EvidenceStager } from "./evidence-stager";
import { EvidenceGallery } from "./gallery";
import type { GalleryItem } from "./gallery-model";
import { defaultLabelForTiming } from "./labels";
import { EvidenceSelectionProvider, useEvidenceSelection } from "./selection";
import { isEvidenceLabel, isTimeframe, type StagedEvidence } from "./types";
import { type UploadOptions, type UploadResult, uploadSummary } from "./upload";
import { randomUuid, useEvidenceStager } from "./use-evidence-stager";
import type { EvidenceActions } from "./viewer";

/**
 * Developer gallery specimen of the evidence and live-journal components (mount it in src/app/dev/ui):
 * a synthetic live EURUSD trade whose journal composer, timeline, evidence gallery (with AI selection),
 * viewer and standalone stager all work offline. Server actions and uploads are replaced by in-memory
 * stand-ins, so nothing reaches the database or storage; uploaded images stay in this page only.
 */

const TRADE_ID = "00000000-0000-4000-8000-00000000d001";
const INSTRUMENT = { tickSize: "0.00001", quantityStep: "0.01", quantityUnit: "lots" };

const DEMO_TRADE: TimelineTrade = {
  id: TRADE_ID, origin: "PLANNED", created_at: "2026-10-16T11:40:00Z", currency: "USD", plan_id: "00000000-0000-4000-8000-00000000d002",
  locked_at: "2026-10-16T12:10:00Z", strategy_version: "ICT V1.0", risk_plan_version: "Risk Plan V1.0", entered_at: "2026-10-16T12:42:00Z",
  entry_recorded_at: "2026-10-16T13:05:00Z", entry_price: "1.08525", quantity: "0.50", planned_quantity: "0.50", oversize: false, exited_at: null,
  close_recorded_at: null, exit_price: null, realized_r: null, net_pnl: null,
};

/** A small deterministic candlestick chart as an SVG data URL (no network, same markup on server and client). */
function chartImage(seed: number, accent: string): string {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  let price = 50;
  const candles = Array.from({ length: 40 }, () => {
    const open = price;
    const close = open + (random() - 0.47) * 6;
    price = close;
    return { open, close, high: Math.max(open, close) + random() * 3, low: Math.min(open, close) - random() * 3 };
  });
  const highest = Math.max(...candles.map(candle => candle.high));
  const lowest = Math.min(...candles.map(candle => candle.low));
  const y = (value: number) => 30 + ((highest - value) / (highest - lowest || 1)) * 340;
  const bodies = candles.map((candle, index) => {
    const x = 20 + index * 15;
    const up = candle.close >= candle.open;
    const color = up ? "#2ea866" : "#e4694c";
    return `<line x1="${x + 4}" x2="${x + 4}" y1="${y(candle.high).toFixed(1)}" y2="${y(candle.low).toFixed(1)}" stroke="${color}"/><rect x="${x}" y="${y(Math.max(candle.open, candle.close)).toFixed(1)}" width="8" height="${Math.max(1, Math.abs(y(candle.open) - y(candle.close))).toFixed(1)}" fill="${color}"/>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#0f1218"/><line x1="0" x2="640" y1="${y(price).toFixed(1)}" y2="${y(price).toFixed(1)}" stroke="${accent}" stroke-dasharray="6 6"/>${bodies.join("")}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

interface DemoEvidence {
  timeline: TimelineEvidence;
  gallery: GalleryItem;
}

function demoEvidence(id: string, seed: number, changes: Pick<GalleryItem, "label" | "timeframe" | "caption" | "timing" | "recordedAt"> & { phase: "PRE_ENTRY" | "LIVE" }): DemoEvidence {
  const image = chartImage(seed, seed % 2 ? "#6d93ff" : "#f0b049");
  return {
    timeline: { kind: "V2", id, label: changes.label, timeframe: changes.timeframe, caption: changes.caption, phase: changes.phase, recordedAt: changes.recordedAt, removedAt: null },
    gallery: { id, kind: "V2", label: changes.label, timeframe: changes.timeframe, caption: changes.caption, timing: changes.timing, recordedAt: changes.recordedAt, thumbUrl: image, fullUrl: image, width: 640, height: 400 },
  };
}

const INITIAL_EVIDENCE: DemoEvidence[] = [
  demoEvidence("00000000-0000-4000-8000-00000000e001", 7, { label: "HTF", timeframe: "H4", caption: "Daily bias: bullish order flow into the PDH.", timing: "BEFORE_ENTRY", recordedAt: "2026-10-16T11:52:00Z", phase: "PRE_ENTRY" }),
  demoEvidence("00000000-0000-4000-8000-00000000e002", 19, { label: "PRE_ENTRY", timeframe: "M5", caption: "OB first touch after the London sweep.", timing: "BEFORE_ENTRY", recordedAt: "2026-10-16T12:05:00Z", phase: "PRE_ENTRY" }),
  demoEvidence("00000000-0000-4000-8000-00000000e003", 23, { label: "MANAGEMENT", timeframe: "M15", caption: null, timing: "WHILE_LIVE", recordedAt: "2026-10-16T13:20:00Z", phase: "LIVE" }),
];

const INITIAL_JOURNAL: TimelineJournalEntry[] = [
  { id: "00000000-0000-4000-8000-00000000f001", kind: "NOTE", body: "Waiting for the retest of the M5 order block.", details: {}, phase: "PRE_ENTRY", recordedAt: "2026-10-16T12:20:00Z" },
  { id: "00000000-0000-4000-8000-00000000f002", kind: "STOP_CHANGE", body: "Structure broke higher; risk off the table.", details: { price: "1.08480" }, phase: "LIVE", recordedAt: "2026-10-16T13:25:00Z" },
];

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
};

function SelectionSummary() {
  const { selected, max } = useEvidenceSelection();
  return (
    <p className="t-caption">
      AI panels read the same selection: {selected.length} of {max} screenshots chosen.
    </p>
  );
}

export function EvidenceJournalDemo() {
  const display = useTimeDisplay();
  const [journal, setJournal] = useState<TimelineJournalEntry[]>(INITIAL_JOURNAL);
  const [evidence, setEvidence] = useState<DemoEvidence[]>(INITIAL_EVIDENCE);
  const objectUrls = useRef<string[]>([]);

  useEffect(() => () => {
    for (const url of objectUrls.current) URL.revokeObjectURL(url);
  }, []);

  const timeline = useMemo(
    () => buildTimeline({ trade: DEMO_TRADE, instrument: INSTRUMENT, journal, evidence: evidence.map(item => item.timeline) }, display),
    [journal, evidence, display],
  );
  const gallery = useMemo(() => evidence.map(item => item.gallery), [evidence]);
  const active = gallery.filter(item => !item.removed).length;

  // In-memory stand-ins for the server action and the upload route.
  const upload = async (_tradeId: string, items: StagedEvidence[], options: UploadOptions = {}): Promise<UploadResult[]> => {
    const results: UploadResult[] = [];
    options.onProgress?.(0, items.length);
    for (const [index, item] of items.entries()) {
      options.onItemStart?.(item.localId);
      await wait(450);
      const url = URL.createObjectURL(item.file);
      objectUrls.current.push(url);
      const recordedAt = new Date().toISOString();
      setEvidence(current => [
        ...current,
        {
          timeline: { kind: "V2", id: item.evidenceId, label: item.label, timeframe: item.timeframe, caption: item.caption || null, phase: "LIVE", recordedAt, removedAt: null },
          gallery: { id: item.evidenceId, kind: "V2", label: item.label, timeframe: item.timeframe, caption: item.caption || null, timing: "WHILE_LIVE", recordedAt, thumbUrl: url, fullUrl: url, width: 1600, height: 900 },
        },
      ]);
      const result = { localId: item.localId, ok: true, id: item.evidenceId };
      results.push(result);
      options.onItemSettled?.(result);
      options.onProgress?.(index + 1, items.length);
    }
    return results;
  };

  const composerActions: JournalComposerActions = {
    upload,
    addEntry: async (_prev, form) => {
      await wait(350);
      const kind = JOURNAL_KINDS.find(value => value === text(form, "kind"));
      if (!kind) return { status: "error", message: "Choose what kind of entry this is." };
      const details = text(form, "details");
      const id = randomUuid();
      setJournal(current => [...current, { id, kind, body: text(form, "body") || null, details: details ? (JSON.parse(details) as Record<string, string>) : {}, phase: "LIVE", recordedAt: new Date().toISOString() }]);
      return { status: "success", message: "Added to the journal.", data: { id } };
    },
  };

  const evidenceActions: EvidenceActions = {
    relabel: async (_prev, form): Promise<ActionState> => {
      await wait(350);
      const id = text(form, "evidenceId");
      const label = text(form, "label");
      const timeframe = text(form, "timeframe");
      const caption = text(form, "caption").trim() || null;
      if (!isEvidenceLabel(label)) return { status: "error", message: "Choose a label.", fieldErrors: { label: "Choose a label." } };
      const nextTimeframe = isTimeframe(timeframe) ? timeframe : null;
      const relabel = (item: DemoEvidence): DemoEvidence => ({
        timeline: item.timeline.kind === "V2" ? { ...item.timeline, label, timeframe: nextTimeframe, caption } : item.timeline,
        gallery: { ...item.gallery, label, timeframe: nextTimeframe, caption },
      });
      setEvidence(current => current.map(item => (item.gallery.id === id ? relabel(item) : item)));
      return { status: "success", message: "Label saved. The screenshot keeps its original timing." };
    },
    remove: async (_prev, form): Promise<ActionState> => {
      await wait(350);
      const id = text(form, "evidenceId");
      const removedAt = new Date().toISOString();
      setEvidence(current => current.map(item => (item.gallery.id === id ? { timeline: { ...item.timeline, removedAt }, gallery: { ...item.gallery, removed: true } } : item)));
      return { status: "success", message: "Screenshot removed. The timeline keeps a record of it." };
    },
  };

  return (
    <EvidenceSelectionProvider max={3}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section aria-labelledby="demo-journal" className="flex min-w-0 flex-col gap-4">
          <h3 id="demo-journal" className="section-header-title">
            Live journal · EURUSD long (synthetic)
          </h3>
          <JournalComposer
            tradeId={TRADE_ID}
            timingHint="WHILE_LIVE"
            instrument={INSTRUMENT}
            requestKey="00000000-0000-4000-8000-00000000c001"
            id="demo-journal-composer"
            maxScreenshots={24 - active}
            actions={composerActions}
          />
          <TradeTimeline items={timeline} timeDisplay={display} evidence={gallery} headingLevel={4} />
        </section>
        <section aria-labelledby="demo-evidence" className="flex min-w-0 flex-col gap-4">
          <h3 id="demo-evidence" className="section-header-title">
            Evidence
          </h3>
          <SelectionSummary />
          <EvidenceGallery items={gallery} tradeId={TRADE_ID} selectable actions={evidenceActions} headingLevel={4} />
          <StandaloneStager upload={upload} />
        </section>
      </div>
    </EvidenceSelectionProvider>
  );
}

/** The Plan Trade form's variant: stage first, upload after the draft is saved. */
function StandaloneStager({ upload }: { upload: JournalComposerActions["upload"] }) {
  const stager = useEvidenceStager({ defaultLabel: defaultLabelForTiming("BEFORE_ENTRY"), uploader: upload });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    const results = await stager.uploadAll(TRADE_ID);
    stager.clearUploaded();
    setSaving(false);
    setMessage(uploadSummary(results).message);
  };

  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-surface p-3">
      <EvidenceStager stager={stager} disabled={saving} title="Plan Trade: screenshots are saved with the draft" />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" loading={saving} loadingText="Saving…" disabled={stager.pendingCount === 0} onClick={save}>
          Save staged screenshots
        </Button>
        <p role="status" className="t-caption">
          {message}
        </p>
      </div>
    </div>
  );
}
