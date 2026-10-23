// biome-ignore-all lint/performance/noImgElement: owner-only evidence images are served privately (no-store) and must not enter the image optimizer cache.
"use client";

import { ChevronLeft, ChevronRight, ExternalLink, Pencil, Sparkles, Trash2, TriangleAlert, X } from "lucide-react";
import { unstable_rethrow } from "next/navigation";
import { Dialog as RadixDialog } from "radix-ui";
import { type FormEvent, type KeyboardEvent, type TouchEvent, useEffect, useId, useRef, useState, useTransition } from "react";
import { type ActionState, idleState } from "@/app/actions/state";
import { relabelEvidence, removeEvidence } from "@/app/actions/trades";
import { isTypingTarget } from "@/components/shell/shortcuts";
import { useTimeFormat } from "@/components/shell/time-display";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses, IconButton } from "@/components/ui/button";
import { CONFIRM_FAILED_MESSAGE, ConfirmDialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { FormAlert } from "@/components/ui/form-alert";
import { Input, Select } from "@/components/ui/input";
import { TechnicalDetails } from "@/components/ui/technical-details";
import { TIMING_LABELS } from "@/domain/timeline";
import { type GalleryItem, galleryItemName } from "./gallery-model";
import { EVIDENCE_LABEL_OPTION_TEXT, EVIDENCE_LABEL_TEXT, labelOptionsForTiming, TIMEFRAME_TEXT } from "./labels";
import { type EvidenceLabel, isEvidenceLabel, isTimeframe, MAX_CAPTION_LENGTH, type Timeframe, TIMEFRAMES } from "./types";

/**
 * Fullscreen evidence viewer (docs/V2_ARCHITECTURE.md §7.5): ←/→ (and swipes) move between screenshots,
 * Esc closes. Shows the caption, label, timing band, recorded time in the person's time display, and the
 * "Copied from an earlier trade" note of duplicates. V2 screenshots can be relabelled; any active
 * screenshot can be removed after a confirmation. Both are soft and audited: the timing never changes and
 * the timeline keeps a record of removals.
 */

/** §12.2 actions the viewer calls: `relabelEvidence` and `removeEvidence` (src/app/actions/trades.ts). */
export interface EvidenceActions {
  /** Fields `evidenceId`, `label`, `timeframe?`, `caption?`. */
  relabel(prev: ActionState, form: FormData): Promise<ActionState>;
  /** Fields `evidenceId`, `kind` (V2 | LEGACY). */
  remove(prev: ActionState, form: FormData): Promise<ActionState>;
}

export const EVIDENCE_ACTIONS: EvidenceActions = { relabel: relabelEvidence, remove: removeEvidence };

export interface EvidenceViewerProps {
  /** Screenshots in browsing order (the gallery passes its active items band by band). */
  items: readonly GalleryItem[];
  /** Index of the open screenshot; null keeps the viewer closed. */
  index: number | null;
  /** Called with the new index when browsing, and with null when the viewer closes. */
  onIndexChange(index: number | null): void;
  developerMode?: boolean;
  /** Overrides the server actions (demos and tests). */
  actions?: EvidenceActions;
  /** Called after a screenshot was removed; the viewer has closed (move focus somewhere that still exists). */
  onRemoved?(item: GalleryItem): void;
}

type Formatter = ReturnType<typeof useTimeFormat>;

function safe(format: () => string): string {
  try {
    return format();
  } catch {
    return "—";
  }
}

/** "Oct 14, 09:42 UTC−5" in the person's time display. */
export function recordedTimeText(format: Formatter, at: string): string {
  return safe(() => `${format.dateTime(at)} ${format.zone(at)}`);
}

/** "Copied from an earlier trade · originally recorded Oct 12, 08:10" (spec §7.4). */
export function copiedNoteText(format: Formatter, copiedFrom: { recordedAt: string | null }): string {
  const at = copiedFrom.recordedAt;
  return at ? `Copied from an earlier trade · originally recorded ${safe(() => format.dateTime(at))}` : "Copied from an earlier trade";
}

/** Facts of one screenshot as a definition list (used by the viewer's side panel). */
export function EvidenceDetails({ item }: { item: GalleryItem }) {
  const format = useTimeFormat();
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="text-text-2">Label</dt>
        <dd className="font-medium text-text">{EVIDENCE_LABEL_TEXT[item.label]}</dd>
        <dt className="text-text-2">Timeframe</dt>
        <dd className="text-text">{item.timeframe ? TIMEFRAME_TEXT[item.timeframe] : "Not set"}</dd>
        <dt className="text-text-2">Timing</dt>
        <dd className="text-text">{TIMING_LABELS[item.timing]}</dd>
        <dt className="text-text-2">Recorded</dt>
        <dd className="num text-text">
          <time dateTime={item.recordedAt}>{recordedTimeText(format, item.recordedAt)}</time>
        </dd>
      </dl>
      {item.caption && <p className="whitespace-pre-wrap break-words text-text">{item.caption}</p>}
      {(item.flags ?? []).map(flag => (
        <p key={flag} className="t-meta flex items-start gap-1.5 text-warn">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{flag}</span>
        </p>
      ))}
      {item.copiedFrom && <p className="t-meta">{copiedNoteText(format, item.copiedFrom)}</p>}
      {item.usedByAi && (
        <p className="t-meta flex items-center gap-1.5">
          <Sparkles aria-hidden="true" className="size-4 shrink-0" />
          <span>Used in an AI analysis of this trade</span>
        </p>
      )}
      {item.removed && <p className="t-meta">Removed from the gallery. The timeline keeps a record of it.</p>}
      {item.kind === "LEGACY" && !item.removed && <p className="t-caption">This screenshot's label comes from its timeframe and can't be edited.</p>}
    </div>
  );
}

