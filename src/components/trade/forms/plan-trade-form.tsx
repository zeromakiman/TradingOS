"use client";

import { ArrowDownRight, ArrowUpRight, ChevronLeft, History, Plus, RefreshCw, RotateCcw, Save } from "lucide-react";
import Link from "next/link";
import { unstable_rethrow, useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useMemo, useRef, useState, useTransition } from "react";
import { type DraftResult, createPlannedTrade, reviseDraft } from "@/app/actions/trades";
import { type ActionState, INVALID_COPY, idleState, SQL_ERROR_COPY } from "@/app/actions/state";
import { manageHref } from "@/components/accounts/copy";
import { EvidenceStager } from "@/components/evidence/evidence-stager";
import { defaultLabelForTiming } from "@/components/evidence/labels";
import { EvidencePasteTarget } from "@/components/evidence/paste-target";
import { uploadStagedEvidence, uploadSummary } from "@/components/evidence/upload";
import { randomUuid, useEvidenceStager } from "@/components/evidence/use-evidence-stager";
import { useModifierKeyLabel } from "@/components/shell/use-media-query";
import { StatusPill, type StatusTone } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Checkbox, ChoiceChips, SegmentedControl } from "@/components/ui/choice";
import { cx } from "@/components/ui/cx";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Field } from "@/components/ui/field";
import { FormAlert } from "@/components/ui/form-alert";
import { Select } from "@/components/ui/input";
import { KbdCombo } from "@/components/ui/kbd";
import { PageHeader } from "@/components/ui/page-header";
import { Textarea } from "@/components/ui/textarea";
import { useOptionalToast } from "@/components/ui/toast";
import { formatPercent } from "@/domain/format";
import { restorePlanDraft, sameDraft } from "./autosave";
import {
  ADD_INSTRUMENT, aiRevisionWarning, CONTEXT_CHANGED_TITLE, CONTRACT_LABEL, CONTRADICTION_LABEL, contradictionDescription, DIRECTION_OPTIONS, DISCARD_RESTORED,
  DRAFT_CHANGED_BODY, DRAFT_CHANGED_TITLE, EDIT_TITLE, GAP_COPY, MODEL_LABELS, NEWS_LABELS, NEWS_ORDER, newsConsequence, PLAN_DESCRIPTION, PLAN_MODELS, PLAN_TITLE,
  PREVIEW_FOOTNOTE, RESTORED_PLAN_BODY, RESTORED_TITLE, revisionStep, SAVE_DRAFT, THESIS_HINT, THESIS_LABEL, THESIS_PLACEHOLDER, UNREACHABLE_COPY,
} from "./copy";
import {
  AccountChip, CHIPS_GRID_ON_PHONE, CHIPS_PAIRS_ON_PHONE, focusField, FormSection, formKeyDown, GroupError, HintText, RequiredLegend, SEGMENTED_FULL_ON_PHONE,
  StaticField,
} from "./form-parts";
import { useLeaveGuard } from "./leave-guard";
import {
  budgetHint, CUSTOM_RISK, contractSummary, PLAN_FIELD_ORDER, type PlanDraft, type PlanField, type PlanFieldErrors, planFieldErrors, planServerErrors, pricePlaceholder,
  priceHints,
  previewPlan, previewSummary, riskPresets, switchPlanAccount, validatePlan,
} from "./plan-model";
import { type FixTarget, RiskPreview, VerdictPill } from "./risk-preview";
import type { FormAccount, NewsStatus } from "./types";
import { useFormAutosave } from "./use-autosave";
import { useServerClock } from "./use-server-clock";

/**
 * Plan Trade and Edit Draft (docs/V2_ARCHITECTURE.md §8.1, §14.2): a progressive form (account and setup, prices and
 * risk, thesis, checks, screenshots) beside the live deterministic preview. Saving sends the 11 proposal keys with the
 * account's expected risk-plan and account-values versions (and, for a revision, the expected revision): the server runs
 * the free check, then the staged screenshots are uploaded one by one and the trade opens. The request key is created on
 * the first submission and kept until a draft is saved, so a retry after a lost response is a replay, never a second
 * draft. DRAFT_CHANGED offers to load the newer revision in place of the form's values (staged screenshots stay);
 * CONTEXT_CHANGED reloads the account data and keeps every entry. Unsaved entries (not screenshots) are kept in the tab
 * and come back after Back, a swipe-back or a reload, with a notice that can discard them.
 */

export type PlanTradeMode =
  | { kind: "create" }
  | {
    kind: "edit";
    tradeId: string;
    /** `EURUSD · Long`. */
    title: string;
    revision: number;
    expectedRevision: number;
    stateLabel: string;
    stateTone: StatusTone;
    archived: boolean;
    aiAnalysesOfRevision: number;
    contractUpdatedSymbol: string | null;
  };

