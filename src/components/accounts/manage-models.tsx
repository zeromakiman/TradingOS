"use client";

import { Archive, ArchiveRestore, Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { archiveCustomModel, createCustomModel, removeCustomModel, renameCustomModel, restoreCustomModel } from "@/app/actions/models";
import { type ActionState, idleState } from "@/app/actions/state";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useOptionalToast } from "@/components/ui/toast";
import type { CustomModel } from "@/domain/custom-models";
import { ActionFeedback } from "./action-feedback";
import type { FieldRule } from "./form-checks";
import { fieldError, useAccountAction } from "./use-account-action";

/**
 * Manage → Models (0020): the account's custom models. A custom model labels live-first trades in the journal and in
 * EDGE's "By custom model"; it is never validated by the Risk Engine, which knows OB first touch and OTE only. Create,
 * rename and archive keep every earlier revision; a model can be removed only while no trade was recorded with it.
 */

export const CUSTOM_MODEL_NOTE = "Custom models are journal labels for live-first trades. The Risk Engine validates OB first touch and OTE only, so a plan always uses one of those.";

const MODEL_RULES: Readonly<Record<string, FieldRule>> = {
  name: { kind: "text", max: 60, message: "Name the model (1 to 60 characters)." },
  description: { kind: "text", max: 500, optional: true, message: "Keep the description to 500 characters." },
};

type Run = (action: (prev: ActionState, form: FormData) => Promise<ActionState>, values: Record<string, string>) => Promise<ActionState>;

function useModelAction(): Run {
  const toast = useOptionalToast();
  const router = useRouter();
  return async (action, values) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(values)) form.set(key, value);
    const result = await action(idleState, form);
    if (result.status === "success") {
      toast?.toast({ title: result.message ?? "Saved.", tone: "positive" });
      router.refresh();
    }
    return result;
  };
}

export function CreateModelForm({ accountId }: { accountId: string }) {
  const [generation, setGeneration] = useState(0);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const { state, pending, run, feedbackKey } = useAccountAction<{ modelId: string; name: string }>(createCustomModel, () => {
    setGeneration(value => value + 1);
    setRequestKey(crypto.randomUUID());
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set("accountId", accountId);
    form.set("requestKey", requestKey);
    run(form, MODEL_RULES);
  };
  return (
    <div className="flex flex-col gap-4">
      <ActionFeedback key={`feedback-${feedbackKey}`} state={state} />
      <form key={generation} noValidate onSubmit={submit} className="flex flex-col gap-4" aria-label="Add model" aria-busy={pending}>
        <Field label="Name" required error={fieldError(state, "name")} hint="For example “TSP + IFVG + CISD”. OB first touch, OTE and Other are taken.">
          <Input name="name" maxLength={60} autoComplete="off" disabled={pending} />
        </Field>
        <Field label="Description" optional error={fieldError(state, "description")} hint="What the model is, in your words.">
          <Textarea name="description" rows={2} maxLength={500} disabled={pending} />
        </Field>
        <div>
          <Button type="submit" variant="secondary" loading={pending} loadingText="Adding…">
            Add model
          </Button>
        </div>
      </form>
    </div>
  );
}

function RenameDialog({ model }: { model: CustomModel }) {
  const run = useModelAction();
  const [name, setName] = useState(model.name);
  const [description, setDescription] = useState(model.description ?? "");
  return (
    <ConfirmDialog
      trigger={<Button variant="ghost" size="sm" icon={<Pencil aria-hidden="true" />}>Rename</Button>}
      onOpenChange={open => {
        if (open) {
          setName(model.name);
          setDescription(model.description ?? "");
        }
      }}
      title={`Rename ${model.name}`}
      description="Trades recorded with this model show the new name. The earlier name stays in its history."
      confirmLabel="Save"
      pendingLabel="Saving…"
      confirmDisabled={name.trim().length === 0 || name.trim().length > 60}
      onConfirm={() => run(renameCustomModel, { modelId: model.id, name: name.trim(), description: description.trim() })}
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" required>
          <Input value={name} maxLength={60} autoComplete="off" onChange={event => setName(event.target.value)} />
        </Field>
        <Field label="Description" optional>
          <Textarea rows={2} maxLength={500} value={description} onChange={event => setDescription(event.target.value)} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}

function ModelRow({ model }: { model: CustomModel }) {
  const run = useModelAction();
  const archived = model.status === "ARCHIVED";
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-1 break-words">{model.name}</span>
          <StatusPill tone={archived ? "muted" : "neutral"}>{archived ? "Archived" : "Custom · not validated by the Risk Engine"}</StatusPill>
        </p>
        {model.description && <p className="t-meta break-words">{model.description}</p>}
        <p className="t-caption">{model.used ? "Recorded on trades: it can be archived, not removed." : "Not recorded on any trade yet."}</p>
      </div>
      <div className="flex flex-none flex-wrap gap-1">
        <RenameDialog model={model} />
        {archived ? (
          <ConfirmDialog
            trigger={<Button variant="ghost" size="sm" icon={<ArchiveRestore aria-hidden="true" />}>Restore</Button>}
            title={`Restore ${model.name}?`}
            description="It returns to the Model field of Record Live Trade."
            confirmLabel="Restore model"
            pendingLabel="Restoring…"
            onConfirm={() => run(restoreCustomModel, { modelId: model.id })}
          />
        ) : (
          <ConfirmDialog
            trigger={<Button variant="ghost" size="sm" icon={<Archive aria-hidden="true" />}>Archive</Button>}
            title={`Archive ${model.name}?`}
            description="It leaves the Model field of Record Live Trade. Trades recorded with it keep it, and EDGE still groups them."
            confirmLabel="Archive model"
            pendingLabel="Archiving…"
            onConfirm={() => run(archiveCustomModel, { modelId: model.id })}
          />
        )}
        {!model.used && (
          <ConfirmDialog
            trigger={<Button variant="ghost" size="sm" icon={<Trash2 aria-hidden="true" />}>Remove</Button>}
            tone="danger"
            title={`Remove ${model.name}?`}
            description="No trade was recorded with it, so it is removed completely."
            confirmLabel="Remove model"
            pendingLabel="Removing…"
            onConfirm={() => run(removeCustomModel, { modelId: model.id })}
          />
        )}
      </div>
    </li>
  );
}

export function ModelList({ models }: { models: readonly CustomModel[] }) {
  const active = models.filter(model => model.status === "ACTIVE");
  const archived = models.filter(model => model.status === "ARCHIVED");
  if (models.length === 0) return <p className="t-meta">No custom models yet. Add one here, or with “+ Add model” in Record Live Trade.</p>;
  return (
    <div className="flex flex-col gap-4">
      {active.length > 0 && (
        <ul className="flex flex-col divide-y divide-border" aria-label="Active models">
          {active.map(model => <ModelRow key={model.id} model={model} />)}
        </ul>
      )}
      {archived.length > 0 && (
        <section className="flex flex-col gap-1" aria-label="Archived models">
          <h3 className="text-sm font-semibold text-2">Archived · {archived.length}</h3>
          <ul className="flex flex-col divide-y divide-border">
            {archived.map(model => <ModelRow key={model.id} model={model} />)}
          </ul>
        </section>
      )}
    </div>
  );
}
