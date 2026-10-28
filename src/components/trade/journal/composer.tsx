"use client";

import { LoaderCircle } from "lucide-react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { type ClipboardEvent, type DragEvent, type FormEvent, useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { addJournalEntry } from "@/app/actions/journal";
import { type ActionState, idleState } from "@/app/actions/state";
import { EvidenceStager } from "@/components/evidence/evidence-stager";
import { defaultLabelForTiming, timingLabel } from "@/components/evidence/labels";
import { clipboardHasText, clipboardImageFiles, transferHasFiles } from "@/components/evidence/paste-model";
import { EvidencePasteTarget } from "@/components/evidence/paste-target";
import { type CaptureMethod, type EvidenceLabel, TRADE_EVIDENCE_LIMIT } from "@/components/evidence/types";
import { uploadStagedEvidence, uploadSummary } from "@/components/evidence/upload";
import { randomUuid, useEvidenceStager } from "@/components/evidence/use-evidence-stager";
import { useModifierKeyLabel } from "@/components/shell/use-media-query";
import { Button } from "@/components/ui/button";
import { ChoiceChips, SegmentedControl } from "@/components/ui/choice";
import { cx } from "@/components/ui/cx";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Field } from "@/components/ui/field";
import { FormAlert } from "@/components/ui/form-alert";
import { KbdCombo } from "@/components/ui/kbd";
import { submitOnModifierEnter } from "@/components/ui/keyboard";
import { Textarea } from "@/components/ui/textarea";
import { stripZeros } from "@/domain/format";
import type { Timing } from "@/domain/timeline";
import {
  EMPTY_JOURNAL_DRAFT, JOURNAL_KIND_LABELS, JOURNAL_KINDS, JOURNAL_PLACEHOLDERS, type JournalDraft, type JournalEntryInput, type JournalField, type JournalFieldErrors,
  type JournalKind, journalEntryForm, journalEntryTitle, journalServerErrors, validateJournalDraft,
} from "./composer-model";

/**
 * Live journal composer (docs/V2_ARCHITECTURE.md §3.6, §7.1, §8.2, §13.4, §14.4): a one-line "Add to
 * trade journal…" field that grows, kind chips Note · Decision · Stop · Target · Partial · Lesson with the
 * few structured fields they need, and screenshots by paste, drop, picker or camera (default label by
 * timing: before entry → Pre-entry, while live → Management, after close → Exit; Other once a plan ended
 * without an entry). Ctrl/⌘+Enter adds the entry through `addJournalEntry`; staged screenshots are then
 * uploaded one by one. The entry shows as pending at once; errors are focused. `J` focuses the field (it
 * carries `data-journal-composer`).
 */

export interface JournalComposerActions {
  /** `addJournalEntry` (src/app/actions/journal.ts): `tradeId`, `kind`, `body?`, `details?`, `requestKey` → `{ id }`. */
  addEntry(prev: ActionState<{ id: string }>, form: FormData): Promise<ActionState<{ id: string }>>;
  /** `uploadStagedEvidence` (src/components/evidence/upload.ts). */
  upload: typeof uploadStagedEvidence;
}

export const JOURNAL_COMPOSER_ACTIONS: JournalComposerActions = { addEntry: addJournalEntry, upload: uploadStagedEvidence };

/** Default id of the composer's text field (target of `J`, `#journal-composer` and `aria-controls`). */
export const JOURNAL_COMPOSER_ID = "journal-composer";

export interface JournalComposerProps {
  tradeId: string;
  /** Band new entries will most likely land in; sets the default screenshot label. The server decides the real timing. */
  timingHint: Timing;
  /**
   * Label of attached screenshots when the band's default doesn't fit (`defaultLabelForLifecycle`): Other on a plan
   * that ended without an entry, which had neither an entry nor an exit. Default: the band's (Pre-entry, Management, Exit).
   */
  defaultLabel?: EvidenceLabel;
  /** Known contract: Stop and Target prices are checked against its tick size. */
  instrument?: { tickSize: string; quantityStep?: string | null } | null;
  autoFocus?: boolean;
  /** Idempotency key of the first entry (render it on the server); the composer rotates keys after each saved entry. */
  requestKey: string;
  /** Phones: keep the composer docked above the tab bar. */
  sticky?: boolean;
  /**
   * Where Ctrl/⌘+V and file drops are captured: the whole page (default; the trade page) or only the
   * composer itself (pages with several composers, such as Today; files dropped elsewhere on the page are
   * then refused instead of replacing it).
   */
  capture?: "page" | "composer";
  /** Screenshots the trade can still take (24 minus its active screenshots). */
  maxScreenshots?: number;
  /** Id of the text field (default `journal-composer`); give each composer its own when several share a page. */
  id?: string;
  /** Overrides the server action and the upload (demos and tests). */
  actions?: Partial<JournalComposerActions>;
  className?: string;
}