export interface PlanTradeActions {
  create: typeof createPlannedTrade;
  revise: typeof reviseDraft;
  upload: typeof uploadStagedEvidence;
}

export interface PlanTradeFormProps {
  /** Server time of the page; the preview clock ticks from it. */
  now: string;
  /** Plan Trade: every active account; Edit Draft: the trade's account. */
  accounts: FormAccount[];
  initial: PlanDraft;
  mode: PlanTradeMode;
  /** Screenshots the trade can still take (24 for a new draft). */
  evidenceCapacity: number;
  /** Edit Draft: the draft's saved screenshots (read-only, rendered by the server). */
  savedEvidence?: ReactNode;
  /** Overrides the server actions and the upload (tests and demos). */
  actions?: Partial<PlanTradeActions>;
  /** Where the unsaved entries are kept in the tab (`autosaveKey`); without it nothing is kept. */
  autosaveKey?: string | null;
}

type Phase = "idle" | "saving" | "uploading" | "saved";
type Failure =
  | { kind: "message"; text: string; key: number; focus: boolean; fields: boolean }
  | { kind: "setup"; account: FormAccount; key: number }
  | { kind: "unchanged"; revision: number; key: number }
  | { kind: "draft-changed" | "context-changed"; text: string; key: number };
interface SavedDraft {
  tradeId: string;
  message: string;
  /** Toast tone: the free check's verdict, or neutral when only screenshots were added. */
  tone: "positive" | "warning" | "neutral";
  /** Edit Draft without changes: only screenshots were sent, no revision was saved. */
  screenshotsOnly?: boolean;
}

/** Nothing to save on Edit Draft: an identical revision would only mark existing AI analysis as belonging to an older one. */
export function unchangedMessage(revision: number): string {
  return `Nothing changed since revision ${revision}. To check it again with today's values, use Check risk on the trade page.`;
}

const FIELD_IDS: Readonly<Record<PlanField | "contract" | "contradiction" | "news", string>> = Object.freeze({
  accountId: "plan-account", instrumentId: "plan-instrument", direction: "plan-direction", model: "plan-model", entry: "plan-entry", stop: "plan-stop",
  target: "plan-target", riskPercent: "plan-risk", narrative: "plan-thesis", contract: "plan-contract", contradiction: "plan-contradiction", news: "plan-news",
});

function isNews(value: string): value is NewsStatus {
  return (NEWS_ORDER as readonly string[]).includes(value);
}

const revisionOf = (mode: PlanTradeMode) => (mode.kind === "edit" ? mode.revision : 0);

/**
 * The stager's two-column list leaves each card's label and timeframe selects too narrow to read inside this form's
 * column, so it shows one card per row. On phones a card stacks its preview above the fields (the shared card puts a
 * fixed-width preview beside the two selects), so "Pre-entry" and the timeframe read in full.
 */
const STAGED_LAYOUT = cx(
  "[&_ul[aria-label='Screenshots_to_save']]:grid-cols-1",
  "max-sm:[&_ul[aria-label='Screenshots_to_save']>li]:flex-col max-sm:[&_ul[aria-label='Screenshots_to_save']>li>img]:w-full",
);

/** The first setup gap that keeps an account from saving a plan, or null when it can save one. */
function setupGap(account: FormAccount) {
  if (account.gaps.length) return account.gaps[0];
  return account.riskPlanId === null || account.observationId === null ? "UNAVAILABLE" : null;
}

