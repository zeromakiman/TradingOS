"use client";

import { ArrowRight, ChevronUp, ImagePlus, NotebookPen } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, type ReactNode, type Ref, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { focusLost } from "@/components/accounts/focus";
import { EvidenceStager } from "@/components/evidence/evidence-stager";
import { EvidencePasteTarget } from "@/components/evidence/paste-target";
import { uploadSummary } from "@/components/evidence/upload";
import { useEvidenceStager } from "@/components/evidence/use-evidence-stager";
import { JournalComposer } from "@/components/trade/journal/composer";
import { Button, buttonClasses } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { FormAlert } from "@/components/ui/form-alert";
import { useOptionalToast } from "@/components/ui/toast";
import { NOTE_KEPT_COPY, SCREENSHOT_SAVED_AS, SCREENSHOTS_KEPT_COPY, UNSAVED_BADGE } from "./copy";
import { liveCardId, livePanelIds, tradeIdOfCard } from "./dom-ids";
import { LiveDuration } from "./live-duration";
import { anyPanelShown, type CardPanels, cardPanels, hidePanel, type LivePanel, type LivePanelsState, openPanel } from "./live-panels-model";
import { useKeptDraft } from "./use-kept-draft";

/**
 * Inline actions of Today's live trade cards (docs/V2_ARCHITECTURE.md §14.1, §3.6, §7.1): Add note opens the shared
 * live journal composer for that trade, Paste screenshot opens a capture panel (Ctrl/⌘+V anywhere on the page, drop,
 * or pick files; saved through the evidence upload), Close trade and Open lead to the trade. A closed panel stays
 * mounted, hidden, so a typed note or staged screenshots are never lost, and its button says "Unsaved" while it holds
 * them; only one capture panel is in view at a time (`live-panels-model.ts`). On phones a quick-action dock above the
 * tab bar keeps Note, Screenshot and Close trade in thumb reach for the live trade in view.
 */

interface LivePanelsApi {
  card(tradeId: string): CardPanels;
  toggle(tradeId: string, panel: LivePanel): void;
  /** Opens a panel; from the dock, the card is brought into view as well. */
  open(tradeId: string, panel: LivePanel, options?: { fromDock?: boolean }): void;
  hide(tradeId: string, panel: LivePanel): void;
  anyShown: boolean;
}

const LivePanelsContext = createContext<LivePanelsApi | null>(null);

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function LivePanelsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LivePanelsState>({});
  const requests = useRef(0);
  const open = useCallback((tradeId: string, panel: LivePanel, options: { fromDock?: boolean } = {}) => {
    requests.current += 1;
    const focus = { panel, key: requests.current, preventScroll: options.fromDock === true };
    setState(current => openPanel(current, tradeId, panel, focus));
    if (options.fromDock) {
      window.requestAnimationFrame(() => {
        document.getElementById(liveCardId(tradeId))?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      });
    }
  }, []);
  const hide = useCallback((tradeId: string, panel: LivePanel) => setState(current => hidePanel(current, tradeId, panel)), []);
  const api = useMemo<LivePanelsApi>(() => ({
    card: tradeId => cardPanels(state, tradeId),
    toggle: (tradeId, panel) => (cardPanels(state, tradeId).shown[panel] ? hide(tradeId, panel) : open(tradeId, panel)),
    open,
    hide,
    anyShown: anyPanelShown(state),
  }), [state, open, hide]);
  return (
    <LivePanelsContext.Provider value={api}>
      {/* Captures nothing: while no capture panel is open, a file dropped on the page can't replace it (and unsaved notes). */}
      <EvidencePasteTarget disabled onFiles={() => undefined} />
      {children}
    </LivePanelsContext.Provider>
  );
}

function useLivePanels(): LivePanelsApi {
  const api = useContext(LivePanelsContext);
  if (!api) throw new Error("Live trade actions must be rendered inside <LivePanelsProvider>.");
  return api;
}

export interface LiveActionsTrade {
  id: string;
  /** "EURUSD · Long". */
  title: string;
  href: string;
  closeHref: string;
  requestKey: string;
  instrument: { tickSize: string; quantityStep: string | null } | null;
  screenshotCapacity: number;
}