const SWIPE_DISTANCE = 56;

export function EvidenceViewer({ items, index, onIndexChange, developerMode, actions = EVIDENCE_ACTIONS, onRemoved }: EvidenceViewerProps) {
  const open = index !== null && index >= 0 && index < items.length;
  const item = open ? items[index] : null;
  // Keyed by screenshot, so browsing to another one leaves edit mode and drops the last notice.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [imageState, setImageState] = useState<{ src: string; state: "loaded" | "error" } | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const removed = useRef(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const editing = item !== null && editingId === item.id;

  // The open screenshot disappeared (for example after a refresh): close instead of showing another one.
  useEffect(() => {
    if (index !== null && !open) onIndexChange(null);
  }, [index, open, onIndexChange]);

  const go = (step: -1 | 1) => {
    if (index === null) return;
    const next = index + step;
    if (next >= 0 && next < items.length) onIndexChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (editing || confirming || isTypingTarget(event.target)) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      go(1);
    }
  };

  const onTouchStart = (event: TouchEvent) => {
    touchStart.current = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
  };
  const onTouchEnd = (event: TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch || editing) return;
    const dx = touch.clientX - start.x;
    if (Math.abs(dx) >= SWIPE_DISTANCE && Math.abs(dx) > Math.abs(touch.clientY - start.y) * 1.5) go(dx < 0 ? 1 : -1);
  };

  const confirmRemove = async () => {
    if (!item) return false;
    const form = new FormData();
    form.set("evidenceId", item.id);
    form.set("kind", item.kind);
    const result = await actions.remove(idleState, form);
    if (result.status === "success") {
      removed.current = true;
      onIndexChange(null);
      onRemoved?.(item);
    }
    return result;
  };

  const name = item ? galleryItemName(item) : "";
  const imageLoaded = item !== null && imageState?.src === item.fullUrl && imageState.state === "loaded";
  const imageFailed = item !== null && imageState?.src === item.fullUrl && imageState.state === "error";

  return (
    <RadixDialog.Root open={open} onOpenChange={next => !next && onIndexChange(null)}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay" />
        {item && index !== null && (
          <RadixDialog.Content
            ref={content}
            tabIndex={-1}
            onOpenAutoFocus={event => {
              event.preventDefault();
              content.current?.focus();
            }}
            onCloseAutoFocus={event => {
              // The removed screenshot's tile is about to disappear; `onRemoved` moves focus instead.
              if (removed.current) {
                event.preventDefault();
                removed.current = false;
              }
            }}
            onKeyDown={onKeyDown}
            className="fixed inset-0 z-[51] flex flex-col overflow-y-auto bg-surface-raised text-text shadow-raised outline-none md:inset-6 md:overflow-hidden md:rounded-card md:border md:border-border"
          >
            <header className="flex items-center gap-2 border-b border-border px-3 py-2 md:px-4">
              <div className="min-w-0 flex-1">
                <RadixDialog.Title className="truncate text-base font-semibold text-text">{name}</RadixDialog.Title>
                <RadixDialog.Description className="t-caption">
                  <span className="num">
                    {index + 1} of {items.length}
                  </span>{" "}
                  · {TIMING_LABELS[item.timing]}
                  <span className="hidden md:inline"> · ← → to browse, Esc to close</span>
                </RadixDialog.Description>
              </div>
              <IconButton label="Previous screenshot" icon={<ChevronLeft />} disabled={index === 0} onClick={() => go(-1)} />
              <IconButton label="Next screenshot" icon={<ChevronRight />} disabled={index === items.length - 1} onClick={() => go(1)} />
              <RadixDialog.Close asChild>
                <IconButton label="Close viewer" icon={<X />} />
              </RadixDialog.Close>
            </header>
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              <figure className="relative min-h-[50dvh] flex-1 bg-surface-sunken md:min-h-0" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
                {!imageLoaded && !imageFailed && <img src={item.thumbUrl} alt="" aria-hidden="true" className="absolute inset-0 size-full object-contain p-2 opacity-60 blur-[2px]" />}
                {imageFailed ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
                    <p className="font-medium text-text">This image couldn't be loaded.</p>
                    <a className={buttonClasses({ variant: "link" })} href={item.fullUrl} target="_blank" rel="noreferrer">
                      Try opening it in a new tab
                    </a>
                  </div>
                ) : (
                  <img
                    key={item.fullUrl}
                    src={item.fullUrl}
                    alt={item.caption ? `${name}: ${item.caption}` : name}
                    decoding="async"
                    onLoad={() => setImageState({ src: item.fullUrl, state: "loaded" })}
                    onError={() => setImageState({ src: item.fullUrl, state: "error" })}
                    className="absolute inset-0 size-full object-contain p-2"
                  />
                )}
              </figure>
              <aside aria-label="Screenshot details" className="flex w-full shrink-0 flex-col gap-4 border-t border-border p-4 md:w-80 md:overflow-y-auto md:border-l md:border-t-0">
                <div className="flex flex-wrap gap-1.5">
                  <Badge>{EVIDENCE_LABEL_TEXT[item.label]}</Badge>
                  {item.timeframe && <Badge>{TIMEFRAME_TEXT[item.timeframe]}</Badge>}
                </div>
                {editing && item.kind === "V2" && !item.removed ? (
                  <EvidenceRelabelForm
                    key={item.id}
                    item={item}
                    actions={actions}
                    onCancel={() => setEditingId(null)}
                    onSaved={message => {
                      setEditingId(null);
                      setNotice({ id: item.id, text: message });
                    }}
                  />
                ) : (
                  <EvidenceDetails item={item} />
                )}
                <p role="status" className="t-meta text-pos empty:sr-only">
                  {notice?.id === item.id ? notice.text : null}
                </p>
                {!editing && (
                  <div className="flex flex-wrap gap-2">
                    {item.kind === "V2" && !item.removed && (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Pencil aria-hidden="true" />}
                        onClick={() => {
                          setNotice(null);
                          setEditingId(item.id);
                        }}
                      >
                        Edit label
                      </Button>
                    )}
                    {!item.removed && (
                      <ConfirmDialog
                        trigger={
                          <Button variant="secondary" size="sm" icon={<Trash2 aria-hidden="true" />}>
                            Remove
                          </Button>
                        }
                        onOpenChange={setConfirming}
                        title="Remove this screenshot?"
                        description="It leaves the gallery and the AI selection. The timeline keeps a record of it with its original timing."
                        confirmLabel="Remove screenshot"
                        pendingLabel="Removing…"
                        tone="danger"
                        onConfirm={confirmRemove}
                      />
                    )}
                    <a className={buttonClasses({ variant: "ghost", size: "sm" })} href={item.fullUrl} target="_blank" rel="noreferrer">
                      <ExternalLink aria-hidden="true" />
                      Open full size
                    </a>
                  </div>
                )}
                <TechnicalDetails developerMode={developerMode}>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-xs">
                    <dt>evidence id</dt>
                    <dd className="break-all">{item.id}</dd>
                    <dt>kind</dt>
                    <dd>{item.kind}</dd>
                    <dt>label / timeframe</dt>
                    <dd>
                      {item.label} / {item.timeframe ?? "null"}
                    </dd>
                    <dt>timing</dt>
                    <dd>{item.timing}</dd>
                    <dt>recorded at</dt>
                    <dd className="break-all">{item.recordedAt}</dd>
                    <dt>size</dt>
                    <dd>
                      {item.width} × {item.height}
                    </dd>
                  </dl>
                </TechnicalDetails>
              </aside>
            </div>
          </RadixDialog.Content>
        )}
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export interface EvidenceRelabelFormProps {
  /** A V2 screenshot that is not removed (legacy screenshots can't be relabelled). */
  item: GalleryItem;
  actions: EvidenceActions;
  onCancel(): void;
  /** Called with the confirmation to announce after the label was saved. */
  onSaved(message: string): void;
}

