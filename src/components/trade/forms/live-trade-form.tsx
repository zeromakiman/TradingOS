"use client";

import { ArrowDownRight, ArrowUpRight, ChevronLeft, Plus, Radio, RotateCcw } from "lucide-react";
import Link from "next/link";
import { unstable_rethrow, useRouter } from "next/navigation";
import { type FormEvent, useMemo, useRef, useState, useTransition } from "react";
import { type ActionState, INVALID_COPY, idleState } from "@/app/actions/state";
import { type LiveTradeResult, recordLiveTrade } from "@/app/actions/trades";
import { manageHref } from "@/components/accounts/copy";
import { randomUuid } from "@/components/evidence/use-evidence-stager";
import { useTimeFormat } from "@/components/shell/time-display";
import { useModifierKeyLabel } from "@/components/shell/use-media-query";
import { Button, buttonClasses } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Checkbox, SegmentedControl } from "@/components/ui/choice";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Disclosure } from "@/components/ui/disclosure";
import { Field } from "@/components/ui/field";
import { FormAlert } from "@/components/ui/form-alert";
import { Input, Select } from "@/components/ui/input";
import { KbdCombo } from "@/components/ui/kbd";
import { PageHeader } from "@/components/ui/page-header";
import { useOptionalToast } from "@/components/ui/toast";
import { stripZeros } from "@/domain/format";
import { strategyClock } from "@/domain/session";
import { formatTime, STRATEGY_ZONE_LABEL } from "@/domain/time-display";
import { restoreLiveDraft, sameDraft } from "./autosave";
import {
  ADD_INSTRUMENT, DIRECTION_OPTIONS, DISCARD_RESTORED, GAP_COPY, LIVE_DESCRIPTION, LIVE_NO_PLAN_NOTE, LIVE_TITLE, MANAGE_MODELS, MODEL_GROUP_CUSTOM, MODEL_GROUP_VALIDATED,
  MODEL_LABELS, OTHER_SYMBOL_LABEL, PLAN_MODELS,
  PRICE_LATER, RESTORED_LIVE_BODY, RESTORED_TITLE, START_LIVE_JOURNAL, strategyTimeHint, TIMING_LABELS, TIMING_NOW_HINT, TIMING_UNKNOWN_HINT, UNREACHABLE_COPY,
} from "./copy";
import { AccountChip, focusField, FormSection, formKeyDown, GroupError, RequiredLegend, SEGMENTED_FULL_ON_PHONE } from "./form-parts";
import { useLeaveGuard } from "./leave-guard";
import {
  CUSTOM_MODEL_PREFIX, derivedLiveRisk, ENTRY_TIMINGS, LIVE_FIELD_ORDER, type LiveDraft, type LiveField, type LiveFieldErrors, liveInstrument, liveModelChoice,
  liveModelValue, liveServerErrors, liveTradeForm, MANAGE_MODELS_VALUE, OTHER_SYMBOL, strategyWallTime, switchLiveAccount, validateLive, wallTimeToInstant,
  withPriceLater,
} from "./live-model";
import { AddModelDialog } from "./add-model-dialog";
import { pricePlaceholder } from "./plan-model";
import type { FormAccount, FormCustomModel, FormUsage } from "./types";
import { useFormAutosave } from "./use-autosave";
import { useServerClock } from "./use-server-clock";
import { ZonedTimeInput } from "../zoned-time-input";

/**
 * Record Live Trade (docs/V2_ARCHITECTURE.md §8.2, §14.3): one minimal, mobile-first screen — account, instrument (or
 * another symbol), direction, entry price (or "Already open — add price later"), entry time (Now, Earlier in strategy
 * time, or Not sure: no time is recorded until "Add entry details"), and optional size, stop, risk and model. "Start live
 * journal" records the position with recordLiveTrade and opens its journal. "Now" is resolved by the server; the request
 * key is kept until a trade is recorded (also with the entries kept in the tab after Back or a reload), so a retry after
 * a lost response returns the same trade instead of a second one that would count toward today's limits.
 */