type Phase = "idle" | "saving" | "uploading";
type Status = { tone: "info" | "success"; text: string } | null;
type PendingEntry = { title: string; body: string | null };
type EntryOutcome = { ok: true } | { ok: false; message: string; fieldErrors?: Record<string, string> };

const KIND_OPTIONS = JOURNAL_KINDS.map(kind => ({ value: kind, label: JOURNAL_KIND_LABELS[kind] }));
const AMOUNT_OPTIONS = [
  { value: "percent", label: "Percent" },
  { value: "quantity", label: "Size" },
];
const STRUCTURED: readonly JournalKind[] = ["STOP_CHANGE", "TARGET_CHANGE", "PARTIAL_CLOSE"];
export const ENTRY_UNREACHABLE_COPY = "The entry couldn't be saved. Check your connection and try again; it won't be added twice.";

function isJournalKind(value: string): value is JournalKind {
  return (JOURNAL_KINDS as readonly string[]).includes(value);
}

async function saveEntry(addEntry: JournalComposerActions["addEntry"], tradeId: string, requestKey: string, entry: JournalEntryInput): Promise<EntryOutcome> {
  try {
    const result = await addEntry(idleState, journalEntryForm(tradeId, requestKey, entry));
    return result.status === "error" ? { ok: false, message: result.message, fieldErrors: result.fieldErrors } : { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, message: ENTRY_UNREACHABLE_COPY };
  }
}

