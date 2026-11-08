"use client";

/**
 * Interactive specimens for the developer UI gallery (src/app/dev/ui). They exist so the
 * primitives that need client state can be exercised with synthetic data; production
 * screens compose the primitives directly.
 */

import { Ellipsis, Lock } from "lucide-react";
import { useState } from "react";
import { Button } from "./button";
import { DecimalInput } from "./decimal-input";
import { ConfirmDialog } from "./dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Field } from "./field";
import { FormAlert } from "./form-alert";
import { type ToastTone, useToast } from "./toast";

const TOASTS: { tone: ToastTone; title: string; description: string }[] = [
  { tone: "positive", title: "Draft saved", description: "Revision 2 · risk check: Ready to lock." },
  { tone: "info", title: "Screenshot uploaded", description: "M5 chart added to Before entry." },
  { tone: "warning", title: "Recheck needed", description: "The session changed since the last check." },
  { tone: "negative", title: "Upload failed", description: "The image is larger than 4 MB." },
];

export function ToastDemo() {
  const { toast } = useToast();
  return (
    <div className="gallery-row">
      {TOASTS.map((item) => (
        <Button key={item.tone} variant="secondary" size="sm" onClick={() => toast(item)}>
          {item.title}
        </Button>
      ))}
    </div>
  );
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function ConfirmDialogDemo() {
  const { toast } = useToast();
  return (
    <div className="gallery-row">
      <ConfirmDialog
        trigger={
          <Button icon={<Lock aria-hidden="true" />} variant="primary">
            Lock plan
          </Button>
        }
        title="Lock this plan?"
        description="Locking reserves 1 of 2 daily trade slots and 0.50% risk."
        confirmLabel="Lock plan"
        pendingLabel="Locking…"
        onConfirm={async () => {
          await wait(700);
          toast({ tone: "positive", title: "Plan locked", description: "EURUSD · Long · waiting for entry." });
        }}
      >
        <ul className="t-meta list-disc pl-5">
          <li>Entry, stop, target, size and thesis become immutable.</li>
          <li>Later changes are recorded in the journal.</li>
        </ul>
      </ConfirmDialog>
      <ConfirmDialog
        trigger={<Button variant="danger">Discard draft</Button>}
        title="Discard this draft?"
        description="The draft and its revisions stay in history but leave your active list."
        confirmLabel="Discard draft"
        tone="danger"
        onConfirm={async () => {
          await wait(500);
          toast({ tone: "neutral", title: "Draft discarded" });
        }}
      />
      <ConfirmDialog
        trigger={<Button variant="secondary">Lock plan (refused)</Button>}
        title="Lock this plan?"
        description="This specimen's action returns an error state, so the dialog stays open and shows the message."
        confirmLabel="Lock plan"
        pendingLabel="Locking…"
        onConfirm={async () => {
          await wait(500);
          return { status: "error", message: "This draft changed since you opened it. Reload to see the latest revision." };
        }}
      />
    </div>
  );
}

export function DecimalInputDemo() {
  const [value, setValue] = useState("1.10000");
  return (
    <div className="flex flex-col gap-2">
      <Field id="gallery-entry" label="Entry price" hint="EURUSD tick size 0.00001 · type 1,10000 to see the comma normalised">
        <DecimalInput value={value} onValueChange={setValue} endAdornment="EURUSD" />
      </Field>
      <p className="t-meta">
        Stored string: <span className="num font-semibold">{JSON.stringify(value)}</span>
      </p>
    </div>
  );
}

export function MenuDemo() {
  const [view, setView] = useState("journal");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" icon={<Ellipsis aria-hidden="true" />}>
          Trade actions
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Duplicate draft</DropdownMenuItem>
        <DropdownMenuItem>Skip this trade</DropdownMenuItem>
        <DropdownMenuItem disabled>Reopen review</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Open in</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={view} onValueChange={setView}>
          <DropdownMenuRadioItem value="journal">Journal</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="edge">EDGE</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FormAlertDemo() {
  const [shown, setShown] = useState<"error" | "success" | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <div className="gallery-row">
        <Button variant="secondary" size="sm" onClick={() => setShown("error")}>
          Show error
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setShown("success")}>
          Show success
        </Button>
      </div>
      {shown === "error" && (
        <FormAlert tone="error" title="The draft was not saved">
          Entry price must be a positive number with up to 8 decimals.
        </FormAlert>
      )}
      {shown === "success" && (
        <FormAlert tone="success" title="Account values confirmed">
          Balance $10,000.00 · Equity $10,012.40 · recorded today.
        </FormAlert>
      )}
    </div>
  );
}