export interface LiveTradeFormProps {
  now: string;
  accounts: FormAccount[];
  initial: LiveDraft;
  /** Overrides the server action (tests and demos). */
  action?: typeof recordLiveTrade;
  /** Where the unsaved entries are kept in the tab (`autosaveKey`); without it nothing is kept. */
  autosaveKey?: string | null;
}

type Phase = "idle" | "saving" | "done";

const FIELD_IDS: Readonly<Record<LiveField, string>> = Object.freeze({
  accountId: "live-account", instrumentId: "live-instrument", symbol: "live-symbol", direction: "live-direction", entryPrice: "live-entry",
  enteredAt: "live-time-input", quantity: "live-size", initialStop: "live-stop", riskAmount: "live-risk", entryModel: "live-model",
});
const OPTIONAL_FIELDS: readonly LiveField[] = ["quantity", "initialStop", "riskAmount", "entryModel"];
const TIMING_OPTIONS = ENTRY_TIMINGS.map(value => ({ value, label: TIMING_LABELS[value] }));


/** `Today: 1 of 2 trades used. Live-first trades count toward the daily limits.` */
export function liveUsageText(usage: FormUsage): string {
  return `Today: ${usage.used} of ${usage.max} ${usage.max === 1 ? "trade" : "trades"} used. Live-first trades count toward the daily limits.`;
}

/** Title of the notice shown when the account already used its daily trades. */
export function limitReachedTitle(usage: FormUsage): string {
  return `Daily trade limit reached (${usage.used} of ${usage.max})`;
}

export const LIMIT_REACHED_BODY = "Record it anyway: an open position belongs in the journal, and it counts toward today's limits.";

