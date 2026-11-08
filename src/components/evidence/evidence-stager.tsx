// biome-ignore-all lint/performance/noImgElement: previews are local object URLs of images that have not been uploaded yet.
"use client";

import { Camera, CircleAlert, CircleCheck, ImagePlus, LoaderCircle, RefreshCw, Upload, X } from "lucide-react";
import { type ChangeEvent, type DragEvent, type ReactNode, type RefObject, useRef, useState } from "react";
import { useModifierKeyLabel } from "@/components/shell/use-media-query";
import { Button, IconButton } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { cx } from "@/components/ui/cx";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { EVIDENCE_LABEL_OPTION_TEXT, evidenceTagText, labelOptionsForDefault, stagedFileName, TIMEFRAME_TEXT } from "./labels";
import { transferHasFiles } from "./paste-model";
import { isEditable, stagedAnnouncement } from "./stager-model";
import { ACCEPTED_IMAGE_INPUT, type CaptureMethod, isEvidenceLabel, isTimeframe, MAX_CAPTION_LENGTH, type StagedEvidence, TIMEFRAMES } from "./types";
import type { EvidenceStagerApi } from "./use-evidence-stager";

/**
 * Controls of staged screenshots (docs/V2_ARCHITECTURE.md §7.1): a drop zone, a multi-file picker and,
 * on touch devices, the camera (`accept="image/*" capture="environment"`); one preview per image with
 * its label, optional timeframe and caption, and remove or replace before anything is saved. `compact`
 * is the journal composer's variant: attach buttons and a horizontal strip of small previews, without
 * the large drop zone (the composer itself takes drops) and without captions.
 *
 * The layout follows the width the stager gets, not the page's (container queries): Plan Trade's evidence section, a
 * live trade's card on Today and a phone are all narrow. Previews sit two per row only in a wide stager, an image sits
 * beside its controls only where the card has room, and the label and timeframe selects share a line only when both
 * stay readable.
 */

export interface EvidenceStagerProps {
  stager: EvidenceStagerApi;
  compact?: boolean;
  /** Label, timeframe and caption controls on each preview (default true). */
  showLabels?: boolean;
  /** Blocks adding and editing, for example while the surrounding form saves. */
  disabled?: boolean;
  /** Heading of the drop zone (default "Add screenshots"). */
  title?: ReactNode;
}

type Announcement = { text: string; count: number };

