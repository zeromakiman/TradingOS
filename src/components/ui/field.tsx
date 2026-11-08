import { CircleAlert } from "lucide-react";
import { type AriaAttributes, cloneElement, type ReactElement, type ReactNode, useId } from "react";
import { cx } from "./cx";

/** Accessibility wiring that a field hands to its control. */
export type FieldControlProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-required"?: boolean;
};

type ControlElement = ReactElement<{ id?: string } & Pick<AriaAttributes, "aria-describedby" | "aria-invalid" | "aria-required">>;

export type FieldProps = {
  label: ReactNode;
  /** Help text linked to the control with `aria-describedby`. */
  hint?: ReactNode;
  /** Error text; marks the control `aria-invalid` and links the message with `aria-describedby`. */
  error?: ReactNode;
  /** Shows a required marker and sets `aria-required` (native `required` stays the caller's choice). */
  required?: boolean;
  optional?: boolean;
  /** Control id; generated when omitted. */
  id?: string;
  labelHidden?: boolean;
  className?: string;
  /**
   * A single control element (Input, DecimalInput, Select, Textarea…) that receives the
   * wiring automatically, or a render function for custom structures.
   */
  children: ControlElement | ((control: FieldControlProps) => ReactNode);
};

const joinIds = (...ids: (string | undefined)[]) => ids.filter(Boolean).join(" ") || undefined;

export function Field({ label, hint, error, required = false, optional = false, id, labelHidden = false, className, children }: FieldProps) {
  const generatedId = useId();
  const controlId = id ?? `field${generatedId}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const control: FieldControlProps = {
    id: controlId,
    "aria-describedby": joinIds(hintId, errorId),
    "aria-invalid": error ? true : undefined,
    "aria-required": required || undefined,
  };
  const rendered =
    typeof children === "function"
      ? children(control)
      : cloneElement(children, { ...control, "aria-describedby": joinIds(children.props["aria-describedby"], control["aria-describedby"]) });

  return (
    <div className={cx("field", className)}>
      <label htmlFor={controlId} className={cx("field-label", labelHidden && "sr-only")}>
        {label}
        {required && (
          <span className="field-required" aria-hidden="true">
            *
          </span>
        )}
        {optional && <span className="field-optional">(optional)</span>}
      </label>
      {rendered}
      {hint && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="field-error">
          <CircleAlert aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