export function LiveTradeForm({ now: serverNow, accounts: accountsProp, initial, action = recordLiveTrade, autosaveKey = null }: LiveTradeFormProps) {
  const router = useRouter();
  // Models added with "+ Add model" on this page join their account's list at once (the page itself is not reloaded).
  const [addedModels, setAddedModels] = useState<readonly (FormCustomModel & { accountId: string })[]>([]);
  const accounts = useMemo(
    () => accountsProp.map(item => {
      const extra = addedModels.filter(model => model.accountId === item.id && !item.customModels.some(known => known.id === model.id));
      return extra.length ? { ...item, customModels: [...item.customModels, ...extra.map(({ id, name }) => ({ id, name }))].sort((a, b) => a.name.localeCompare(b.name)) } : item;
    }),
    [accountsProp, addedModels],
  );
  const toast = useOptionalToast();
  const modifier = useModifierKeyLabel();
  const format = useTimeFormat();
  const now = useServerClock(serverNow);
  const [draft, setDraft] = useState<LiveDraft>(initial);
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<LiveFieldErrors>({});
  const [failure, setFailure] = useState<{ text: string; key: number; focus: boolean } | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [optionalOpen, setOptionalOpen] = useState(false);
  const [, startTransition] = useTransition();
  const requestKey = useRef<string | null>(null);
  const autosave = useFormAutosave({
    storageKey: autosaveKey,
    draft,
    initial,
    requestKey,
    restore: stored => restoreLiveDraft(stored, accounts, initial),
    onRestore: restored => {
      setDraft(restored);
      // Restored size, stop, risk or model stay in sight instead of inside the closed section.
      if ([restored.quantity, restored.initialStop, restored.riskAmount, restored.entryModel].some(value => value.trim() !== "")) setOptionalOpen(true);
    },
    active: phase === "idle",
  });

  const account = accounts.find(item => item.id === draft.accountId) ?? null;
  const unavailable = account?.gaps.includes("UNAVAILABLE") === true;
  const instrument = liveInstrument(draft, account);
  const busy = phase !== "idle";
  const dirty = phase === "idle" && !sameDraft(draft, initial);
  const guard = useLeaveGuard(dirty, autosave.clear);
  const check = validateLive(draft, account, now);
  const errors: LiveFieldErrors = { ...(submitted && !check.ok ? check.fieldErrors : {}), ...serverErrors };
  const derivedRisk = derivedLiveRisk(draft, instrument);
  const usage = account?.usage && account.usage.day === strategyClock(now).day ? account.usage : null;
  const atLimit = usage !== null && usage.used >= usage.max;
  const maxWall = strategyWallTime(now);
  const strategyNow = formatTime(now);
  const earlierInstant = draft.timing === "earlier" ? wallTimeToInstant(draft.enteredAt) : null;
  const optionalErrors = OPTIONAL_FIELDS.some(field => errors[field]);
  const selectedCustom = draft.customModelId !== "" ? (account?.customModels.find(model => model.id === draft.customModelId) ?? null) : null;
  const unit = instrument?.quantityUnit;

  const update = (change: Partial<LiveDraft> | ((current: LiveDraft) => LiveDraft), fields: readonly LiveField[]) => {
    setDraft(current => (typeof change === "function" ? change(current) : { ...current, ...change }));
    if (fields.some(field => serverErrors[field])) setServerErrors(current => Object.fromEntries(Object.entries(current).filter(([key]) => !fields.includes(key as LiveField))));
  };

  const changeAccount = (accountId: string) => {
    const next = accounts.find(item => item.id === accountId);
    if (next) setDraft(current => switchLiveAccount(current, next, accounts));
    setServerErrors({});
    setFailure(null);
  };

  const showErrors = (fieldErrors: LiveFieldErrors, message: string) => {
    const first = LIVE_FIELD_ORDER.find(field => fieldErrors[field]);
    if (first && OPTIONAL_FIELDS.includes(first)) setOptionalOpen(true);
    setFailure({ text: message, key: Date.now(), focus: first === undefined });
    if (first) window.setTimeout(() => focusField(FIELD_IDS[first]), 0);
  };

  const submit = () => {
    if (phase !== "idle") return;
    setSubmitted(true);
    if (unavailable) {
      setFailure({ text: GAP_COPY.UNAVAILABLE.text, key: Date.now(), focus: true });
      return;
    }
    if (!check.ok) {
      showErrors(check.fieldErrors, INVALID_COPY);
      return;
    }
    requestKey.current ??= randomUuid();
    // The key is kept with the entries before anything is sent: leaving mid-request and coming back replays it.
    autosave.save(draft);
    const body = liveTradeForm(check.fields, requestKey.current);
    setFailure(null);
    setServerErrors({});
    setPhase("saving");
    startTransition(async () => {
      let result: ActionState<LiveTradeResult>;
      try {
        result = await action(idleState, body);
      } catch (error) {
        unstable_rethrow(error);
        result = { status: "error", message: UNREACHABLE_COPY };
      }
      if (result.status !== "success" || !result.data) {
        const mapped = result.status === "error" ? liveServerErrors(result.fieldErrors) : {};
        setPhase("idle");
        setServerErrors(mapped);
        showErrors(mapped, result.status === "error" ? result.message : UNREACHABLE_COPY);
        return;
      }
      setPhase("done");
      autosave.clear();
      guard.release();
      toast?.toast({ title: result.message ?? "Live trade recorded.", tone: "positive" });
      router.replace(`/trades/${result.data.tradeId}#journal`);
    });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  // Back to the entries the page opened with.
  const discardRestored = () => {
    autosave.discard();
    requestKey.current = null;
    setDraft(initial);
    setSubmitted(false);
    setServerErrors({});
    setFailure(null);
    setOptionalOpen(false);
    window.setTimeout(() => focusField(FIELD_IDS.accountId), 0);
  };

  const modifierName = modifier === "⌘" ? "Command" : "Control";
  const instruments = account?.instruments ?? [];
  const otherSymbol = draft.instrumentId === OTHER_SYMBOL;
  const directionError = errors.direction;
  const accountHint = !account
    ? "The position is recorded in one trading account."
    : unavailable
      ? GAP_COPY.UNAVAILABLE.text
      : usage && !atLimit
        ? liveUsageText(usage)
        : account.description;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <PageHeader
        className="mb-0"
        eyebrow={
          <span className="flex items-center justify-between gap-3">
            {/* The way back keeps its width (the header lets words break); the account chip beside it shrinks instead. */}
            <Link href="/today" className="inline-flex min-h-10 shrink-0 items-center gap-1 text-text-2 hover:text-text pointer-coarse:min-h-11">
              <ChevronLeft aria-hidden="true" className="size-4" />
              Today
            </Link>
            {account && <AccountChip name={account.name} currency={account.currency} className="sm:hidden" />}
          </span>
        }
        title={LIVE_TITLE}
        description={LIVE_DESCRIPTION}
        actions={account ? <AccountChip name={account.name} currency={account.currency} className="max-sm:hidden" /> : undefined}
      />
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
          {RESTORED_LIVE_BODY}
        </Callout>
      )}
      {failure && (
        <FormAlert key={failure.key} tone="error" focusOnMount={failure.focus}>
          {failure.text}
        </FormAlert>
      )}
      <form noValidate aria-label="Record live trade" aria-busy={busy} onSubmit={onSubmit} onKeyDown={formKeyDown} className="card flex min-w-0 flex-col">
        <FormSection title="Position" id="live-position">
          <Field label="Trading account" required id={FIELD_IDS.accountId} error={errors.accountId} hint={accountHint}>
            <Select value={draft.accountId} disabled={busy} onChange={event => changeAccount(event.target.value)}>
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
          {atLimit && usage && (
            <Callout tone="warning" title={limitReachedTitle(usage)}>
              {LIMIT_REACHED_BODY}
            </Callout>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Instrument"
              required
              id={FIELD_IDS.instrumentId}
              error={errors.instrumentId}
              hint={
                <span className="flex flex-wrap items-center gap-x-2">
                  <span>{otherSymbol ? "Without contract values, you report the net P&L when you close." : instrument ? `Sized in ${instrument.quantityUnit}.` : "The contract, or Other symbol."}</span>
                  {account && !unavailable && (
                    <Link href={manageHref(account.id, "instruments")} className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
                      <Plus aria-hidden="true" className="size-3.5" />
                      {ADD_INSTRUMENT}
                    </Link>
                  )}
                </span>
              }
            >
              <Select
                value={draft.instrumentId}
                disabled={busy || !account || unavailable}
                onChange={event => update({ instrumentId: event.target.value }, ["instrumentId", "symbol", "entryPrice", "quantity", "initialStop"])}
              >
                {draft.instrumentId === "" && (
                  <option value="" disabled>
                    {account ? "Choose an instrument" : "Choose an account first"}
                  </option>
                )}
                {instruments.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.symbol}
                  </option>
                ))}
                <option value={OTHER_SYMBOL}>{OTHER_SYMBOL_LABEL}…</option>
              </Select>
            </Field>
            {otherSymbol ? (
              <Field label="Symbol" required id={FIELD_IDS.symbol} error={errors.symbol} hint="Capital letters and digits, for example US30.">
                <Input
                  value={draft.symbol}
                  maxLength={20}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  readOnly={busy}
                  onChange={event => update({ symbol: event.target.value.toUpperCase() }, ["symbol"])}
                />
              </Field>
            ) : (
              <div id={FIELD_IDS.direction} className="flex min-w-0 flex-col gap-1.5">
                <DirectionControl value={draft.direction} disabled={busy} error={directionError} onChange={direction => update({ direction }, ["direction"])} />
              </div>
            )}
          </div>
          {otherSymbol && (
            <div id={FIELD_IDS.direction} className="flex min-w-0 flex-col gap-1.5">
              <DirectionControl value={draft.direction} disabled={busy} error={directionError} onChange={direction => update({ direction }, ["direction"])} />
            </div>
          )}
        </FormSection>

        <FormSection title="Entry" id="live-entry-section">
          <div className="flex flex-col gap-2">
            <Field
              label="Entry price"
              required={!draft.priceLater}
              id={FIELD_IDS.entryPrice}
              error={draft.priceLater ? undefined : errors.entryPrice}
              hint={draft.priceLater ? "Add it on the trade page with Add entry details." : instrument ? `Tick size ${stripZeros(instrument.tickSize)}` : undefined}
            >
              <DecimalInput
                value={draft.priceLater ? "" : draft.entryPrice}
                placeholder={instrument && !draft.priceLater ? pricePlaceholder(instrument.tickSize) : undefined}
                disabled={busy || draft.priceLater}
                onValueChange={entryPrice => update({ entryPrice }, ["entryPrice", "initialStop"])}
              />
            </Field>
            <Checkbox
              label={PRICE_LATER}
              checked={draft.priceLater}
              disabled={busy}
              onChange={event => {
                const checked = event.target.checked;
                update(current => withPriceLater(current, checked), ["entryPrice"]);
              }}
            />
          </div>
          <div id="live-time" className="flex flex-col gap-3">
            <SegmentedControl
              name="timing"
              legend="Entry time"
              legendHidden={false}
              className={SEGMENTED_FULL_ON_PHONE}
              options={TIMING_OPTIONS}
              value={draft.timing}
              disabled={busy}
              onValueChange={value => {
                if (value === "earlier") update({ timing: "earlier", enteredAt: draft.enteredAt || maxWall }, ["enteredAt"]);
                else if (value === "now" || value === "unknown") update({ timing: value }, ["enteredAt"]);
              }}
              aria-describedby={draft.timing === "earlier" ? undefined : "live-time-hint"}
            />
            {draft.timing !== "earlier" ? (
              <p id="live-time-hint" className="field-hint -mt-1.5">
                {draft.timing === "now" ? TIMING_NOW_HINT : TIMING_UNKNOWN_HINT}
              </p>
            ) : (
              <Field
                label={`Entry date and time (${STRATEGY_ZONE_LABEL})`}
                required
                id={FIELD_IDS.enteredAt}
                error={errors.enteredAt}
                hint={
                  earlierInstant && format.display.mode !== "strategy"
                    ? `${strategyTimeHint(strategyNow)} That is ${format.dateTime(earlierInstant)} ${format.zone(earlierInstant)} in your time display.`
                    : strategyTimeHint(strategyNow)
                }
                className="sm:max-w-xs"
              >
                <ZonedTimeInput zone={STRATEGY_ZONE_LABEL} max={maxWall} value={draft.enteredAt} readOnly={busy} onChange={event => update({ enteredAt: event.target.value }, ["enteredAt"])} />
              </Field>
            )}
          </div>
        </FormSection>

        <div className="border-border border-t px-4 py-4 md:px-5">
          <Disclosure
            summary={
              <span className="flex flex-col">
                <span>Size, stop and risk</span>
                <span className="t-caption font-normal">Optional. R needs a risk amount, or a stop and size. Add them now or later on the trade page.</span>
              </span>
            }
            open={optionalOpen || optionalErrors}
            onToggle={event => setOptionalOpen(event.currentTarget.open)}
            bodyClassName="flex flex-col gap-4 pt-2"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Size" optional id={FIELD_IDS.quantity} error={errors.quantity} hint={instrument ? `Step ${stripZeros(instrument.quantityStep)} · minimum ${stripZeros(instrument.minimumQuantity)}` : undefined}>
                <DecimalInput value={draft.quantity} readOnly={busy} endAdornment={unit ? <span className="max-w-32 truncate" title={unit}>{unit}</span> : undefined} onValueChange={quantity => update({ quantity }, ["quantity"])} />
              </Field>
              <Field label="Stop" optional id={FIELD_IDS.initialStop} error={errors.initialStop} hint={instrument ? `Tick size ${stripZeros(instrument.tickSize)}` : undefined}>
                <DecimalInput value={draft.initialStop} placeholder={instrument ? pricePlaceholder(instrument.tickSize) : undefined} readOnly={busy} onValueChange={initialStop => update({ initialStop }, ["initialStop"])} />
              </Field>
            </div>
            <Field
              label="Risk amount"
              optional
              id={FIELD_IDS.riskAmount}
              error={errors.riskAmount}
              hint={
                derivedRisk && draft.riskAmount.trim() === ""
                  ? `Without it, R uses the risk at your stop: ${derivedRisk} (from entry, stop and size).`
                  : "Money you lose if the stop is hit. R uses this amount when you enter it."
              }
              className="sm:max-w-[calc(50%-0.5rem)]"
            >
              <DecimalInput value={draft.riskAmount} readOnly={busy} endAdornment={account ? <span aria-hidden="true">{account.currency}</span> : undefined} onValueChange={riskAmount => update({ riskAmount }, ["riskAmount"])} />
            </Field>
            <Field
              label="Model"
              optional
              id={FIELD_IDS.entryModel}
              error={errors.entryModel}
              className="sm:max-w-[calc(50%-0.5rem)]"
              hint={
                <span className="flex flex-col gap-1">
                  <span>{selectedCustom ? `${selectedCustom.name}: ${MODEL_GROUP_CUSTOM}. Recorded as Other.` : "OB first touch and OTE are validated by the Risk Engine; custom models are journal labels."}</span>
                  {account && !unavailable && (
                    <span className="flex flex-wrap items-center gap-x-3">
                      <AddModelDialog
                        accountId={account.id}
                        disabled={busy}
                        onCreated={model => {
                          setAddedModels(current => [...current, { ...model, accountId: account.id }]);
                          update({ entryModel: "OTHER", customModelId: model.id }, ["entryModel"]);
                        }}
                      />
                      <Link href={manageHref(account.id, "models")} className="font-medium text-accent hover:underline">
                        {MANAGE_MODELS}
                      </Link>
                    </span>
                  )}
                </span>
              }
            >
              <Select
                value={liveModelValue(draft)}
                disabled={busy}
                onChange={event => {
                  const value = event.target.value;
                  if (value === MANAGE_MODELS_VALUE) {
                    if (account) router.push(manageHref(account.id, "models"));
                    return;
                  }
                  const choice = liveModelChoice(value, account);
                  if (choice) update(choice, ["entryModel"]);
                }}
              >
                <option value="">No model</option>
                <optgroup label={MODEL_GROUP_VALIDATED}>
                  {PLAN_MODELS.map(model => (
                    <option key={model} value={model}>
                      {MODEL_LABELS[model]}
                    </option>
                  ))}
                </optgroup>
                <option value="OTHER">{MODEL_LABELS.OTHER}</option>
                {account && account.customModels.length > 0 && (
                  <optgroup label={MODEL_GROUP_CUSTOM}>
                    {account.customModels.map(model => (
                      <option key={model.id} value={`${CUSTOM_MODEL_PREFIX}${model.id}`}>
                        {model.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {account && !unavailable && <option value={MANAGE_MODELS_VALUE}>{MANAGE_MODELS}</option>}
              </Select>
            </Field>
          </Disclosure>
        </div>

        <p className="t-meta flex items-start gap-2 border-border border-t px-4 pt-4 md:px-5">
          <Radio aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-live" />
          <span>{LIVE_NO_PLAN_NOTE}</span>
        </p>
        <div className="sticky bottom-[calc(3.5rem_+_env(safe-area-inset-bottom))] z-20 flex flex-wrap items-center gap-3 rounded-b-card bg-surface px-4 py-4 max-md:shadow-[0_-1px_0_var(--border)] md:static md:px-5">
          <Button type="submit" size="lg" loading={busy} loadingText="Recording…" className="max-sm:flex-1">
            {START_LIVE_JOURNAL}
          </Button>
          <Link href="/today" className={buttonClasses({ variant: "ghost" })}>
            Cancel
          </Link>
          <p className="t-caption ml-auto hidden items-center gap-1 md:flex">
            <KbdCombo keys={[modifier, "Enter"]} label={`${modifierName} Enter`} /> records
          </p>
        </div>
      </form>
      {guard.dialog}
    </div>
  );
}

function DirectionControl({ value, disabled, error, onChange }: { value: LiveDraft["direction"]; disabled: boolean; error: string | undefined; onChange: (direction: "LONG" | "SHORT") => void }) {
  return (
    <>
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
        value={value}
        disabled={disabled}
        onValueChange={next => onChange(next === "SHORT" ? "SHORT" : "LONG")}
        aria-describedby={error ? "live-direction-error" : undefined}
      />
      <GroupError id="live-direction-error" message={error} />
    </>
  );
}
