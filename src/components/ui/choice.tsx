import Link from "next/link";
import { type ChangeEvent, type ComponentProps, type ReactNode, useId } from "react";
import { cx } from "./cx";

const joinIds = (...ids: (string | undefined)[]) => ids.filter(Boolean).join(" ") || undefined;

export type CheckboxProps = Omit<ComponentProps<"input">, "type"> & {
  label: ReactNode;
  description?: ReactNode;
};

/** Native checkbox (form friendly, works without JavaScript) with a label and an optional description. */
export function Checkbox({ label, description, className, id, ...props }: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? `check${generatedId}`;
  const descriptionId = description ? `${inputId}-description` : undefined;
  return (
    <div className={cx("check-field", className)}>
      <label className="check" htmlFor={inputId}>
        <input
          id={inputId}
          type="checkbox"
          className="check-input"
          {...props}
          aria-describedby={joinIds(props["aria-describedby"], descriptionId)}
        />
        <span className="check-label">{label}</span>
      </label>
      {description && (
        <p id={descriptionId} className="check-description">
          {description}
        </p>
      )}
    </div>
  );
}

export type SwitchProps = CheckboxProps;

/** On/off setting rendered as a native checkbox with `role="switch"`. */
export function Switch({ label, description, className, id, ...props }: SwitchProps) {
  const generatedId = useId();
  const inputId = id ?? `switch${generatedId}`;
  const descriptionId = description ? `${inputId}-description` : undefined;
  return (
    <div className={cx("check-field switch-field", className)}>
      <label className="check" htmlFor={inputId}>
        <input
          id={inputId}
          type="checkbox"
          // biome-ignore lint/a11y/useAriaPropsForRole: a native checkbox exposes its checked state to the switch role; ARIA in HTML advises against adding aria-checked.
          role="switch"
          className="switch-input"
          {...props}
          aria-describedby={joinIds(props["aria-describedby"], descriptionId)}
        />
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
        <span className="check-label">{label}</span>
      </label>
      {description && (
        <p id={descriptionId} className="check-description">
          {description}
        </p>
      )}
    </div>
  );
}

export type ChoiceOption = {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
};

type RadioGroupProps = {
  /** Form field name; the checked option's value is submitted. */
  name: string;
  /** Group label (rendered as the fieldset legend). */
  legend: ReactNode;
  legendHidden?: boolean;
  options: ChoiceOption[];
  /** Controlled selection; requires `onValueChange` (client components only). */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  "aria-describedby"?: string;
};

function radioState(option: ChoiceOption, { value, defaultValue, onValueChange }: Pick<RadioGroupProps, "value" | "defaultValue" | "onValueChange">) {
  if (onValueChange) {
    return {
      checked: value === option.value,
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        if (event.target.checked) onValueChange(option.value);
      },
    };
  }
  return { defaultChecked: (value ?? defaultValue) === option.value };
}

function ChoiceFieldset({ legend, legendHidden, className, disabled, describedBy, children }: { legend: ReactNode; legendHidden?: boolean; className?: string; disabled?: boolean; describedBy?: string; children: ReactNode }) {
  return (
    <fieldset className={cx("choice-group", className)} disabled={disabled} aria-describedby={describedBy}>
      <legend className={cx("choice-legend", legendHidden && "sr-only")}>{legend}</legend>
      {children}
    </fieldset>
  );
}

/** Radio group shown as selectable cards with a title and an optional description. */
export function RadioCards({ name, legend, legendHidden, options, value, defaultValue, onValueChange, required, disabled, className, "aria-describedby": describedBy }: RadioGroupProps) {
  return (
    <ChoiceFieldset legend={legend} legendHidden={legendHidden} className={className} disabled={disabled} describedBy={describedBy}>
      <div className="radio-cards">
        {options.map((option) => (
          <label key={option.value} className="radio-card">
            <input type="radio" name={name} value={option.value} required={required} disabled={option.disabled} {...radioState(option, { value, defaultValue, onValueChange })} />
            <span>
              <span className="radio-card-title">{option.label}</span>
              {option.description && <span className="radio-card-description">{option.description}</span>}
            </span>
          </label>
        ))}
      </div>
    </ChoiceFieldset>
  );
}

/** Compact single choice such as Long/Short, built on native radios so it works in forms. */
export function SegmentedControl({ name, legend, legendHidden = true, options, value, defaultValue, onValueChange, required, disabled, className, size = "md", "aria-describedby": describedBy }: RadioGroupProps & { size?: "sm" | "md" }) {
  return (
    <ChoiceFieldset legend={legend} legendHidden={legendHidden} className={className} disabled={disabled} describedBy={describedBy}>
      <div className={cx("segmented", size === "sm" && "segmented-sm")}>
        {options.map((option) => (
          <label key={option.value} className="segmented-item">
            <input type="radio" name={name} value={option.value} required={required} disabled={option.disabled} {...radioState(option, { value, defaultValue, onValueChange })} />
            <span className="segmented-label">{option.label}</span>
          </label>
        ))}
      </div>
    </ChoiceFieldset>
  );
}

/** Single choice shown as chips, for presets such as risk percentages or journal entry kinds. */
export function ChoiceChips({ name, legend, legendHidden, options, value, defaultValue, onValueChange, required, disabled, className, "aria-describedby": describedBy }: RadioGroupProps) {
  return (
    <ChoiceFieldset legend={legend} legendHidden={legendHidden} className={className} disabled={disabled} describedBy={describedBy}>
      <div className="filter-chips">
        {options.map((option) => (
          <label key={option.value} className="chip-toggle">
            <input className="sr-only" type="radio" name={name} value={option.value} required={required} disabled={option.disabled} {...radioState(option, { value, defaultValue, onValueChange })} />
            {option.label}
          </label>
        ))}
      </div>
    </ChoiceFieldset>
  );
}

export type SegmentedLink = { href: string; label: ReactNode; current?: boolean };

/** Segmented switch whose options are links (URL state), for example the calendar mode. */
export function SegmentedLinks({ label, items, size = "md", className }: { label: string; items: SegmentedLink[]; size?: "sm" | "md"; className?: string }) {
  return (
    <nav aria-label={label} className={cx("segmented", size === "sm" && "segmented-sm", className)}>
      {items.map((item) => (
        <Link key={item.href} href={item.href} className="segmented-label" aria-current={item.current ? "true" : undefined} scroll={false}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
