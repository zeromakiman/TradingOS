"use client";

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

/**
 * Screenshots chosen for an AI request (docs/V2_ARCHITECTURE.md §7.5, §11.3), shared by the gallery
 * (checkbox overlay, "Selected for AI") and the AI panels that send the request.
 *
 * Selection keys are the raw evidence ids, for V2 evidence and legacy screenshots alike. Both kinds are
 * random UUIDs, so they never collide, and the AI actions (`src/app/actions/ai.ts`) accept exactly these
 * ids in their repeated `evidence` field and resolve the kind on the server. Pass `selected` as is:
 * `for (const id of selected) form.append("evidence", id)`. The order is the order of selection.
 */

export interface EvidenceSelection {
  /** Selected evidence ids, in the order they were chosen (at most `max`). */
  selected: string[];
  /** Selects an unselected id (ignored when `max` is reached) or deselects a selected one. */
  toggle(id: string): void;
  clear(): void;
  /** Per-operation maximum (3 for Analyze setup and Challenge my bias, 4 for a trade review). */
  max: number;
  isSelected(id: string): boolean;
  /** Deselects an id if it is selected (for example after the screenshot was removed). */
  deselect(id: string): void;
}

/** The selection after toggling `id`: deselects it, or appends it while fewer than `max` are selected. */
export function toggleSelection(current: readonly string[], id: string, max: number): string[] {
  const limit = Math.max(0, Math.floor(max));
  const kept = current.slice(0, limit);
  if (kept.includes(id)) return kept.filter(value => value !== id);
  return kept.length < limit ? [...kept, id] : kept;
}

const SelectionContext = createContext<EvidenceSelection | null>(null);

export interface EvidenceSelectionProviderProps {
  max: number;
  /** Ids selected on mount, for example the screenshots of the last request (trimmed to `max`). */
  initialSelected?: readonly string[];
  children: ReactNode;
}

export function EvidenceSelectionProvider({ max, initialSelected = [], children }: EvidenceSelectionProviderProps) {
  const limit = Math.max(0, Math.floor(max));
  const [chosen, setChosen] = useState<string[]>(() => [...new Set(initialSelected)]);
  const selected = useMemo(() => chosen.slice(0, limit), [chosen, limit]);

  const toggle = useCallback((id: string) => setChosen(current => toggleSelection(current, id, limit)), [limit]);
  const clear = useCallback(() => setChosen([]), []);
  const deselect = useCallback((id: string) => setChosen(current => (current.includes(id) ? current.filter(value => value !== id) : current)), []);

  const value = useMemo<EvidenceSelection>(
    () => ({ selected, toggle, clear, max: limit, isSelected: id => selected.includes(id), deselect }),
    [selected, toggle, clear, limit, deselect],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

/** The shared selection; throws outside `<EvidenceSelectionProvider>`, which every AI panel needs. */
export function useEvidenceSelection(): EvidenceSelection {
  const selection = useContext(SelectionContext);
  if (!selection) throw new Error("useEvidenceSelection must be used inside <EvidenceSelectionProvider>.");
  return selection;
}

/** Like `useEvidenceSelection`, but null outside a provider (the gallery renders without selection then). */
export function useOptionalEvidenceSelection(): EvidenceSelection | null {
  return useContext(SelectionContext);
}
