"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { createCustomModel } from "@/app/actions/models";
import { idleState } from "@/app/actions/state";
import { CONNECTION_COPY } from "@/components/accounts/use-account-action";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { reservedModelName } from "@/domain/custom-models";
import { ADD_MODEL, MODEL_GROUP_CUSTOM } from "./copy";
import type { FormCustomModel } from "./types";

/**
 * "+ Add model" of Record Live Trade (0020): creates a custom model of the form's account inline and hands it back, so
 * the form selects it. A custom model is a journal label, never validated by the Risk Engine.
 */
export function AddModelDialog({ accountId, disabled, onCreated }: { accountId: string; disabled?: boolean; onCreated: (model: FormCustomModel) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const trimmed = name.trim();
  const reserved = reservedModelName(trimmed);
  const confirm = async () => {
    const form = new FormData();
    form.set("accountId", accountId);
    form.set("requestKey", requestKey);
    form.set("name", trimmed);
    if (description.trim()) form.set("description", description.trim());
    try {
      const result = await createCustomModel(idleState, form);
      if (result.status === "success" && result.data) {
        onCreated({ id: result.data.modelId, name: result.data.name });
        setName("");
        setDescription("");
        setRequestKey(crypto.randomUUID());
      }
      return result;
    } catch {
      return { status: "error" as const, message: CONNECTION_COPY };
    }
  };
  return (
    <ConfirmDialog
      trigger={
        <button type="button" disabled={disabled} className="inline-flex items-center gap-1 font-medium text-accent hover:underline disabled:opacity-50">
          <Plus aria-hidden="true" className="size-3.5" />
          {ADD_MODEL}
        </button>
      }
      title="Add model"
      description={`${MODEL_GROUP_CUSTOM}. The Risk Engine validates OB first touch and OTE only; a trade recorded with this model is stored as Other.`}
      confirmLabel="Add and select"
      pendingLabel="Adding…"
      confirmDisabled={trimmed.length === 0 || trimmed.length > 60 || reserved}
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Name"
          required
          error={reserved ? "OB first touch, OTE and Other are the Risk Engine's own models. Choose another name." : undefined}
          hint="For example “TSP + IFVG + CISD”. OB first touch, OTE and Other are taken."
        >
          <Input value={name} maxLength={60} autoComplete="off" onChange={event => setName(event.target.value)} />
        </Field>
        <Field label="Description" optional>
          <Textarea rows={2} maxLength={500} value={description} onChange={event => setDescription(event.target.value)} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}
