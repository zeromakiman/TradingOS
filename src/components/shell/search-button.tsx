"use client";

import { Search } from "lucide-react";
import { cx } from "../ui/cx";
import { KbdCombo } from "../ui/kbd";
import { useShellState } from "./shell-state";
import { useModifierKeyLabel } from "./use-media-query";

/** Opens the command palette; shows the platform shortcut (⌘K or Ctrl K). */
export function SearchButton({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { setPaletteOpen } = useShellState();
  const modifier = useModifierKeyLabel();
  return (
    <button
      type="button"
      className={cx(compact ? "btn btn-ghost btn-icon" : "search-button", className)}
      onClick={() => setPaletteOpen(true)}
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+K Meta+K /"
      aria-label="Search trades, accounts and commands"
    >
      <Search aria-hidden="true" />
      {!compact && (
        <>
          <span className="max-xl:hidden">Search</span>
          <KbdCombo keys={[modifier, "K"]} className="max-xl:hidden" />
        </>
      )}
    </button>
  );
}
