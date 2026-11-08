"use client";

import { useRouter } from "next/navigation";
import { Fragment, type ReactNode, useState } from "react";
import { Field, type FieldControlProps } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { useReviewTransition } from "./pending";

/**
 * A native select whose options are URLs (account and period pickers of the Review workspace). Choosing an option
 * navigates inside the page transition, so the current review stays visible, dimmed, until the next one is ready.
 * The choice shows at once; whenever the URL's value changes (the new page arrived, or a link elsewhere changed it)
 * the select follows it. The element stays mounted across these navigations, so keyboard focus stays on it.
 */

export interface NavigateSelectOption {
  value: string;
  label: string;
  href: string;
}

export interface NavigateSelectProps {
  name: string;
  label: string;
  value: string;
  groups: readonly { label: string | null; options: readonly NavigateSelectOption[] }[];
  labelHidden?: boolean;
  /** Controls beside the select, inside the field (the previous / next period links). */
  before?: ReactNode;
  after?: ReactNode;
  className?: string;
}

export function NavigateSelect({ name, label, value, groups, labelHidden = false, before, after, className }: NavigateSelectProps) {
  const router = useRouter();
  const { start } = useReviewTransition();
  const [selected, setSelected] = useState(value);
  // The URL's value this select last followed: a new one from the server replaces the local choice.
  const [followed, setFollowed] = useState(value);
  if (value !== followed) {
    setFollowed(value);
    setSelected(value);
  }
  const options = groups.flatMap(group => group.options);

  const choose = (next: string) => {
    const option = options.find(item => item.value === next);
    if (!option || next === selected) return;
    setSelected(next);
    start(() => router.push(option.href, { scroll: false }));
  };

  const list = (items: readonly NavigateSelectOption[]) =>
    items.map(option => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ));

  const select = (control: FieldControlProps) => (
    <Select {...control} name={name} value={selected} onChange={event => choose(event.target.value)}>
      {groups.map(group =>
        group.label === null ? (
          // Only the first group is ungrouped (active accounts, or the listed periods).
          <Fragment key="ungrouped">{list(group.options)}</Fragment>
        ) : (
          <optgroup key={group.label} label={group.label}>
            {list(group.options)}
          </optgroup>
        ),
      )}
    </Select>
  );

  return (
    <Field label={label} labelHidden={labelHidden} className={className}>
      {control =>
        before || after ? (
          <div className="flex items-center gap-2">
            {before}
            <div className="min-w-0 flex-1">{select(control)}</div>
            {after}
          </div>
        ) : (
          select(control)
        )
      }
    </Field>
  );
}
