import { ChevronDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

export type InputAdornments = {
  /** Short unit or prefix shown inside the field, for example "$". */
  startAdornment?: ReactNode;
  /** Short unit or suffix shown inside the field, for example "%" or "lots". */
  endAdornment?: ReactNode;
};

/** Wraps a control with optional start/end adornments. */
export function withAdornments(control: ReactNode, { startAdornment, endAdornment }: InputAdornments) {
  if (!startAdornment && !endAdornment) return control;
  return (
    <div className="input-group">
      {startAdornment && <span className="input-adornment input-adornment-start">{startAdornment}</span>}
      {control}
      {endAdornment && <span className="input-adornment input-adornment-end">{endAdornment}</span>}
    </div>
  );
}

/** Fields are 44px tall on touch screens (§13.5) and keep the 40px desktop density elsewhere. */
export const INPUT_TOUCH_TARGET = "pointer-coarse:min-h-11";

export type InputProps = ComponentProps<"input"> & InputAdornments;

export function Input({ className, startAdornment, endAdornment, ...props }: InputProps) {
  return withAdornments(<input className={cx("input", INPUT_TOUCH_TARGET, className)} {...props} />, { startAdornment, endAdornment });
}

/** Native select (works without JavaScript and inside forms) with the design-system chrome. */
export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <div className="select-wrap">
      <select className={cx("input", INPUT_TOUCH_TARGET, className)} {...props}>
        {children}
      </select>
      <ChevronDown aria-hidden="true" className="select-chevron" />
    </div>
  );
}
