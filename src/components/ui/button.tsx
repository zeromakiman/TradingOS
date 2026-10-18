import { LoaderCircle } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";
import { Tooltip } from "./tooltip";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md" | "lg";

/** V1 names kept until the V1 screens that still pass them are rebuilt. */
type LegacyButtonVariant = "default" | "outline";

const variantClass: Record<ButtonVariant | LegacyButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  ghost: "btn-ghost",
  danger: "btn-danger",
  link: "btn-link",
  default: "btn-primary",
  outline: "btn-secondary",
};

const sizeClass: Record<ButtonSize, string> = { sm: "btn-sm", md: "", lg: "btn-lg" };

export type ButtonStyleOptions = {
  variant?: ButtonVariant | LegacyButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
  className?: string;
};

/** Class list for elements that should look like a button, such as a `<Link>` rendered by a server component. */
export function buttonClasses({ variant = "primary", size = "md", iconOnly = false, className }: ButtonStyleOptions = {}) {
  return cx("btn", variantClass[variant], sizeClass[size], iconOnly && "btn-icon", className);
}

export type ButtonProps = ComponentProps<"button"> &
  ButtonStyleOptions & {
    /** Renders the single child element (for example a `<Link>`) with button styling. */
    asChild?: boolean;
    /** Shows a spinner, sets `aria-busy` and disables the button until the work finishes. */
    loading?: boolean;
    /** Label shown while loading, for example "Saving…". Defaults to the normal label. */
    loadingText?: ReactNode;
    /** Leading icon; decorative icons should come from lucide-react (aria-hidden by default). */
    icon?: ReactNode;
    /** Trailing icon. */
    iconEnd?: ReactNode;
  };

export function Button({
  variant,
  size,
  iconOnly,
  className,
  asChild = false,
  loading = false,
  loadingText,
  icon,
  iconEnd,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const classes = buttonClasses({ variant, size, iconOnly, className });
  const leading = loading ? <LoaderCircle aria-hidden="true" className="spin" /> : icon;
  const label = loading && loadingText !== undefined ? loadingText : children;

  if (asChild) {
    return (
      <Slot.Root className={classes} aria-disabled={disabled || loading || undefined} aria-busy={loading || undefined} {...props}>
        {leading}
        <Slot.Slottable>{children}</Slot.Slottable>
        {iconEnd}
      </Slot.Root>
    );
  }

  return (
    <button className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {leading}
      {label}
      {iconEnd}
    </button>
  );
}

export type IconButtonProps = Omit<ButtonProps, "children" | "icon" | "iconEnd" | "iconOnly" | "loadingText" | "asChild"> & {
  /** Accessible name; also shown as a tooltip when `tooltip` is set. */
  label: string;
  icon: ReactNode;
  tooltip?: boolean;
};

export function IconButton({ label, icon, tooltip = false, variant = "ghost", ...props }: IconButtonProps) {
  const button = <Button aria-label={label} variant={variant} iconOnly icon={icon} {...props} />;
  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
}
