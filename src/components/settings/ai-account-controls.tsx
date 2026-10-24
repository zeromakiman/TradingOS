"use client";

import { Power, PowerOff, Sparkles } from "lucide-react";
import { useActionState, useEffect, useId, useState } from "react";
import type { ActionState as LegacyActionState } from "@/app/actions";
import { saveAiActivation, saveAiBudget } from "@/app/ai-settings-actions";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/choice";
import { DecimalInput } from "../ui/decimal-input";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "../ui/dialog";
import { Field } from "../ui/field";
import { FormAlert } from "../ui/form-alert";
import { submitWithoutReset, useResultKey } from "./form-submit";

/**
 * Settings → AI, one trading account (docs/V2_ARCHITECTURE.md §11.2): the opt-in with the existing consent
 * disclosure (the server refuses to enable without it, or while AI is unavailable) and the monthly limit. Both use
 * the existing actions in src/app/ai-settings-actions.ts.
 */

const INITIAL: LegacyActionState = {};
const PRESETS = ["3", "5", "10"] as const;

/** `500` cents → `5.00` (integer arithmetic; the budget is whole cents). */
function centsText(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** What a request may send (the existing consent disclosure, in V2 words). */
const SHARED_WITH_AI: readonly string[] = Object.freeze([
  "The screenshots you select for that request",
  "Your trade plan, thesis, journal notes and tags",
  "Trade results such as R, P&L and fees, for reviews",
  "Your strategy rules and the Risk Engine's results",
  "Earlier AI results of this account, when a review builds on them",
]);

export interface AiAccountControlsProps {
  accountId: string;
  accountName: string;
  enabled: boolean;
  budgetCents: number;
  /** Null when AI may be turned on; otherwise why it can't (deployment off, accounting paused). */
  enableBlockedReason: string | null;
}

function Result({ state, focus = false }: { state: LegacyActionState; focus?: boolean }) {
  if (state.error) return <FormAlert tone="error">{state.error}</FormAlert>;
  if (state.success) {
    return (
      <FormAlert tone="success" focusOnMount={focus}>
        {state.success}
      </FormAlert>
    );
  }
  return null;
}

export type ActivationControl = "enable" | "turnOff";

/**
 * The result shown beside the account's AI control, outside the dialog: that of the control used last. A refused
 * enable is not repeated here; it stays in the dialog that produced it.
 */
export function activationNotice(last: ActivationControl | null, enableState: LegacyActionState, turnOffState: LegacyActionState): LegacyActionState | null {
  if (last === "turnOff") return turnOffState;
  if (last === "enable" && enableState.success) return enableState;
  return null;
}

/**
 * The refusal the enable dialog shows: only one produced since this opening (`openedWith` is the result that was on
 * screen when it opened), so reopening starts clean. A success closes the dialog instead.
 */
export function enableRefusal(enableState: LegacyActionState, openedWith: LegacyActionState): LegacyActionState | null {
  return enableState !== openedWith && enableState.error ? enableState : null;
}

function Activation({ accountId, accountName, enabled, enableBlockedReason }: Omit<AiAccountControlsProps, "budgetCents">) {
  // Turning on and turning off keep separate results: the enable result belongs to the dialog's openings.
  const [enableState, enable, enabling] = useActionState(saveAiActivation, INITIAL);
  const [turnOffState, turnOff, turningOff] = useActionState(saveAiActivation, INITIAL);
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [openedWith, setOpenedWith] = useState<LegacyActionState>(INITIAL);
  const [last, setLast] = useState<ActivationControl | null>(null);
  const enableKey = useResultKey(enableState);
  const turnOffKey = useResultKey(turnOffState);
  const noteId = useId();

  useEffect(() => {
    if (enableState.success) setOpen(false);
  }, [enableState]);

  const refusal = enableRefusal(enableState, openedWith);
  const notice = activationNotice(last, enableState, turnOffState);
  // The button that acted is replaced once AI flips on or off, so the confirmation takes focus instead of the page body.
  const noticeAlert = notice && <Result key={last === "turnOff" ? `off-${turnOffKey}` : `on-${enableKey}`} state={notice} focus />;

  if (enabled) {
    return (
      <form action={turnOff} onSubmit={() => setLast("turnOff")} className="flex flex-col gap-2" aria-busy={turningOff}>
        <input type="hidden" name="accountId" value={accountId} />
        <input type="hidden" name="enabled" value="false" />
        <div>
          <Button type="submit" variant="secondary" icon={<PowerOff aria-hidden="true" />} loading={turningOff} loadingText="Turning off…">
            Turn off AI<span className="sr-only"> for {accountName}</span>
          </Button>
        </div>
        <p className="t-meta">Stops new requests. One already sent may still finish and be charged; earlier results stay in your history.</p>
        {noticeAlert}
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Dialog
        open={open}
        onOpenChange={next => {
          if (enabling) return;
          if (next) setOpenedWith(enableState);
          else setConsent(false);
          setOpen(next);
        }}
      >
        <div>
          <DialogTrigger asChild>
            <Button type="button" icon={<Power aria-hidden="true" />} disabled={enableBlockedReason !== null} aria-describedby={noteId}>
              Turn on AI…<span className="sr-only"> for {accountName}</span>
            </Button>
          </DialogTrigger>
        </div>
        <DialogContent title={`Turn on AI for ${accountName}?`} description="AI is advisory. It never decides whether you can trade: the Risk Engine does.">
          <form
            action={enable}
            onSubmit={event => {
              setLast("enable");
              submitWithoutReset(enable)(event);
            }}
            className="flex flex-col gap-4"
            aria-busy={enabling}
          >
            <input type="hidden" name="accountId" value={accountId} />
            <input type="hidden" name="enabled" value="true" />
            <div className="flex flex-col gap-2">
              <p className="text-text">Each time you explicitly request an analysis or review for this account, Trading OS sends the AI provider:</p>
              <ul className="ml-5 list-disc text-2">
                {SHARED_WITH_AI.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p className="t-meta">
                Nothing is sent when you open a page. Requests stop when this month's limit can't cover the next one; the limit never rises on its own.
              </p>
            </div>
            <Checkbox
              name="confirm"
              required
              checked={consent}
              onChange={event => setConsent(event.target.checked)}
              label="I understand and consent to sending this selected information to the AI provider when I request an analysis."
            />
            {refusal && <Result key={enableKey} state={refusal} />}
            <DialogFooter className="mt-1">
              <DialogClose asChild>
                <Button type="button" variant="secondary" disabled={enabling}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" icon={<Sparkles aria-hidden="true" />} disabled={!consent} loading={enabling} loadingText="Turning on…">
                Turn on AI
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <p id={noteId} className="t-meta">
        {enableBlockedReason ?? "Off until you turn it on. Nothing is sent before then."}
      </p>
      {!open && notice?.success && noticeAlert}
    </div>
  );
}

function BudgetForm({ accountId, accountName, budgetCents }: { accountId: string; accountName: string; budgetCents: number }) {
  const [state, dispatch, pending] = useActionState(saveAiBudget, INITIAL);
  const [value, setValue] = useState(centsText(budgetCents));
  const hintId = useId();
  const resultKey = useResultKey(state);
  return (
    <form action={dispatch} onSubmit={submitWithoutReset(dispatch)} className="flex flex-col gap-2" aria-busy={pending}>
      <input type="hidden" name="accountId" value={accountId} />
      <div className="flex flex-wrap items-end gap-2">
        <Field label={`Monthly limit for ${accountName}`} labelHidden className="w-32">
          <DecimalInput name="budget" value={value} onValueChange={setValue} startAdornment="€" required className="input-numeric" aria-describedby={hintId} />
        </Field>
        <Button type="submit" variant="secondary" loading={pending} loadingText="Saving…">
          Save limit<span className="sr-only"> for {accountName}</span>
        </Button>
      </div>
      <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0">
        <legend className="sr-only">Common limits for {accountName}</legend>
        {PRESETS.map(preset => (
          <button
            key={preset}
            type="button"
            aria-pressed={value === `${preset}.00` || value === preset}
            onClick={() => setValue(`${preset}.00`)}
            className="chip-toggle min-h-10 hover:text-text pointer-coarse:min-h-11"
          >
            €{preset}
          </button>
        ))}
        <span id={hintId} className="t-caption ml-1">
          €1.00 to €100.00
        </span>
      </fieldset>
      <Result key={resultKey} state={state} />
    </form>
  );
}

export function AiAccountControls(props: AiAccountControlsProps) {
  return (
    <div className="grid gap-5 md:grid-cols-2 md:gap-8">
      <div className="flex flex-col gap-2">
        <p className="font-semibold text-text">Use AI for this account</p>
        <Activation {...props} />
      </div>
      <div className="flex flex-col gap-2">
        <p className="font-semibold text-text">Monthly limit</p>
        <BudgetForm accountId={props.accountId} accountName={props.accountName} budgetCents={props.budgetCents} />
      </div>
    </div>
  );
}