export function EvidenceStager({ stager, compact = false, showLabels = true, disabled = false, title = "Add screenshots" }: EvidenceStagerProps) {
  const files = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [announcement, setAnnouncement] = useState<Announcement>({ text: "", count: 0 });
  const modifier = useModifierKeyLabel();
  const full = stager.remaining === 0;
  const blocked = disabled || full;

  const add = (incoming: File[], method: CaptureMethod) => {
    if (!incoming.length || disabled) return;
    const result = stager.addFiles(incoming, method);
    setAnnouncement(previous => ({ text: stagedAnnouncement(result.added.length, result.errors.length), count: previous.count + 1 }));
  };

  const picked = (method: CaptureMethod) => (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = Array.from(event.target.files ?? []);
    // Reset so choosing the same file again fires another change.
    event.target.value = "";
    add(chosen, method);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!transferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = blocked ? "none" : "copy";
    if (!over && !blocked) setOver(true);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!transferHasFiles(event.dataTransfer)) return;
    // Taken here: the page-level target sees `defaultPrevented` and leaves these files alone.
    event.preventDefault();
    setOver(false);
    if (!blocked) add(Array.from(event.dataTransfer.files), "DROP");
  };

  const pickers = (
    <>
      <Button type="button" variant="secondary" size="sm" icon={compact ? <ImagePlus aria-hidden="true" /> : <Upload aria-hidden="true" />} disabled={blocked} onClick={() => files.current?.click()}>
        {compact ? "Attach screenshots" : "Choose files"}
      </Button>
      <Button type="button" variant="secondary" size="sm" icon={<Camera aria-hidden="true" />} disabled={blocked} className="pointer-fine:hidden" onClick={() => camera.current?.click()}>
        Take photo
      </Button>
      <input ref={files} type="file" accept={ACCEPTED_IMAGE_INPUT} multiple hidden tabIndex={-1} onChange={picked("FILE")} />
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden tabIndex={-1} onChange={picked("CAMERA")} />
    </>
  );

  return (
    <div className={cx("@container flex min-w-0 flex-col", compact ? "gap-2" : "gap-3")}>
      {compact ? (
        <div className="flex flex-wrap items-center gap-2">
          {pickers}
          {full && <p className="t-caption">No more screenshots can be added here.</p>}
        </div>
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: dropping files is a pointer shortcut; the buttons inside offer the same with a keyboard.
        <div
          className={cx(
            "flex flex-col items-center gap-2 rounded-card border-2 border-dashed px-4 py-6 text-center transition-colors",
            over ? "border-accent bg-accent-soft" : "border-border-strong bg-surface-sunken",
            disabled && "opacity-60",
          )}
          onDragOver={onDragOver}
          onDragLeave={event => {
            // Moving between the zone's own children is not leaving it.
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOver(false);
          }}
          onDrop={onDrop}
        >
          <ImagePlus aria-hidden="true" className="size-6 text-text-3" />
          <p className="font-medium text-text">{title}</p>
          <p className="t-meta max-w-prose">
            Paste with {modifier === "⌘" ? "⌘V" : "Ctrl+V"}, drop images here, or choose files. PNG, JPEG or WEBP, up to 4 MB each.
          </p>
          <div className="flex flex-wrap justify-center gap-2">{pickers}</div>
          {full && <p className="t-caption">No more screenshots can be added here.</p>}
        </div>
      )}
      {stager.errors.length > 0 && (
        <Callout
          tone="warning"
          role="alert"
          title={stager.errors.length === 1 ? "A file wasn't added" : "Some files weren't added"}
          action={
            <Button type="button" variant="link" size="sm" onClick={stager.dismissErrors}>
              Dismiss
            </Button>
          }
        >
          <ul className="flex flex-col gap-0.5">
            {stager.errors.map(error => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </Callout>
      )}
      {stager.items.length > 0 && (
        <ul aria-label="Screenshots to save" className={compact ? "flex gap-2 overflow-x-auto pb-1" : "grid gap-3 @[64rem]:grid-cols-2"}>
          {stager.items.map(item =>
            compact ? (
              <CompactCard key={item.localId} item={item} stager={stager} showLabels={showLabels} disabled={disabled} />
            ) : (
              <StagedCard key={item.localId} item={item} stager={stager} showLabels={showLabels} disabled={disabled} />
            ),
          )}
        </ul>
      )}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement.text ? <span key={announcement.count}>{announcement.text}</span> : null}
      </p>
    </div>
  );
}

interface CardProps {
  item: StagedEvidence;
  stager: EvidenceStagerApi;
  showLabels: boolean;
  disabled: boolean;
}

