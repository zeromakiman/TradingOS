import { X } from "lucide-react";
import Link from "next/link";
import { cx } from "./cx";

export type FilterChip = {
  key: string;
  /** Human wording of the active filter, for example "Model: OTE". */
  label: string;
  /** URL with this filter removed. */
  removeHref: string;
};

export type FilterChipsProps = {
  chips: FilterChip[];
  /** URL with every filter removed. */
  clearHref?: string;
  clearLabel?: string;
  label?: string;
  className?: string;
};

/** Active filters as removable chips (URL state, works without JavaScript). */
export function FilterChips({ chips, clearHref, clearLabel = "Clear all", label = "Active filters", className }: FilterChipsProps) {
  if (chips.length === 0) return null;
  return (
    <div className={cx("filter-chips", className)}>
      <ul className="filter-chip-list" aria-label={label}>
        {chips.map((chip) => (
          <li key={chip.key} className="chip">
            <span>{chip.label}</span>
            <Link href={chip.removeHref} className="chip-remove" aria-label={`Remove filter: ${chip.label}`} scroll={false}>
              <X aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
      {clearHref && chips.length > 1 && (
        <Link href={clearHref} className="btn btn-link" scroll={false}>
          {clearLabel}
        </Link>
      )}
    </div>
  );
}
