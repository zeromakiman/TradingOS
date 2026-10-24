import Decimal from "decimal.js";
import type { ReactNode } from "react";
import type { Known } from "@/domain/account-metrics";
import { formatMoney, formatR, formatSignedMoney } from "@/domain/format";
import { cx } from "@/components/ui/cx";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Value atoms of the Accounts screens. Exact decimal strings are formatted only through src/domain/format; profit and
 * loss carry a sign and colour (§13.1), and a value that is not deterministically known shows "—" with its reason.
 */

const D = Decimal.clone({ precision: 100 });

export type Sign = "pos" | "neg" | "zero";

export function signOf(value: string): Sign {
  const number = new D(value);
  return number.isZero() ? "zero" : number.isNegative() ? "neg" : "pos";
}

const signClass: Record<Sign, string | undefined> = { pos: "value-pos", neg: "value-neg", zero: undefined };

/** `+$120.00` in profit colour, `-$50.00` in loss colour, `$0.00` neutral. */
export function SignedMoney({ value, currency, className }: { value: string; currency: string; className?: string }) {
  return <span className={cx("num", signClass[signOf(value)], className)}>{formatSignedMoney(value, currency)}</span>;
}

/** `+1.20R` / `-1.00R` with the matching colour. */
export function RValue({ value, className }: { value: string; className?: string }) {
  return <span className={cx("num", signClass[signOf(value)], className)}>{formatR(value)}</span>;
}

/** "—" with the reason on hover and focus; the reason is also its accessible name. */
export function UnknownValue({ reason, className }: { reason: string; className?: string }) {
  return (
    <Tooltip content={reason}>
      <button type="button" className={cx("cursor-help rounded-control px-0.5 text-text-3 underline decoration-dotted underline-offset-4", HIT_AREA, className)} aria-label={`Not known. ${reason}`}>
        —
      </button>
    </Tooltip>
  );
}

/** A known value rendered by `render`, else "—" with the reason. */
export function KnownValue<T>({ known, render }: { known: Known<T>; render: (value: T) => ReactNode }) {
  return known.unknownReason !== null ? <UnknownValue reason={known.unknownReason} /> : render(known.value);
}

export function Money({ value, currency, className }: { value: string; currency: string; className?: string }) {
  return <span className={cx("num", className)}>{formatMoney(value, currency)}</span>;
}

/**
 * Hit areas (§13.5): standalone text links get a 40px (44px on touch) target; links inside running text keep their
 * line height and extend the target with an invisible pseudo-element instead.
 */
/** Card-header links: the negative margin keeps the header height while the target is 40px. */
export const TEXT_LINK = "-my-2.5 inline-flex min-h-10 items-center text-sm font-medium text-accent hover:underline pointer-coarse:min-h-11";
export const HIT_AREA = "relative after:absolute after:-inset-x-1 after:-inset-y-3 after:content-['']";

/**
 * Stat grids: two columns on phones (a single auto-fit column wastes the screen), more from tablet width; values step
 * down one size on phones so amounts such as $109,327.65 fit a half-width column.
 */
export const STAT_GRID_4 = "grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-4 md:gap-x-6 [&_.stat-value]:text-xl md:[&_.stat-value]:text-2xl";
export const STAT_GRID_5 = "grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-3 md:gap-x-6 xl:grid-cols-5 [&_.stat-value]:text-xl md:[&_.stat-value]:text-2xl";

/** Exact sum of decimal strings (display aggregation; never through floating point). */
export function sumDecimals(values: readonly string[]): string {
  return values.reduce((total, value) => total.plus(value), new D(0)).toFixed();
}