function LabelSelect({ item, stager, name, disabled }: { item: StagedEvidence; stager: EvidenceStagerApi; name: string; disabled: boolean }) {
  // The stager's default label stands for its timing: Pre-entry is only offered before entry (spec §5.3, §7.1).
  const options = labelOptionsForDefault(stager.defaultLabel, item.label);
  return (
    <Field label={<>Label<span className="sr-only"> of {name}</span></>}>
      <Select
        value={item.label}
        disabled={disabled}
        onChange={event => isEvidenceLabel(event.target.value) && options.includes(event.target.value) && stager.update(item.localId, { label: event.target.value })}
      >
        {options.map(value => (
          <option key={value} value={value}>
            {EVIDENCE_LABEL_OPTION_TEXT[value]}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function TimeframeSelect({ item, stager, name, disabled }: { item: StagedEvidence; stager: EvidenceStagerApi; name: string; disabled: boolean }) {
  return (
    <Field label={<>Timeframe<span className="sr-only"> of {name}</span></>}>
      <Select value={item.timeframe ?? ""} disabled={disabled} onChange={event => stager.update(item.localId, { timeframe: isTimeframe(event.target.value) ? event.target.value : null })}>
        <option value="">Not set</option>
        {TIMEFRAMES.map(value => (
          <option key={value} value={value}>
            {TIMEFRAME_TEXT[value]}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function StatusLine({ item }: { item: StagedEvidence }) {
  if (item.status === "uploading") {
    return (
      <p className="t-caption flex items-center gap-1">
        <LoaderCircle aria-hidden="true" className="spin size-3.5 shrink-0" />
        Uploading…
      </p>
    );
  }
  if (item.status === "uploaded") {
    return (
      <p className="t-caption flex items-center gap-1 text-pos">
        <CircleCheck aria-hidden="true" className="size-3.5 shrink-0" />
        Saved
      </p>
    );
  }
  if (item.status === "failed") {
    return (
      <p className="t-caption flex items-start gap-1 text-neg">
        <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        <span>{item.error ?? "Not saved. Try again."}</span>
      </p>
    );
  }
  return null;
}

function StagedCard({ item, stager, showLabels, disabled }: CardProps) {
  const replaceInput = useRef<HTMLInputElement>(null);
  const name = stagedFileName(item.file.name, item.captureMethod);
  const editable = isEditable(item) && !disabled;

  const replaced = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) stager.replace(item.localId, file, "FILE");
  };

  return (
    <li className="@container min-w-0 rounded-card border border-border bg-surface p-2">
      <div className="flex min-w-0 flex-col gap-3 @[30rem]:flex-row">
        <img
          src={item.previewUrl}
          alt={`Preview: ${name}`}
          className="aspect-[16/10] max-h-48 w-full max-w-sm shrink-0 self-start rounded-control bg-surface-sunken object-contain @[30rem]:w-28"
        />
        <StagedControls item={item} stager={stager} showLabels={showLabels} name={name} editable={editable} replaceInput={replaceInput} onReplaced={replaced} />
      </div>
    </li>
  );
}

function StagedControls({
  item,
  stager,
  showLabels,
  name,
  editable,
  replaceInput,
  onReplaced,
}: Omit<CardProps, "disabled"> & { name: string; editable: boolean; replaceInput: RefObject<HTMLInputElement | null>; onReplaced: (event: ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <div className="@container flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex items-start gap-2">
        <p className="t-meta min-w-0 flex-1 truncate font-medium text-text">{name}</p>
        <IconButton label={`Remove ${name}`} icon={<X />} size="sm" disabled={!editable} onClick={() => stager.remove(item.localId)} />
      </div>
      {showLabels && editable ? (
        <>
          <div className="grid gap-2 @[26rem]:grid-cols-2">
            <LabelSelect item={item} stager={stager} name={name} disabled={!editable} />
            <TimeframeSelect item={item} stager={stager} name={name} disabled={!editable} />
          </div>
          <Field label={<>Caption<span className="sr-only"> of {name}</span></>} optional>
            <Input value={item.caption} maxLength={MAX_CAPTION_LENGTH} placeholder="What does it show?" onChange={event => stager.update(item.localId, { caption: event.target.value })} />
          </Field>
        </>
      ) : (
        <p className="t-caption">{evidenceTagText(item.label, item.timeframe)}</p>
      )}
      <StatusLine item={item} />
      {editable && (
        <div>
          <Button type="button" variant="link" size="sm" icon={<RefreshCw aria-hidden="true" />} onClick={() => replaceInput.current?.click()}>
            Replace image
          </Button>
          <input ref={replaceInput} type="file" accept={ACCEPTED_IMAGE_INPUT} hidden tabIndex={-1} onChange={onReplaced} />
        </div>
      )}
    </div>
  );
}

function CompactCard({ item, stager, showLabels, disabled }: CardProps) {
  const name = stagedFileName(item.file.name, item.captureMethod);
  const editable = isEditable(item) && !disabled;
  return (
    <li className="flex w-48 shrink-0 flex-col gap-1.5 rounded-card border border-border bg-surface p-1.5">
      <div className="relative">
        <img src={item.previewUrl} alt={`Preview: ${name}`} className="aspect-[16/10] w-full rounded-control bg-surface-sunken object-contain" />
        {editable && <IconButton label={`Remove ${name}`} icon={<X />} size="sm" variant="secondary" className="absolute right-1 top-1" onClick={() => stager.remove(item.localId)} />}
      </div>
      {showLabels && editable ? (
        <>
          <LabelSelect item={item} stager={stager} name={name} disabled={!editable} />
          <TimeframeSelect item={item} stager={stager} name={name} disabled={!editable} />
        </>
      ) : (
        <p className="t-caption truncate">{evidenceTagText(item.label, item.timeframe)}</p>
      )}
      <StatusLine item={item} />
    </li>
  );
}
