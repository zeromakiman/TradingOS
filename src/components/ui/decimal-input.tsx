"use client";

import { type ChangeEvent, type ComponentProps, type FocusEvent, useState } from "react";
import { cx } from "./cx";
import { normalizeDecimalInput } from "./decimal";
import { INPUT_TOUCH_TARGET, type InputAdornments, withAdornments } from "./input";

export type DecimalInputProps = Omit<ComponentProps<"input">, "type" | "inputMode" | "value" | "defaultValue"> &
  InputAdornments & {
    /** Controlled value: the exact decimal string. */
    value?: string;
    /** Uncontrolled initial value: the exact decimal string. */
    defaultValue?: string;
    /** Receives the normalised string (see `normalizeDecimalInput`) after every edit. */
    onValueChange?: (value: string) => void;
  };

/**
 * Text input for prices, quantities, percentages and money. The value stays a string end
 * to end (never a JavaScript number), and mobile keyboards show a decimal keypad.
 *
 * The field shows what the person types; a decimal comma turns into a point when the field
 * loses focus, because only the finished text shows whether "2,35" was heading for "2,350"
 * (thousands, left for validation to reject). `onValueChange` and the submitted form value
 * (a hidden input carrying `name`) always hold the normalised string, so a form submitted
 * straight from the keyboard never sends the comma.
 */
export function DecimalInput({
  name,
  form,
  disabled,
  value,
  defaultValue = "",
  onValueChange,
  onChange,
  onBlur,
  className,
  startAdornment,
  endAdornment,
  ...props
}: DecimalInputProps) {
  const [text, setText] = useState(value ?? defaultValue);
  const [shownValue, setShownValue] = useState(value);
  const normalized = normalizeDecimalInput(text);

  // A new controlled value that the visible text does not already mean (a prefill or a reset) replaces the text.
  if (value !== shownValue) {
    setShownValue(value);
    if (value !== undefined && value !== normalized) setText(value);
  }

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value.replace(/\s+/g, "");
    setText(next);
    onValueChange?.(normalizeDecimalInput(next));
    onChange?.(event);
  };

  const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
    if (normalized !== text) setText(normalized);
    onBlur?.(event);
  };

  return (
    <>
      {withAdornments(
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          className={cx("input input-numeric", INPUT_TOUCH_TARGET, className)}
          value={text}
          form={form}
          disabled={disabled}
          onChange={handleChange}
          onBlur={handleBlur}
          {...props}
        />,
        { startAdornment, endAdornment },
      )}
      {name !== undefined && <input type="hidden" name={name} value={normalized} form={form} disabled={disabled} />}
    </>
  );
}
