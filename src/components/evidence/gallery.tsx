// biome-ignore-all lint/performance/noImgElement: owner-only evidence thumbnails are served privately (no-store) and must not enter the image optimizer cache.
"use client";

import { Check, Image as ImageIcon, Sparkles, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTimeFormat } from "@/components/shell/time-display";
import { useModifierKeyLabel } from "@/components/shell/use-media-query";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { EmptyState } from "@/components/ui/empty-state";
import { TechnicalDetails } from "@/components/ui/technical-details";
import { evidenceIdFromHash, evidenceTileId, type GalleryItem, galleryBands, galleryItemName } from "./gallery-model";
import { EVIDENCE_LABEL_TEXT, TIMEFRAME_TEXT } from "./labels";
import { useOptionalEvidenceSelection } from "./selection";
import { type EvidenceActions, EvidenceViewer } from "./viewer";

export type { GalleryItem } from "./gallery-model";

/**
 * Evidence gallery of a trade (docs/V2_ARCHITECTURE.md §7.5): active screenshots grouped into Before
 * entry / While live / After close, large thumbnails (at least 240px wide on desktop, two per row on
 * phones) with label, timeframe and time chips. Selecting a tile opens the fullscreen viewer; so does an
 * `#evidence-<id>` link anywhere on the page (timeline thumbnails, AI source chips). With `selectable`
 * inside an `<EvidenceSelectionProvider>`, each tile gets a "use for AI" checkbox and selected tiles show
 * "Selected for AI". Removed screenshots are not shown here; the timeline keeps them.
 */

export interface EvidenceGalleryProps {
  items: GalleryItem[];
  tradeId: string;
  selectable?: boolean;
  developerMode?: boolean;
  /** Overrides the viewer's server actions (demos and tests). */
  actions?: EvidenceActions;
  /** Heading level of the band titles (default 3, under the Evidence section's h2). */
  headingLevel?: 3 | 4;
}

type Announcement = { text: string; count: number };

