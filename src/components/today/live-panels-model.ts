/**
 * Which inline panels of Today's live trade cards are in view (docs/V2_ARCHITECTURE.md §14.1, §7.1). Pure, so the rules
 * are testable without a browser:
 *
 * - Add note and Paste screenshot are independent: opening one never hides the other.
 * - A panel stays mounted once opened ("kept") and is only hidden when closed, so a typed note or staged screenshots
 *   survive closing it, opening the other panel, or a refresh of the page.
 * - One capture panel is in view on the whole page: Ctrl/⌘+V and dropped files go to the open screenshot panel, so
 *   opening one on a card hides (and keeps) the one on any other card. A paste can never land on a trade that is not
 *   the one in front of the trader.
 */

export type LivePanel = "note" | "screenshot";

/** A request to move focus into a panel; each opening makes a new one. */
export interface PanelFocus {
  panel: LivePanel;
  key: number;
  /** The quick dock scrolls the whole card into view itself. */
  preventScroll: boolean;
}

export interface CardPanels {
  shown: Readonly<Record<LivePanel, boolean>>;
  kept: Readonly<Record<LivePanel, boolean>>;
  focus: PanelFocus | null;
}

export type LivePanelsState = Readonly<Record<string, CardPanels>>;

export const CLOSED_CARD: CardPanels = Object.freeze({
  shown: Object.freeze({ note: false, screenshot: false }),
  kept: Object.freeze({ note: false, screenshot: false }),
  focus: null,
});

export function cardPanels(state: LivePanelsState, tradeId: string): CardPanels {
  return state[tradeId] ?? CLOSED_CARD;
}

function withShown(card: CardPanels, panel: LivePanel, shown: boolean): CardPanels {
  return { ...card, shown: { ...card.shown, [panel]: shown } };
}

/** Opens `panel` on one card (mounting it if needed); a screenshot panel hides the screenshot panel of every other card. */
export function openPanel(state: LivePanelsState, tradeId: string, panel: LivePanel, focus: PanelFocus): LivePanelsState {
  const next: Record<string, CardPanels> = {};
  for (const [id, card] of Object.entries(state)) {
    next[id] = panel === "screenshot" && id !== tradeId && card.shown.screenshot ? withShown(card, "screenshot", false) : card;
  }
  const card = cardPanels(state, tradeId);
  next[tradeId] = { shown: { ...card.shown, [panel]: true }, kept: { ...card.kept, [panel]: true }, focus };
  return next;
}

/** Hides a panel; it stays mounted with whatever it holds. */
export function hidePanel(state: LivePanelsState, tradeId: string, panel: LivePanel): LivePanelsState {
  const card = state[tradeId];
  if (!card?.shown[panel]) return state;
  return { ...state, [tradeId]: withShown(card, panel, false) };
}

/** Whether any panel is in view (the phone dock steps aside for it). */
export function anyPanelShown(state: LivePanelsState): boolean {
  return Object.values(state).some(card => card.shown.note || card.shown.screenshot);
}