function ScreenshotPanel({ trade, hidden, onDone }: { trade: LiveActionsTrade; hidden: boolean; onDone: () => void }) {
  const router = useRouter();
  const toast = useOptionalToast();
  const stager = useEvidenceStager({ defaultLabel: "MANAGEMENT", max: trade.screenshotCapacity });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failure, setFailure] = useState<{ text: string; key: number } | null>(null);
  const ids = livePanelIds(trade.id);

  const save = async () => {
    if (busy || stager.pendingCount === 0) return;
    setBusy(true);
    setFailure(null);
    const results = await stager.uploadAll(trade.id, { onProgress: (done, total) => setProgress({ done, total }) });
    const summary = uploadSummary(results);
    setBusy(false);
    setProgress(null);
    if (summary.saved > 0) {
      stager.clearUploaded();
      router.refresh();
    }
    if (summary.failed > 0) {
      setFailure({ text: summary.message, key: Date.now() });
      return;
    }
    toast?.toast({ title: summary.message, description: trade.title, tone: "positive" });
    onDone();
  };

  // The panel stays mounted when closed, so throwing staged screenshots away is an explicit choice.
  const discard = () => {
    stager.clear();
    setFailure(null);
    onDone();
  };

  const pending = stager.pendingCount;
  const busyLabel = progress && progress.total > 0 ? `Saving ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…` : "Saving…";
  return (
    <section
      id={ids.screenshot}
      tabIndex={-1}
      aria-label={`Screenshots for ${trade.title}`}
      className="flex flex-col gap-3 rounded-card border border-border p-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {/* Takes Ctrl/⌘+V and dropped files only while in view; at most one capture panel is in view on the page. */}
      <EvidencePasteTarget disabled={busy || hidden} onFiles={(files, method) => stager.addFiles(files, method)} />
      {failure && (
        <FormAlert key={failure.key} tone="error">
          {failure.text}
        </FormAlert>
      )}
      {trade.screenshotCapacity === 0 ? (
        <p className="t-meta">This trade already has 24 screenshots. Remove one on the trade page before adding another.</p>
      ) : (
        // One staged image per row: the stager lays them out two-up from the `sm` viewport, too tight inside a card.
        <div className="[&_ul]:grid-cols-1">
          <EvidenceStager stager={stager} disabled={busy} title={`Add screenshots to ${trade.title}`} />
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="t-caption min-w-0 sm:flex-1">{SCREENSHOT_SAVED_AS}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={pending > 0 ? discard : onDone}>
            {pending > 0 ? "Discard" : "Cancel"}
          </Button>
          <Button type="button" size="sm" disabled={pending === 0} loading={busy} loadingText={busyLabel} onClick={save}>
            {pending > 1 ? `Save ${pending} screenshots` : "Save screenshot"}
          </Button>
        </div>
      </div>
    </section>
  );
}

function UnsavedBadge() {
  return (
    <span aria-hidden="true" className="rounded-pill bg-warn-soft px-1.5 text-[0.6875rem] leading-4 font-semibold text-warn">
      {UNSAVED_BADGE}
    </span>
  );
}

interface ToggleSpec {
  panel: LivePanel;
  icon: ReactNode;
  label: ReactNode;
  /** Start of the accessible name ("Add note"); the trade's title follows. */
  name: string;
  /** The hidden panel still holds unsaved work. */
  kept: boolean;
  keptCopy: string;
  ref?: Ref<HTMLButtonElement>;
}

/** The action row and the panels of one live trade card. */
export function LiveTradeActions({ trade }: { trade: LiveActionsTrade }) {
  const panels = useLivePanels();
  const card = panels.card(trade.id);
  const ids = livePanelIds(trade.id);
  const noteBox = useRef<HTMLDivElement>(null);
  const shotBox = useRef<HTMLDivElement>(null);
  const shotToggle = useRef<HTMLButtonElement>(null);
  const noteKept = useKeptDraft(noteBox, card.kept.note && !card.shown.note);
  const shotKept = useKeptDraft(shotBox, card.kept.screenshot && !card.shown.screenshot);

  // Each opening moves focus into its panel: the composer's field, or the capture panel (Ctrl/⌘+V works from there).
  const request = card.focus;
  useEffect(() => {
    if (!request) return;
    document.getElementById(request.panel === "note" ? ids.composer : ids.screenshot)?.focus({ preventScroll: request.preventScroll });
  }, [request, ids.composer, ids.screenshot]);

  // Saved, cancelled or discarded: focus returns to the button that opened the panel, unless the trader is elsewhere.
  const finishScreenshots = () => {
    const wasInside = shotBox.current?.contains(document.activeElement) ?? false;
    panels.hide(trade.id, "screenshot");
    if (wasInside || focusLost()) shotToggle.current?.focus();
  };

  const toggleButton = ({ panel, icon, label, name, kept, keptCopy, ref }: ToggleSpec) => {
    const expanded = card.shown[panel];
    return (
      <Button
        ref={ref}
        type="button"
        variant="secondary"
        size="sm"
        icon={expanded ? <ChevronUp aria-hidden="true" /> : icon}
        aria-expanded={expanded}
        aria-controls={card.kept[panel] ? ids[panel] : undefined}
        aria-label={`${name}: ${trade.title}${kept ? ` (${keptCopy})` : ""}`}
        className={cx(expanded && "border-accent bg-accent-soft text-accent")}
        onClick={() => panels.toggle(trade.id, panel)}
      >
        {label}
        {kept && <UnsavedBadge />}
      </Button>
    );
  };
  return (
    <div className="flex flex-col gap-3">
      {/* Phones: two even rows of two (journal actions, then leave the card); wider: one row, whose second pair wraps
          as a pair, right-aligned, when the first one grows. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center [&>*]:max-sm:w-full">
          {toggleButton({ panel: "note", icon: <NotebookPen aria-hidden="true" />, label: "Add note", name: "Add note", kept: noteKept, keptCopy: NOTE_KEPT_COPY })}
          {toggleButton({
            panel: "screenshot",
            icon: <ImagePlus aria-hidden="true" />,
            label: (
              <>
                <span className="max-sm:hidden">Paste screenshot</span>
                <span className="sm:hidden">Screenshot</span>
              </>
            ),
            name: "Paste screenshot",
            kept: shotKept,
            keptCopy: SCREENSHOTS_KEPT_COPY,
            ref: shotToggle,
          })}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:ml-auto sm:flex sm:items-center [&>*]:max-sm:w-full">
          <Link
            href={trade.closeHref}
            className={cx(buttonClasses({ variant: "ghost", size: "sm" }), "max-sm:border-border-strong max-sm:text-1")}
            aria-label={`Close trade: ${trade.title}`}
          >
            Close trade
          </Link>
          <Link href={trade.href} className={buttonClasses({ variant: "secondary", size: "sm" })} aria-label={`Open ${trade.title}`}>
            Open
            <ArrowRight aria-hidden="true" />
          </Link>
        </div>
      </div>
      {card.kept.note && (
        // `relative overflow-x-clip`: on phones the composer's entry-type chips scroll sideways, and their visually
        // hidden radios (absolutely positioned) would otherwise widen the whole page past the screen.
        <div ref={noteBox} id={ids.note} hidden={!card.shown.note} className="relative overflow-x-clip">
          <JournalComposer
            tradeId={trade.id}
            timingHint="WHILE_LIVE"
            instrument={trade.instrument}
            requestKey={trade.requestKey}
            capture="composer"
            maxScreenshots={trade.screenshotCapacity}
            id={ids.composer}
          />
        </div>
      )}
      {card.kept.screenshot && (
        <div ref={shotBox} hidden={!card.shown.screenshot}>
          <ScreenshotPanel trade={trade} hidden={!card.shown.screenshot} onDone={finishScreenshots} />
        </div>
      )}
    </div>
  );
}

export interface DockTrade {
  id: string;
  title: string;
  since: string;
  closeHref: string;
}

/** The live trade whose card is most visible; the first one until the cards are measured. */
function useTradeInView(trades: readonly DockTrade[]): string | null {
  const [inView, setInView] = useState<string | null>(trades[0]?.id ?? null);
  const key = trades.map(trade => trade.id).join(",");
  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (ids.length < 2 || typeof IntersectionObserver === "undefined") return;
    const ratios = new Map<string, number>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) ratios.set(entry.target.id, entry.intersectionRatio);
      const best = [...ratios.entries()].filter(([, ratio]) => ratio > 0).sort((a, b) => b[1] - a[1])[0];
      const tradeId = best ? tradeIdOfCard(best[0]) : null;
      if (tradeId) setInView(tradeId);
    }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
    for (const id of ids) {
      const element = document.getElementById(liveCardId(id));
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [key]);
  return trades.some(trade => trade.id === inView) ? inView : (trades[0]?.id ?? null);
}

/** Phones only: Note, Screenshot and Close trade for the live trade in view, docked above the tab bar. */
export function LiveQuickDock({ trades, nowIso }: { trades: DockTrade[]; nowIso: string }) {
  const panels = useLivePanels();
  const targetId = useTradeInView(trades);
  const target = trades.find(trade => trade.id === targetId);
  // An open composer or capture panel needs the space (and the keyboard); the dock steps aside.
  if (!target || panels.anyShown) return null;
  return (
    <section
      aria-label="Quick actions for a live trade"
      className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-border bg-surface px-4 py-2 shadow-raised md:hidden"
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-1">{target.title}</p>
          <p className="t-caption flex items-center gap-1.5">
            <span aria-hidden="true" className="size-1.5 flex-none rounded-full bg-live" />
            <span className="truncate">
              Live{" "}
              <span className="num">
                <LiveDuration since={target.since} nowIso={nowIso} />
              </span>
            </span>
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<NotebookPen aria-hidden="true" />}
          aria-label={`Add note: ${target.title}`}
          onClick={() => panels.open(target.id, "note", { fromDock: true })}
        >
          Note
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<ImagePlus aria-hidden="true" />}
          aria-label={`Paste screenshot: ${target.title}`}
          onClick={() => panels.open(target.id, "screenshot", { fromDock: true })}
        >
          <span className="max-[419px]:sr-only">Screenshot</span>
        </Button>
        {/* Says what it does: a bare "Close" beside the dock's buttons would read as closing the dock. */}
        <Link href={target.closeHref} className={buttonClasses({ variant: "ghost", size: "sm", className: "flex-none" })} aria-label={`Close trade: ${target.title}`}>
          Close trade
        </Link>
      </div>
    </section>
  );
}