export function JournalComposer({
  tradeId,
  timingHint,
  defaultLabel,
  instrument = null,
  autoFocus = false,
  requestKey: firstRequestKey,
  sticky = false,
  capture = "page",
  maxScreenshots = TRADE_EVIDENCE_LIMIT,
  id = JOURNAL_COMPOSER_ID,
  actions,
  className,
}: JournalComposerProps) {
  const addEntry = actions?.addEntry ?? JOURNAL_COMPOSER_ACTIONS.addEntry;
  const router = useRouter();
  const stager = useEvidenceStager({
    defaultLabel: defaultLabel ?? defaultLabelForTiming(timingHint), max: maxScreenshots, uploader: actions?.upload ?? JOURNAL_COMPOSER_ACTIONS.upload,
  });
  const [draft, setDraft] = useState<JournalDraft>(EMPTY_JOURNAL_DRAFT);
  const [fieldErrors, setFieldErrors] = useState<JournalFieldErrors>({});
  // `focus`: the alert takes focus only when no field is to blame (field errors focus the first field instead).
  const [failure, setFailure] = useState<{ text: string; key: number; focus: boolean } | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ field: JournalField; key: number } | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // Kept until an entry is saved, so a retry after a lost response is recognised as the same entry.
  const [requestKey, setRequestKey] = useState(firstRequestKey);
  const [pendingEntry, setPendingEntry] = useOptimistic<PendingEntry | null>(null);
  const [, startTransition] = useTransition();
  const [dragOver, setDragOver] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const modifier = useModifierKeyLabel();
  const fieldIds: Record<JournalField, string> = { body: id, price: `${id}-price`, amount: `${id}-amount` };
  const tickSize = instrument?.tickSize ?? null;
  const saving = phase === "saving";
  const pendingScreenshots = stager.pendingCount;

  useEffect(() => {
    if (autoFocus) document.getElementById(id)?.focus();
  }, [autoFocus, id]);

  // After the render that shows the error (and restores a refused entry), move focus to the first invalid field.
  useEffect(() => {
    if (!focusRequest) return;
    const fieldId = focusRequest.field === "body" ? id : `${id}-${focusRequest.field}`;
    document.getElementById(fieldId)?.focus();
  }, [focusRequest, id]);

  const update = (patch: Partial<JournalDraft>, fields: readonly JournalField[]) => {
    setDraft(current => ({ ...current, ...patch }));
    if (fields.some(field => fieldErrors[field])) setFieldErrors(current => Object.fromEntries(Object.entries(current).filter(([key]) => !fields.includes(key as JournalField))));
  };

  /** Shows field errors and focuses the first one; true when there was one to focus. */
  const showFieldErrors = (errors: JournalFieldErrors): boolean => {
    setFieldErrors(errors);
    const field = (["body", "price", "amount"] as const).find(key => errors[key]);
    if (field) setFocusRequest({ field, key: Date.now() });
    return field !== undefined;
  };

  const addFiles = (files: File[], method: CaptureMethod) => stager.addFiles(files, method);

  const saveScreenshots = async (afterEntry: boolean) => {
    setPhase("uploading");
    setStatus({ tone: "info", text: afterEntry ? "Added to the journal. Saving screenshots…" : "Saving screenshots…" });
    const results = await stager.uploadAll(tradeId, { onProgress: (done, total) => setProgress({ done, total }) });
    const summary = uploadSummary(results);
    setPhase("idle");
    setProgress(null);
    if (summary.saved > 0) {
      stager.clearUploaded();
      router.refresh();
    }
    const text = afterEntry ? `Added to the journal. ${summary.message}` : summary.message;
    if (summary.failed > 0) {
      setStatus(null);
      setFailure({ text, key: Date.now(), focus: true });
    } else setStatus({ tone: "success", text });
  };

  const submit = () => {
    if (phase !== "idle") return;
    const check = validateJournalDraft(draft, { tickSize, screenshotCount: pendingScreenshots });
    setFailure(null);
    if (!check.ok) {
      setStatus(null);
      showFieldErrors(check.fieldErrors);
      return;
    }
    setFieldErrors({});
    if (check.entry === null) {
      void saveScreenshots(false);
      return;
    }
    const entry = check.entry;
    const snapshot = draft;
    const key = requestKey;
    const withScreenshots = pendingScreenshots > 0;
    // Shown as pending at once; restored if the server refuses it.
    setDraft(current => ({ ...EMPTY_JOURNAL_DRAFT, amountKind: current.amountKind }));
    setPhase("saving");
    setStatus({ tone: "info", text: "Saving to the journal…" });
    startTransition(async () => {
      setPendingEntry({ title: journalEntryTitle(entry, instrument), body: entry.body });
      const outcome = await saveEntry(addEntry, tradeId, key, entry);
      if (!outcome.ok) {
        const mapped = journalServerErrors(outcome.fieldErrors);
        startTransition(() => {
          setDraft(snapshot);
          const fieldFocused = mapped.general === null && showFieldErrors(mapped.fieldErrors);
          setFailure({ text: mapped.general ?? outcome.message, key: Date.now(), focus: !fieldFocused });
          setStatus(null);
          setPhase("idle");
        });
        return;
      }
      startTransition(() => {
        setRequestKey(randomUuid());
        if (withScreenshots) return;
        setPhase("idle");
        setStatus({ tone: "success", text: "Added to the journal." });
      });
      // Not awaited, so the transition ends and the pending card clears as soon as the entry is in the timeline.
      if (withScreenshots) void saveScreenshots(true);
    });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  const onPaste = (event: ClipboardEvent<HTMLFormElement>) => {
    const files = clipboardImageFiles(event.clipboardData);
    if (!files.length || clipboardHasText(event.clipboardData)) return;
    event.preventDefault();
    addFiles(files, "PASTE");
  };

  const onDragOver = (event: DragEvent<HTMLFormElement>) => {
    if (!transferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!dragOver) setDragOver(true);
  };

  const onDragLeave = (event: DragEvent<HTMLFormElement>) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragOver(false);
  };

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    if (!transferHasFiles(event.dataTransfer)) return;
    // Taken here: the page-level target sees `defaultPrevented` and leaves these files alone.
    event.preventDefault();
    setDragOver(false);
    addFiles(Array.from(event.dataTransfer.files), "DROP");
  };

  const screenshotsOnly = draft.kind === "NOTE" && draft.body.trim() === "" && pendingScreenshots > 0;
  const submitLabel = screenshotsOnly ? (pendingScreenshots === 1 ? "Save screenshot" : `Save ${pendingScreenshots} screenshots`) : "Add to journal";
  const busyLabel = phase === "uploading" && progress && progress.total > 0 ? `Saving screenshot ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…` : "Adding…";
  const structured = STRUCTURED.includes(draft.kind);
  const modifierName = modifier === "⌘" ? "Command" : "Control";

  return (
    <div
      className={cx(
        "min-w-0",
        sticky &&
          "max-md:sticky max-md:bottom-[calc(3.5rem_+_env(safe-area-inset-bottom))] max-md:z-30 max-md:-mx-4 max-md:border-t max-md:border-border max-md:bg-surface max-md:px-4 max-md:pb-3 max-md:pt-2 max-md:shadow-raised",
        className,
      )}
    >
      {capture === "page" ? (
        <EvidencePasteTarget onFiles={addFiles} allowInTextFields={element => form.current?.contains(element) ?? false} />
      ) : (
        // Captures nothing: with no page-level target, it keeps a file dropped beside the composer from opening in place of the page (and its unsaved drafts).
        <EvidencePasteTarget disabled onFiles={addFiles} />
      )}
      <form
        ref={form}
        noValidate
        aria-label="Add to trade journal"
        onSubmit={onSubmit}
        onKeyDown={submitOnModifierEnter}
        onPaste={capture === "composer" ? onPaste : undefined}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cx(
          "flex flex-col gap-3 rounded-card border bg-surface p-3 transition-shadow",
          dragOver ? "border-accent ring-2 ring-accent" : "border-border",
          sticky && "max-md:rounded-none max-md:border-0 max-md:p-0",
        )}
      >
        {failure && (
          <FormAlert key={failure.key} tone="error" focusOnMount={failure.focus}>
            {failure.text}
          </FormAlert>
        )}
        <ChoiceChips
          name="kind"
          legend="Entry type"
          legendHidden
          options={KIND_OPTIONS}
          value={draft.kind}
          disabled={saving}
          onValueChange={value => {
            if (!isJournalKind(value)) return;
            setDraft(current => ({ ...current, kind: value }));
            setFieldErrors({});
          }}
          className="max-md:[&_.filter-chips]:flex-nowrap max-md:[&_.filter-chips]:overflow-x-auto max-md:[&_.filter-chips]:pb-1"
        />
        <Field label="Journal entry" labelHidden id={fieldIds.body} error={fieldErrors.body}>
          <Textarea
            data-journal-composer=""
            rows={1}
            placeholder={JOURNAL_PLACEHOLDERS[draft.kind]}
            value={draft.body}
            readOnly={saving}
            aria-busy={saving || undefined}
            onChange={event => update({ body: event.target.value }, ["body"])}
            className="min-h-10 resize-none max-md:max-h-40"
          />
        </Field>
        {structured && draft.kind !== "PARTIAL_CLOSE" && (
          <Field
            label={draft.kind === "STOP_CHANGE" ? "New stop price" : "New target price"}
            required
            id={fieldIds.price}
            hint={tickSize ? `Tick size ${stripZeros(tickSize)}` : undefined}
            error={fieldErrors.price}
          >
            <DecimalInput value={draft.price} readOnly={saving} onValueChange={price => update({ price }, ["price"])} />
          </Field>
        )}
        {draft.kind === "PARTIAL_CLOSE" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Exit price" optional id={fieldIds.price} error={fieldErrors.price}>
              <DecimalInput value={draft.price} readOnly={saving} onValueChange={price => update({ price }, ["price"])} />
            </Field>
            <div className="flex min-w-0 flex-col gap-1.5">
              <SegmentedControl
                name="amountKind"
                legend="Closed amount as"
                size="sm"
                options={AMOUNT_OPTIONS}
                value={draft.amountKind}
                disabled={saving}
                onValueChange={value => update({ amountKind: value === "quantity" ? "quantity" : "percent", amount: "" }, ["amount"])}
              />
              <Field label={draft.amountKind === "percent" ? "Percent closed" : "Size closed"} optional id={fieldIds.amount} error={fieldErrors.amount}>
                <DecimalInput value={draft.amount} readOnly={saving} endAdornment={draft.amountKind === "percent" ? "%" : undefined} onValueChange={amount => update({ amount }, ["amount"])} />
              </Field>
            </div>
          </div>
        )}
        <EvidenceStager stager={stager} compact disabled={phase !== "idle"} />
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <p role="status" aria-live="polite" aria-atomic="true" className={cx("t-caption", !status && "sr-only", status?.tone === "success" && "text-pos")}>
              {status?.text}
            </p>
            {!status && (
              <p className="t-caption hidden items-center gap-1 md:flex">
                <KbdCombo keys={[modifier, "Enter"]} label={`${modifierName} Enter`} /> to add · <KbdCombo keys={[modifier, "V"]} label={`${modifierName} V`} /> pastes a
                screenshot
              </p>
            )}
          </div>
          <Button type="submit" loading={phase !== "idle"} loadingText={busyLabel}>
            {submitLabel}
          </Button>
        </div>
        {pendingEntry && (
          <div aria-hidden="true" className="rounded-card border border-dashed border-border bg-surface-sunken p-3 opacity-80">
            <p className="t-caption flex items-center gap-1.5">
              <LoaderCircle className="spin size-3.5 shrink-0" />
              Saving · {timingLabel(timingHint)}
            </p>
            <p className="mt-1 font-medium text-text">{pendingEntry.title}</p>
            {pendingEntry.body && <p className="mt-0.5 whitespace-pre-wrap break-words text-text-2">{pendingEntry.body}</p>}
          </div>
        )}
      </form>
    </div>
  );
}
