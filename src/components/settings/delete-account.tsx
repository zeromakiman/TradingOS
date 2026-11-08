"use client";

import { Trash2, TriangleAlert } from "lucide-react";
import { useActionState, useEffect, useId, useState } from "react";
import { deleteTradingOsAccount, type ErasureActionState } from "@/app/actions/erasure";
import { Button } from "../ui/button";
import { Callout } from "../ui/callout";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "../ui/dialog";
import { Field } from "../ui/field";
import { FormAlert } from "../ui/form-alert";
import { Input } from "../ui/input";
import { submitWithoutReset, useResultKey } from "./form-submit";
import { PasswordInput } from "./password-input";
import { DELETE_WORD } from "./settings-model";

/**
 * Settings → Danger zone → Delete Trading OS account (docs/V2_ARCHITECTURE.md §10.4). The dialog asks for the typed
 * word DELETE and the current password; the server re-authenticates, purges everything in one transaction, deletes
 * the stored images and the login, then signs out and opens the sign-in page. A failure leaves the dialog open with
 * the server's copy ("Deletion did not finish… you can safely try again").
 */

const INITIAL: ErasureActionState = {};

export function DeleteAccount({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  // While a deletion runs the dialog can't be dismissed.
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!busy) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="danger" icon={<Trash2 aria-hidden="true" />}>
          Delete Trading OS account…
        </Button>
      </DialogTrigger>
      <DialogContent title="Delete your Trading OS account?" description="This permanently deletes every record listed in the Danger zone and your login.">
        {/* Mounted only while the dialog is open: every opening starts with empty fields and without an earlier result. */}
        <DeleteAccountForm email={email} onBusyChange={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

export function DeleteAccountForm({ email, onBusyChange }: { email: string; onBusyChange: (busy: boolean) => void }) {
  const [state, dispatch, pending] = useActionState(deleteTradingOsAccount, INITIAL);
  const [word, setWord] = useState("");
  const [password, setPassword] = useState("");
  const warningId = useId();
  // A repeated failure (the same wrong password twice) mounts a fresh alert: announced and focused again.
  const resultKey = useResultKey(state);
  const ready = word === DELETE_WORD && password.length > 0;

  useEffect(() => {
    onBusyChange(pending);
    return () => onBusyChange(false);
  }, [pending, onBusyChange]);

  return (
    <form action={dispatch} onSubmit={submitWithoutReset(dispatch)} className="flex flex-col gap-4" aria-busy={pending} aria-describedby={warningId}>
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      <Callout id={warningId} tone="negative" icon={<TriangleAlert aria-hidden="true" />} title="This can't be undone">
        Nothing is kept for recovery. If you want a copy, close this and use Download my data first.
      </Callout>
      <Field label={`Type ${DELETE_WORD} to confirm`} hint="Capital letters, exactly as shown.">
        <Input
          name="confirmation"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={word}
          onChange={event => setWord(event.target.value)}
          disabled={pending}
        />
      </Field>
      <Field label="Current password" hint="Your password is checked again before anything is deleted.">
        <PasswordInput name="password" autoComplete="current-password" maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} disabled={pending} />
      </Field>
      {state.error && (
        <FormAlert key={resultKey} tone="error">
          {state.error}
        </FormAlert>
      )}
      <DialogFooter className="mt-1">
        <DialogClose asChild>
          <Button type="button" variant="secondary" disabled={pending}>
            Keep my account
          </Button>
        </DialogClose>
        <Button type="submit" variant="danger" disabled={!ready} loading={pending} loadingText="Deleting everything…">
          Delete everything permanently
        </Button>
      </DialogFooter>
    </form>
  );
}
