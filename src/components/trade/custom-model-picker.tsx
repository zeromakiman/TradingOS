"use client";

import { useState } from "react";
import { setTradeCustomModel } from "@/app/actions/models";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { useNotify } from "./action-message";
import { CUSTOM_MODEL_BADGE } from "./copy";
import { formOf, useTradeAction } from "./use-trade-action";

/**
 * Sets or changes the custom model of a live-first or imported trade recorded with Other or no model (0020). The trade's
 * entry model never changes: a custom model is a journal label, never validated by the Risk Engine.
 */
export function CustomModelPicker({ tradeId, current, models, manageHref }: {
  tradeId: string;
  current: { id: string; name: string } | null;
  models: readonly { id: string; name: string }[];
  manageHref: string;
}) {
  const notify = useNotify();
  const [value, setValue] = useState(current?.id ?? "");
  const { state, pending, run } = useTradeAction(setTradeCustomModel, result => notify(result.message));
  // An archived current model stays listed so the select shows it; it can only be kept or replaced.
  const options = current && !models.some(model => model.id === current.id) ? [current, ...models] : models;
  const changed = value !== (current?.id ?? "");
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={event => {
        event.preventDefault();
        run(formOf({ tradeId, modelId: value }));
      }}
    >
      <Field
        label="Custom model"
        optional
        error={state.status === "error" ? state.message : undefined}
        hint={
          <span>
            {CUSTOM_MODEL_BADGE}.{" "}
            <a href={manageHref} className="font-medium text-accent hover:underline">
              Manage models
            </a>
          </span>
        }
        className="sm:max-w-sm sm:flex-1"
      >
        <Select value={value} disabled={pending} onChange={event => setValue(event.target.value)}>
          <option value="">No custom model</option>
          {options.map(model => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" variant="secondary" size="sm" loading={pending} loadingText="Saving…" disabled={!changed} className="sm:mb-6">
        Save model
      </Button>
    </form>
  );
}