export function PlanTradeForm({ now: serverNow, accounts, initial, mode, evidenceCapacity, savedEvidence, actions, autosaveKey = null }: PlanTradeFormProps) {
  const router = useRouter();
  const toast = useOptionalToast();
  const modifier = useModifierKeyLabel();
  const now = useServerClock(serverNow);
  const [draft, setDraft] = useState<PlanDraft>(initial);
  const [touched, setTouched] = useState<ReadonlySet<PlanField>>(() => new Set());
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<PlanFieldErrors>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saved, setSaved] = useState<(SavedDraft & { uploadMessage: string }) | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [savingMode, setSavingMode] = useState<PlanTradeMode | null>(null);
  const [shownRevision, setShownRevision] = useState(revisionOf(mode));
  const [adoptLatest, setAdoptLatest] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [, startTransition] = useTransition();
  const requestKey = useRef<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const stager = useEvidenceStager({ defaultLabel: defaultLabelForTiming("BEFORE_ENTRY"), max: evidenceCapacity, uploader: actions?.upload ?? uploadStagedEvidence });
  const autosave = useFormAutosave({
    storageKey: autosaveKey,
    draft,
    initial,
    requestKey,
    restore: stored => restorePlanDraft(stored, accounts, initial),
    onRestore: setDraft,
    active: phase === "idle",
  });

  // A newer revision arrived with the page data (a reload after DRAFT_CHANGED, or this form's own save): after the
  // reload the trader asked for, its values replace the form's; screenshots staged here stay.
  if (revisionOf(mode) !== shownRevision) {
    setShownRevision(revisionOf(mode));
    if (adoptLatest) {
      setAdoptLatest(false);
      setDraft(initial);
      setTouched(new Set());
      setSubmitted(false);
      setServerErrors({});
      setFailure(null);
    }
  }

  const busy = phase === "saving" || phase === "uploading";
  const locked = busy || phase === "saved";
  // While saving, the header keeps describing the revision being saved (the page data may already show the next one).
  const shown = busy && savingMode ? savingMode : mode;
  const editing = shown.kind === "edit";
  const account = accounts.find(item => item.id === draft.accountId) ?? null;
  const instrument = account?.instruments.find(item => item.id === draft.instrumentId) ?? null;
  const dirty = phase === "saved" ? stager.pendingCount > 0 : stager.items.length > 0 || !sameDraft(draft, initial);
  const guard = useLeaveGuard(dirty && !busy, autosave.clear);

  const preview = useMemo(() => previewPlan(draft, account, now), [draft, account, now]);
  const hints = priceHints(draft, instrument, account?.riskPlan?.minRR ?? null);
  const presets = riskPresets(account?.riskPlan ?? null);
  const liveErrors = planFieldErrors(draft, account);
  const errorOf = (field: PlanField): string | undefined => {
    if (serverErrors[field]) return serverErrors[field];
    const message = liveErrors[field];
    if (!message) return undefined;
    // Format problems show once a field was left (or after a save attempt); empty required fields only after a save attempt.
    return submitted || (touched.has(field) && field !== "accountId") ? message : undefined;
  };

  const clearFailure = () => setFailure(current => (current?.kind === "message" || current?.kind === "setup" || current?.kind === "unchanged" ? null : current));
  const update = (patch: Partial<PlanDraft>, fields: readonly PlanField[]) => {
    setDraft(current => ({ ...current, ...patch }));
    if (fields.some(field => serverErrors[field])) setServerErrors(current => Object.fromEntries(Object.entries(current).filter(([key]) => !fields.includes(key as PlanField))));
    clearFailure();
  };
  const touch = (field: PlanField) => () => setTouched(current => (current.has(field) ? current : new Set(current).add(field)));

  const changeAccount = (accountId: string) => {
    const next = accounts.find(item => item.id === accountId);
    if (!next) return;
    setDraft(current => switchPlanAccount(current, next, accounts));
    setServerErrors({});
    clearFailure();
  };

  const fix = (target: FixTarget) => focusField(target === "riskPercent" && draft.riskChoice === CUSTOM_RISK ? "plan-risk-custom" : FIELD_IDS[target]);

  const showErrors = (errors: PlanFieldErrors, message: string) => {
    const first = PLAN_FIELD_ORDER.find(field => errors[field]);
    setFailure({ kind: "message", text: message, key: Date.now(), focus: first === undefined, fields: first !== undefined });
    if (first) window.setTimeout(() => fix(first), 0);
  };

  const finish = (result: SavedDraft, screenshots: string | null) => {
    guard.release();
    toast?.toast({ title: result.message, description: screenshots ?? undefined, tone: result.tone });
    router.replace(`/trades/${result.tradeId}`);
  };

  const uploadScreenshots = async (result: SavedDraft) => {
    setPhase("uploading");
    const results = await stager.uploadAll(result.tradeId, { onProgress: (done, total) => setProgress({ done, total }) });
    setProgress(null);
    const summary = uploadSummary(results);
    if (summary.failed > 0) {
      setSaved({ ...result, uploadMessage: summary.message });
      setPhase("saved");
      return;
    }
    finish(result, summary.saved > 0 ? summary.message : null);
  };

  const submit = () => {
    if (phase !== "idle") return;
    setSubmitted(true);
    if (account && setupGap(account) !== null) {
      setFailure({ kind: "setup", account, key: Date.now() });
      return;
    }
    const check = validatePlan(draft, account);
    if (!check.ok || !account?.riskPlanId || !account.observationId) {
      showErrors(check.ok ? {} : check.fieldErrors, INVALID_COPY);
      return;
    }
    // A superseded contract is a change even when no field was touched: the new revision uses the current version.
    if (mode.kind === "edit" && !mode.contractUpdatedSymbol && sameDraft(draft, initial)) {
      // Screenshots belong to the trade: adding them needs no new revision.
      if (stager.pendingCount === 0) {
        setFailure({ kind: "unchanged", revision: mode.revision, key: Date.now() });
        return;
      }
      setFailure(null);
      setSavingMode(mode);
      startTransition(async () => {
        await uploadScreenshots({ tradeId: mode.tradeId, message: `Screenshots added to the draft. It stays at revision ${mode.revision}.`, tone: "neutral", screenshotsOnly: true });
      });
      return;
    }
    requestKey.current ??= randomUuid();
    // The key is kept with the entries before anything is sent: leaving mid-request and coming back replays it.
    autosave.save(draft);
    const body = new FormData();
    body.set("requestKey", requestKey.current);
    body.set("riskPlanId", account.riskPlanId);
    body.set("observationId", account.observationId);
    body.set("proposal", JSON.stringify(check.proposal));
    if (mode.kind === "edit") {
      body.set("tradeId", mode.tradeId);
      body.set("expectedRevision", String(mode.expectedRevision));
    } else body.set("accountId", account.id);
    const action = mode.kind === "edit" ? actions?.revise ?? reviseDraft : actions?.create ?? createPlannedTrade;
    setFailure(null);
    setServerErrors({});
    setSavingMode(mode);
    setPhase("saving");
    startTransition(async () => {
      let result: ActionState<DraftResult>;
      try {
        result = await action(idleState, body);
      } catch (error) {
        unstable_rethrow(error);
        result = { status: "error", message: UNREACHABLE_COPY };
      }
      if (result.status !== "success" || !result.data) {
        const message = result.status === "error" ? result.message : UNREACHABLE_COPY;
        const errors = result.status === "error" ? planServerErrors(result.fieldErrors) : {};
        // The key already saved other values: as the message says, a reload makes the next save a new submission.
        if (message === SQL_ERROR_COPY.IDEMPOTENCY_CONFLICT) autosave.forgetRequestKey();
        setPhase("idle");
        setServerErrors(errors);
        if (message === SQL_ERROR_COPY.DRAFT_CHANGED) setFailure({ kind: "draft-changed", text: message, key: Date.now() });
        else if (message === SQL_ERROR_COPY.CONTEXT_CHANGED) setFailure({ kind: "context-changed", text: message, key: Date.now() });
        else showErrors(errors, message);
        return;
      }
      autosave.clear();
      const outcome: SavedDraft = { tradeId: result.data.tradeId, message: result.message ?? "Draft saved.", tone: result.data.decision === "APPROVED" ? "positive" : "warning" };
      if (stager.pendingCount === 0) finish(outcome, null);
      else await uploadScreenshots(outcome);
    });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  const retryUploads = () => {
    if (!saved || phase !== "saved") return;
    startTransition(async () => {
      await uploadScreenshots(saved);
    });
  };

  const reloadAccountData = () => {
    setFailure(null);
    startRefresh(() => router.refresh());
  };
  const reloadLatestRevision = () => {
    setAdoptLatest(true);
    startRefresh(() => router.refresh());
  };
  // Back to the entries the page opened with; screenshots staged on this visit stay.
  const discardRestored = () => {
    autosave.discard();
    requestKey.current = null;
    setDraft(initial);
    setTouched(new Set());
    setSubmitted(false);
    setServerErrors({});
    setFailure(null);
    window.setTimeout(() => focusField(mode.kind === "edit" ? FIELD_IDS.instrumentId : FIELD_IDS.accountId), 0);
  };

  const busyLabel = phase === "uploading" && progress && progress.total > 0 ? `Saving screenshot ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…` : "Saving draft…";
  const saveLabel = shown.kind === "edit" ? `Save revision ${shown.revision + 1}` : SAVE_DRAFT;
  const summary = previewSummary(preview);
  const modifierName = modifier === "⌘" ? "Command" : "Control";
  const tradeHref = mode.kind === "edit" ? `/trades/${mode.tradeId}` : null;
  const cancelHref = tradeHref ?? "/today";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        className="mb-0"
        eyebrow={
          <span className="flex items-center justify-between gap-3">
            {/* The way back keeps its width (the header lets words break); the account chip beside it shrinks instead. */}
            <Link href={cancelHref} className="inline-flex min-h-10 shrink-0 items-center gap-1 text-text-2 hover:text-text pointer-coarse:min-h-11">
              <ChevronLeft aria-hidden="true" className="size-4" />
              {shown.kind === "edit" ? shown.title : "Today"}
            </Link>
            {account && <AccountChip name={account.name} currency={account.currency} className="sm:hidden" />}
          </span>
        }
        title={shown.kind === "edit" ? EDIT_TITLE : PLAN_TITLE}
        description={
          shown.kind === "edit" ? (
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              <StatusPill tone={shown.stateTone}>{shown.stateLabel}</StatusPill>
              <span className="num font-medium text-text">{revisionStep(shown.revision)}</span>
              <span>Saving creates a new revision; earlier revisions stay in the trade's history.</span>
            </span>
          ) : (
            PLAN_DESCRIPTION
          )
        }
        actions={account ? <AccountChip name={account.name} currency={account.currency} className="max-sm:hidden" /> : undefined}
      />
      <EvidencePasteTarget onFiles={stager.addFiles} disabled={busy} allowInTextFields={element => form.current?.contains(element) ?? false} />
      {autosave.restored && (
        <Callout
          tone="info"
          role="status"
          icon={<RotateCcw aria-hidden="true" />}
          title={RESTORED_TITLE}
          action={
            <Button type="button" size="sm" variant="secondary" onClick={discardRestored}>
              {DISCARD_RESTORED}
            </Button>
          }
        >
          {RESTORED_PLAN_BODY}
        </Callout>
      )}
      {shown.kind === "edit" && shown.aiAnalysesOfRevision > 0 && (
        <Callout tone="warning" icon={<History aria-hidden="true" />} title="This revision has AI analysis">
          {aiRevisionWarning(shown.revision)}.
        </Callout>
      )}
      {shown.kind === "edit" && shown.contractUpdatedSymbol && (
        <Callout tone="info" title={`The ${shown.contractUpdatedSymbol} contract was updated`}>
          This draft now uses the current contract values. Check them in Checks and confirm them again.
        </Callout>
      )}
      {shown.kind === "edit" && shown.archived && (
        <Callout tone="warning" title="This trading account is archived">
          Restore it in Manage account before locking this plan.
        </Callout>
      )}
      {failure?.kind === "draft-changed" && (
        <Callout
          tone="negative"
          role="alert"
          title={DRAFT_CHANGED_TITLE}
          action={
            <>
              <Button type="button" size="sm" icon={<RefreshCw aria-hidden="true" />} loading={refreshing} loadingText="Reloading…" onClick={reloadLatestRevision}>
                Reload latest revision
              </Button>
              {tradeHref && (
                <Link href={tradeHref} className={buttonClasses({ variant: "secondary", size: "sm" })}>
                  Open the trade
                </Link>
              )}
            </>
          }
        >
          {failure.text} {DRAFT_CHANGED_BODY}
        </Callout>
      )}
      {failure?.kind === "context-changed" && (
        <Callout
          tone="warning"
          role="alert"
          title={CONTEXT_CHANGED_TITLE}
          action={
            <Button type="button" size="sm" variant="secondary" icon={<RefreshCw aria-hidden="true" />} loading={refreshing} loadingText="Reloading…" onClick={reloadAccountData}>
              Reload account values
            </Button>
          }
        >
          {failure.text} Your entries stay on this page.
        </Callout>
      )}
      {failure?.kind === "setup" && <SetupAlert key={failure.key} account={failure.account} />}
      {failure?.kind === "unchanged" && (
        <Callout
          key={failure.key}
          tone="info"
          role="status"
          title="No changes to save"
          action={
            tradeHref && (
              <Link href={tradeHref} className={buttonClasses({ variant: "secondary", size: "sm" })}>
                Open the trade
              </Link>
            )
          }
        >
          {unchangedMessage(failure.revision)}
        </Callout>
      )}
      {failure?.kind === "message" && (
        <FormAlert key={failure.key} tone="error" focusOnMount={failure.focus}>
          {failure.text}
          {tradeHref && !failure.fields && (
            <>
              {" "}
              <Link href={tradeHref} className="font-medium underline">
                Open the trade
              </Link>
            </>
          )}
        </FormAlert>
      )}
      {saved && phase === "saved" && (
        <Callout
          tone="warning"
          role="alert"
          title={saved.screenshotsOnly ? "Not every screenshot was saved" : saved.message}
          action={
            <>
              <Button type="button" size="sm" icon={<RefreshCw aria-hidden="true" />} onClick={retryUploads}>
                Retry screenshots
              </Button>
              <Link href={`/trades/${saved.tradeId}`} className={buttonClasses({ variant: "secondary", size: "sm" })} onClick={guard.release}>
                Open the trade
              </Link>
            </>
          }
        >
          {saved.uploadMessage} {saved.screenshotsOnly ? "Retry here or add them on the trade page." : "The draft itself is saved; add the remaining screenshots here or on the trade page."}
        </Callout>
      )}

      <form
        ref={form}
        noValidate
        aria-label={editing ? "Edit draft" : "Plan trade"}
        aria-busy={busy}
        onSubmit={onSubmit}
        onKeyDown={formKeyDown}
        className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,25rem)] xl:gap-6"
      >
        <div className="card min-w-0">
          <FormSection step={1} title="Setup" id="plan-setup">
            <div className="grid gap-4 md:grid-cols-2">
              {mode.kind === "edit" ? (
                <StaticField label="Trading account" value={account ? `${account.name} · ${account.currency}` : "—"} hint="A revision keeps the trade's account." />
              ) : (
                <Field
                  label="Trading account"
                  required
                  id={FIELD_IDS.accountId}
                  error={errorOf("accountId")}
                  hint={account ? [account.description, account.riskPlan?.version].filter(Boolean).join(" · ") : "Plans always belong to one trading account."}
                >
                  <Select value={draft.accountId} disabled={locked} onChange={event => changeAccount(event.target.value)}>
                    {draft.accountId === "" && (
                      <option value="" disabled>
                        Choose a trading account
                      </option>
                    )}
                    {accounts.map(item => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {item.currency}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <InstrumentField draft={draft} account={account} disabled={locked} error={errorOf("instrumentId")} onChange={instrumentId => update({ instrumentId, contractConfirmed: false }, ["instrumentId"])} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div id={FIELD_IDS.direction} className="flex min-w-0 flex-col gap-1.5">
                <SegmentedControl
                  name="direction"
                  legend={<RequiredLegend>Direction</RequiredLegend>}
                  legendHidden={false}
                  required
                  className={SEGMENTED_FULL_ON_PHONE}
                  options={DIRECTION_OPTIONS.map(option => ({
                    value: option.value,
                    label: (
                      <>
                        {option.value === "LONG" ? <ArrowUpRight aria-hidden="true" className="size-4" /> : <ArrowDownRight aria-hidden="true" className="size-4" />}
                        {option.label}
                      </>
                    ),
                  }))}
                  value={draft.direction}
                  disabled={locked}
                  onValueChange={value => update({ direction: value === "SHORT" ? "SHORT" : "LONG" }, ["direction"])}
                  aria-describedby={errorOf("direction") ? "plan-direction-error" : undefined}
                />
                <GroupError id="plan-direction-error" message={errorOf("direction")} />
              </div>
              <div id={FIELD_IDS.model} className="flex min-w-0 flex-col gap-1.5">
                <SegmentedControl
                  name="model"
                  legend={<RequiredLegend>Model</RequiredLegend>}
                  legendHidden={false}
                  required
                  className={SEGMENTED_FULL_ON_PHONE}
                  options={PLAN_MODELS.map(model => ({ value: model, label: MODEL_LABELS[model] }))}
                  value={draft.model}
                  disabled={locked}
                  onValueChange={value => update({ model: value === "OTE" ? "OTE" : "OB_FIRST_TOUCH" }, ["model"])}
                  aria-describedby={errorOf("model") ? "plan-model-error" : undefined}
                />
                <GroupError id="plan-model-error" message={errorOf("model")} />
              </div>
            </div>
          </FormSection>

          <FormSection step={2} title="Prices and risk" id="plan-prices">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Entry" required id={FIELD_IDS.entry} error={errorOf("entry")} hint={<HintText hint={hints.entry} />}>
                <DecimalInput value={draft.entry} placeholder={instrument ? pricePlaceholder(instrument.tickSize) : undefined} readOnly={locked} onBlur={touch("entry")} onValueChange={entry => update({ entry }, ["entry"])} />
              </Field>
              <Field label="Stop loss" id={FIELD_IDS.stop} error={errorOf("stop")} hint={<HintText hint={hints.stop} />}>
                <DecimalInput value={draft.stop} placeholder={instrument ? pricePlaceholder(instrument.tickSize) : undefined} readOnly={locked} onBlur={touch("stop")} onValueChange={stop => update({ stop }, ["stop"])} />
              </Field>
              <Field label="Target" required id={FIELD_IDS.target} error={errorOf("target")} hint={<HintText hint={hints.target} />}>
                <DecimalInput value={draft.target} placeholder={instrument ? pricePlaceholder(instrument.tickSize) : undefined} readOnly={locked} onBlur={touch("target")} onValueChange={target => update({ target }, ["target"])} />
              </Field>
            </div>
            <RiskField draft={draft} account={account} presets={presets} disabled={locked} error={errorOf("riskPercent")} onTouch={touch("riskPercent")} onChange={patch => update(patch, ["riskPercent"])} />
          </FormSection>

          <FormSection step={3} title={THESIS_LABEL} id="plan-thesis-section">
            <Field label={THESIS_LABEL} labelHidden required id={FIELD_IDS.narrative} error={errorOf("narrative")} hint={<ThesisHint text={draft.narrative} />}>
              <Textarea
                rows={4}
                maxLength={5000}
                placeholder={THESIS_PLACEHOLDER}
                value={draft.narrative}
                readOnly={locked}
                onBlur={touch("narrative")}
                onChange={event => update({ narrative: event.target.value }, ["narrative"])}
                className="min-h-28"
              />
            </Field>
          </FormSection>

          <FormSection step={4} title="Checks" id="plan-checks">
            <div id={FIELD_IDS.news} className="flex flex-col gap-1.5">
              <ChoiceChips
                name="news"
                legend="Economic news"
                className={CHIPS_PAIRS_ON_PHONE}
                options={NEWS_ORDER.map(news => ({ value: news, label: NEWS_LABELS[news] }))}
                value={draft.news}
                disabled={locked}
                onValueChange={value => isNews(value) && update({ news: value }, [])}
                aria-describedby="plan-news-hint"
              />
              <p id="plan-news-hint" className="field-hint">
                {newsConsequence(draft.news, account?.riskPlan?.newsPolicy ?? null)}
              </p>
            </div>
            <Checkbox
              id={FIELD_IDS.contract}
              label={CONTRACT_LABEL}
              description={instrument ? contractSummary(instrument) : "Choose an instrument to see the contract values to confirm."}
              checked={draft.contractConfirmed}
              disabled={locked || !instrument}
              onChange={event => update({ contractConfirmed: event.target.checked }, [])}
            />
            <Checkbox
              id={FIELD_IDS.contradiction}
              label={CONTRADICTION_LABEL}
              description={contradictionDescription(account?.strategyVersion ?? null)}
              checked={draft.contradiction}
              disabled={locked}
              onChange={event => update({ contradiction: event.target.checked }, [])}
            />
          </FormSection>

          <FormSection
            step={5}
            title="Screenshots"
            id="plan-evidence"
            description={editing ? "Screenshots belong to the trade, not to a revision. New ones are added when you save." : "Optional. Staged here and saved with the draft as pre-entry evidence."}
          >
            {savedEvidence}
            <div className={STAGED_LAYOUT}>
              <EvidenceStager stager={stager} disabled={busy} title={editing ? "Add more screenshots" : "Add chart screenshots"} />
            </div>
          </FormSection>
        </div>

        <aside aria-label="Risk check and save" className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-[4.5rem] lg:max-h-[calc(100dvh-6rem)]">
          <RiskPreview
            preview={preview}
            account={account}
            now={now}
            onFix={locked ? undefined : fix}
            onReload={reloadAccountData}
            className="lg:min-h-0"
            footer={
              // Desktop save, the card's last row: while the card runs past the bottom of the window (callouts above it,
              // many reasons) it stays pinned to that edge, so the primary action is visible from the first paint. Phones
              // save from the action bar under the form.
              <div className="sticky bottom-0 z-10 hidden shrink-0 flex-col gap-2 rounded-b-card border-border border-t bg-surface px-4 pt-3 pb-2 lg:flex">
                {phase === "saved" && saved ? (
                  <Link href={`/trades/${saved.tradeId}`} className={buttonClasses({ size: "lg" })} onClick={guard.release}>
                    Open the trade
                  </Link>
                ) : (
                  <Button type="submit" size="lg" icon={<Save aria-hidden="true" />} loading={busy} loadingText={busyLabel}>
                    {saveLabel}
                  </Button>
                )}
                <div className="flex items-center justify-between gap-2">
                  <Link href={cancelHref} className={buttonClasses({ variant: "ghost", size: "sm" })}>
                    Cancel
                  </Link>
                  <p className="t-caption flex items-center gap-1">
                    <KbdCombo keys={[modifier, "Enter"]} label={`${modifierName} Enter`} /> saves
                  </p>
                </div>
              </div>
            }
          />
          <p className="t-caption shrink-0 px-1">{PREVIEW_FOOTNOTE}</p>
        </aside>

        <div
          className={cx(
            "sticky z-20 -mx-4 flex items-center gap-3 border-border border-t bg-surface px-4 py-2.5 shadow-raised md:-mx-6 md:px-6 lg:hidden",
            "bottom-[calc(3.5rem_+_env(safe-area-inset-bottom))] md:bottom-0",
          )}
        >
          <a href="#risk-preview" className="flex min-w-0 flex-1 flex-col rounded-control py-0.5 no-underline">
            <span className="flex items-center gap-2">
              <span className="sr-only">Risk check preview:</span>
              <VerdictPill preview={preview} />
            </span>
            <span className="t-caption mt-0.5 truncate">{summary.detail}</span>
          </a>
          {phase === "saved" && saved ? (
            <Link href={`/trades/${saved.tradeId}`} className={buttonClasses({})} onClick={guard.release}>
              Open the trade
            </Link>
          ) : (
            <Button type="submit" loading={busy} loadingText="Saving…" icon={<Save aria-hidden="true" />}>
              {shown.kind === "edit" ? "Save revision" : SAVE_DRAFT}
            </Button>
          )}
        </div>
      </form>
      {guard.dialog}
    </div>
  );
}

/** Why the selected account can't save a plan yet, with the Manage tab that fixes it. */
function SetupAlert({ account }: { account: FormAccount }) {
  const gap = setupGap(account) ?? "UNAVAILABLE";
  const copy = GAP_COPY[gap];
  return (
    <FormAlert tone="error" title={`${account.name} isn't ready for planning`}>
      {copy.text}{" "}
      {copy.tab && copy.action && (
        <Link href={manageHref(account.id, copy.tab)} className="font-medium underline">
          {copy.action}
        </Link>
      )}
    </FormAlert>
  );
}

function InstrumentField({ draft, account, disabled, error, onChange }: {
  draft: PlanDraft; account: FormAccount | null; disabled: boolean; error: string | undefined; onChange: (instrumentId: string) => void;
}) {
  const instruments = account?.instruments ?? [];
  const instrument = instruments.find(item => item.id === draft.instrumentId);
  const placeholder = !account ? "Choose an account first" : instruments.length ? "Choose an instrument" : "No instruments yet";
  const text = !account
    ? "Instruments come from the trading account."
    : instrument
      ? `Sized in ${instrument.quantityUnit}.`
      : instruments.length
        ? null
        : "Add the contract you trade with its tick size and tick value.";
  return (
    <Field
      label="Instrument"
      required
      id={FIELD_IDS.instrumentId}
      error={error}
      hint={
        <span className="flex flex-wrap items-center gap-x-2">
          {text && <span>{text}</span>}
          {account && (
            <Link href={manageHref(account.id, "instruments")} className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
              <Plus aria-hidden="true" className="size-3.5" />
              {ADD_INSTRUMENT}
            </Link>
          )}
        </span>
      }
    >
      <Select value={draft.instrumentId} disabled={disabled || instruments.length === 0} onChange={event => onChange(event.target.value)}>
        {draft.instrumentId === "" && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {instruments.map(item => (
          <option key={item.id} value={item.id}>
            {item.symbol}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function RiskField({ draft, account, presets, disabled, error, onTouch, onChange }: {
  draft: PlanDraft; account: FormAccount | null; presets: string[]; disabled: boolean; error: string | undefined; onTouch: () => void;
  onChange: (patch: Pick<PlanDraft, "riskChoice" | "customRisk"> | Pick<PlanDraft, "customRisk">) => void;
}) {
  const plan = account?.riskPlan ?? null;
  const percent = draft.riskChoice === CUSTOM_RISK ? draft.customRisk : draft.riskChoice;
  const budget = account ? budgetHint(percent, account) : null;
  const custom = draft.riskChoice === CUSTOM_RISK;
  const planLine = plan
    ? `Default ${formatPercent(plan.defaultRiskPercent ?? plan.maxRiskPercent)} · maximum ${formatPercent(plan.maxRiskPercent)} (${plan.version})`
    : null;
  return (
    <div id={FIELD_IDS.riskPercent} className="flex min-w-0 flex-col gap-2">
      <ChoiceChips
        name="riskChoice"
        legend={<RequiredLegend>Risk per trade</RequiredLegend>}
        className={CHIPS_GRID_ON_PHONE}
        options={[...presets.map(value => ({ value, label: formatPercent(value) })), { value: CUSTOM_RISK, label: "Custom" }]}
        value={draft.riskChoice}
        disabled={disabled}
        onValueChange={value => {
          onChange({ riskChoice: value, customRisk: draft.customRisk });
          onTouch();
          if (value === CUSTOM_RISK) window.setTimeout(() => document.getElementById("plan-risk-custom")?.focus(), 0);
        }}
        aria-describedby={cx("plan-risk-hint", error && !custom && "plan-risk-error") || undefined}
      />
      {custom && (
        <Field label="Custom risk" id="plan-risk-custom" error={error} className="max-w-48">
          <DecimalInput value={draft.customRisk} readOnly={disabled} endAdornment="%" onBlur={onTouch} onValueChange={customRisk => onChange({ customRisk })} />
        </Field>
      )}
      {!custom && <GroupError id="plan-risk-error" message={error} />}
      <p id="plan-risk-hint" className="field-hint flex flex-col gap-0.5">
        {budget && (
          <span>
            <HintText hint={budget} />
          </span>
        )}
        {planLine && <span>{planLine}</span>}
      </p>
    </div>
  );
}

function ThesisHint({ text }: { text: string }) {
  const length = [...text].length;
  return (
    <span className="flex flex-wrap justify-between gap-x-3">
      <span>{THESIS_HINT}</span>
      {length > 4000 && <span className="num">{length.toLocaleString("en-US")} / 5,000</span>}
    </span>
  );
}
