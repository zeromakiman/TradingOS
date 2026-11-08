/**
 * DOM ids shared by Today's server components and its client actions (a client module's plain functions cannot be
 * called while a server component renders, so they live here).
 */

/** The card of one live trade (the quick dock scrolls it into view). */
export const liveCardId = (tradeId: string) => `live-trade-${tradeId}`;

/** The inline panels and the composer field of one live trade card. */
export const livePanelIds = (tradeId: string) => ({
  note: `live-note-${tradeId}`,
  screenshot: `live-screenshot-${tradeId}`,
  composer: `today-journal-${tradeId}`,
});

/** Heading of the Trading status card (focus lands here when the control that had it leaves with a resolved reason). */
export const STATUS_HEADING_ID = "today-status-title";

/** The account's name link in an All Accounts status row (the row's focus target after a resolved reason). */
export const accountRowHeadingId = (accountId: string) => `today-account-${accountId}`;

/** Trade id of a live card's element id, or null. */
export function tradeIdOfCard(elementId: string): string | null {
  const prefix = "live-trade-";
  return elementId.startsWith(prefix) ? elementId.slice(prefix.length) : null;
}