type RelabelField = "label" | "timeframe" | "caption";

/**
 * The viewer's relabel form. Labels are limited by the screenshot's timing (spec §7.1, §5.3): Pre-entry is
 * only offered before entry, so a later screenshot can't be relabelled into pre-entry evidence; the
 * current label always stays selectable.
 */
export function EvidenceRelabelForm({ item, actions, onCancel, onSaved }: EvidenceRelabelFormProps) {
  const labelOptions = labelOptionsForTiming(item.timing, item.label);
  const [label, setLabel] = useState<EvidenceLabel>(item.label);
  const [timeframe, setTimeframe] = useState<Timeframe | "">(item.timeframe ?? "");
  const [caption, setCaption] = useState(item.caption ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<RelabelField, string>>>({});
  const [pending, startTransition] = useTransition();
  const labelId = useId();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData();
    form.set("evidenceId", item.id);
    form.set("label", label);
    if (timeframe) form.set("timeframe", timeframe);
    if (caption.trim()) form.set("caption", caption.trim());
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      let result: ActionState;
      try {
        result = await actions.relabel(idleState, form);
      } catch (thrown) {
        unstable_rethrow(thrown);
        result = { status: "error", message: CONFIRM_FAILED_MESSAGE };
      }
      startTransition(() => {
        if (result.status === "error") {
          setError(result.message);
          setFieldErrors(pickFieldErrors(result.fieldErrors));
        } else onSaved(result.status === "success" && result.message ? result.message : "Label saved. The screenshot keeps its original timing.");
      });
    });
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit} aria-labelledby={labelId}>
      <p id={labelId} className="font-medium text-text">
        Edit label
      </p>
      {error && <FormAlert tone="error">{error}</FormAlert>}
      <Field label="Label" error={fieldErrors.label}>
        <Select value={label} onChange={event => isEvidenceLabel(event.target.value) && labelOptions.includes(event.target.value) && setLabel(event.target.value)} disabled={pending}>
          {labelOptions.map(value => (
            <option key={value} value={value}>
              {EVIDENCE_LABEL_OPTION_TEXT[value]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Timeframe" optional error={fieldErrors.timeframe}>
        <Select value={timeframe} onChange={event => setTimeframe(isTimeframe(event.target.value) ? event.target.value : "")} disabled={pending}>
          <option value="">Not set</option>
          {TIMEFRAMES.map(value => (
            <option key={value} value={value}>
              {TIMEFRAME_TEXT[value]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Caption" optional hint={`Up to ${MAX_CAPTION_LENGTH} characters.`} error={fieldErrors.caption}>
        <Input value={caption} maxLength={MAX_CAPTION_LENGTH} onChange={event => setCaption(event.target.value)} disabled={pending} />
      </Field>
      <p className="t-caption">The timing stays {TIMING_LABELS[item.timing]}: relabelling never changes when a screenshot was recorded.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={pending} loadingText="Saving…">
          Save label
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function pickFieldErrors(errors: Record<string, string> | undefined): Partial<Record<RelabelField, string>> {
  const picked: Partial<Record<RelabelField, string>> = {};
  for (const key of ["label", "timeframe", "caption"] as const) if (errors?.[key]) picked[key] = errors[key];
  return picked;
}