export function EvidenceGallery({ items, tradeId, selectable = false, developerMode, actions, headingLevel = 3 }: EvidenceGalleryProps) {
  const bands = useMemo(() => galleryBands(items), [items]);
  const ordered = useMemo(() => bands.flatMap(band => band.items), [bands]);
  const removedCount = items.filter(item => item.removed).length;
  const [openId, setOpenId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement>({ text: "", count: 0 });
  const selection = useOptionalEvidenceSelection();
  const canSelect = selectable && selection !== null && selection.max > 0;
  const format = useTimeFormat();
  const modifier = useModifierKeyLabel();
  const root = useRef<HTMLDivElement>(null);
  const Heading = `h${headingLevel}` as const;

  const announce = useCallback((text: string) => setAnnouncement(previous => ({ text, count: previous.count + 1 })), []);
  const openIndex = openId === null ? -1 : ordered.findIndex(item => item.id === openId);

  // `#evidence-<id>` (a timeline thumbnail or an AI source chip) opens the viewer on that screenshot.
  useEffect(() => {
    const openFromHash = () => {
      const id = evidenceIdFromHash(window.location.hash);
      if (id !== null && ordered.some(item => item.id === id)) setOpenId(id);
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, [ordered]);

  // Screenshots that left the gallery leave the AI selection too.
  const selected = selection?.selected;
  const deselect = selection?.deselect;
  useEffect(() => {
    if (!canSelect || !selected || !deselect) return;
    const active = new Set(ordered.map(item => item.id));
    for (const id of selected) if (!active.has(id)) deselect(id);
  }, [canSelect, ordered, selected, deselect]);

  const changeIndex = useCallback((index: number | null) => {
    if (index !== null) {
      setOpenId(ordered[index]?.id ?? null);
      return;
    }
    setOpenId(null);
    // Clear an opening hash so the same link opens the viewer again next time.
    if (evidenceIdFromHash(window.location.hash) !== null) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  }, [ordered]);

  const onRemoved = useCallback((item: GalleryItem) => {
    deselect?.(item.id);
    announce(`${galleryItemName(item)} removed. The timeline keeps a record of it.`);
    // Focus moves to another screenshot (the removed tile is about to disappear), or to the gallery when none is left.
    requestAnimationFrame(() => {
      const next = root.current?.querySelector<HTMLElement>(`li:not([id="${evidenceTileId(item.id)}"]) button`);
      (next ?? root.current)?.focus();
    });
  }, [announce, deselect]);

  const toggle = (item: GalleryItem) => {
    if (!selection) return;
    const name = galleryItemName(item);
    if (selection.isSelected(item.id)) {
      selection.toggle(item.id);
      announce(`${name} is no longer selected for AI.`);
    } else if (selection.selected.length >= selection.max) {
      announce(`Up to ${selection.max} screenshots can be selected for AI. Deselect one first.`);
    } else {
      selection.toggle(item.id);
      announce(`${name} selected for AI, ${selection.selected.length + 1} of ${selection.max}.`);
    }
  };

  const days = new Set(ordered.map(item => safeText(() => format.day(item.recordedAt))));
  const timeText = (item: GalleryItem) => safeText(() => (days.size > 1 ? format.dateTime(item.recordedAt) : format.time(item.recordedAt)));

  return (
    <div ref={root} tabIndex={-1} className="flex flex-col gap-5 outline-none">
      {ordered.length === 0 ? (
        <EmptyState
          compact
          icon={<ImageIcon />}
          title="No screenshots yet."
          description={`Paste (${modifier === "⌘" ? "⌘V" : "Ctrl+V"}), drop or attach chart screenshots. They appear here grouped by when they were recorded.`}
        />
      ) : (
        <>
          {canSelect && selection && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-border bg-surface-sunken px-3 py-2">
              <p className="t-meta flex items-center gap-1.5">
                <Sparkles aria-hidden="true" className="size-4 shrink-0" />
                <span>
                  Select up to {selection.max} screenshot{selection.max === 1 ? "" : "s"} for AI ·{" "}
                  <span className="num">{selection.selected.length} selected</span>
                </span>
              </p>
              {selection.selected.length > 0 && (
                <Button variant="link" size="sm" onClick={() => { selection.clear(); announce("AI selection cleared."); }}>
                  Clear selection
                </Button>
              )}
            </div>
          )}
          {bands.map(band => (
            <section key={band.timing} className="flex flex-col gap-2">
              <Heading className="flex items-baseline gap-2 text-sm font-semibold text-text">
                {band.label}
                <span className="t-caption num font-normal">
                  {band.items.length}
                  <span className="sr-only"> screenshot{band.items.length === 1 ? "" : "s"}</span>
                </span>
              </Heading>
              <ul className="grid grid-cols-2 gap-3 md:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]">
                {band.items.map(item => (
                  <GalleryTile
                    key={item.id}
                    item={item}
                    timeText={timeText(item)}
                    selectable={canSelect}
                    selected={canSelect && (selection?.isSelected(item.id) ?? false)}
                    onOpen={() => setOpenId(item.id)}
                    onToggle={() => toggle(item)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
      {removedCount > 0 && (
        <p className="t-caption">
          {removedCount === 1 ? "1 removed screenshot is" : `${removedCount} removed screenshots are`} kept in the timeline.
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement.text ? <span key={announcement.count}>{announcement.text}</span> : null}
      </p>
      {items.length > 0 && (
        <TechnicalDetails developerMode={developerMode}>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-xs">
            <dt>trade id</dt>
            <dd className="break-all">{tradeId}</dd>
            {items.map(item => (
              <div key={item.id} className="contents">
                <dt>{item.kind.toLowerCase()} evidence</dt>
                <dd className="break-all">
                  {item.id} · {item.timing}
                  {item.removed ? " · removed" : ""}
                </dd>
              </div>
            ))}
          </dl>
        </TechnicalDetails>
      )}
      <EvidenceViewer
        items={ordered}
        index={openIndex === -1 ? null : openIndex}
        onIndexChange={changeIndex}
        developerMode={developerMode}
        actions={actions}
        onRemoved={onRemoved}
      />
    </div>
  );
}

function safeText(format: () => string): string {
  try {
    return format();
  } catch {
    return "—";
  }
}

interface GalleryTileProps {
  item: GalleryItem;
  timeText: string;
  selectable: boolean;
  selected: boolean;
  onOpen(): void;
  onToggle(): void;
}

function GalleryTile({ item, timeText, selectable, selected, onOpen, onToggle }: GalleryTileProps) {
  const name = galleryItemName(item);
  return (
    <li id={evidenceTileId(item.id)} className="relative min-w-0 scroll-mt-24">
      <div className={cx("overflow-hidden rounded-card border bg-surface", selected ? "border-accent ring-2 ring-accent" : "border-border")}>
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${name}, recorded ${timeText}${selected ? ", selected for AI" : ""}`}
          className="relative block w-full cursor-zoom-in bg-surface-sunken"
        >
          <img src={item.thumbUrl} alt="" loading="lazy" decoding="async" width={item.width} height={item.height} className="aspect-[16/10] h-auto w-full object-contain" />
          {selected && (
            <StatusPill tone="info" icon={<Check aria-hidden="true" className="size-3.5" />} className="absolute bottom-2 left-2 shadow-raised">
              Selected for AI
            </StatusPill>
          )}
        </button>
        <div className="flex flex-col gap-1 p-2">
          <div className="flex flex-wrap items-center gap-1">
            <Badge>{EVIDENCE_LABEL_TEXT[item.label]}</Badge>
            {item.timeframe && <Badge>{TIMEFRAME_TEXT[item.timeframe]}</Badge>}
            <time className="t-caption num ml-auto" dateTime={item.recordedAt}>
              {timeText}
            </time>
          </div>
          {item.caption && <p className="t-meta line-clamp-2 break-words">{item.caption}</p>}
          {item.usedByAi && (
            <p className="t-caption flex items-center gap-1">
              <Sparkles aria-hidden="true" className="size-3.5 shrink-0" />
              Used by AI
            </p>
          )}
          {(item.flags ?? []).map(flag => (
            <p key={flag} className="t-caption flex items-start gap-1 text-warn">
              <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
              <span>{flag}</span>
            </p>
          ))}
        </div>
      </div>
      {selectable && (
        <label className="absolute right-1.5 top-1.5 grid size-10 cursor-pointer place-items-center rounded-control border border-border bg-surface/90 shadow-raised pointer-coarse:size-11">
          <input type="checkbox" className="size-5 cursor-pointer accent-[var(--accent)]" checked={selected} onChange={onToggle} aria-label={`Use ${name} (${timeText}) for AI`} />
        </label>
      )}
    </li>
  );
}
