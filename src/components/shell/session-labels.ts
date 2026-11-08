import type { Session } from "@/domain/session";

/**
 * Wording and countdown helpers for the strategy clock. Session boundaries themselves come from
 * `nextBoundary` in src/domain/session.ts, the single (parity-tested) source the Today session
 * ribbon uses too.
 */

/** Trader wording for strategy sessions (§15); never show the raw enum. */
export const SESSION_LABELS: Record<Session, string> = {
  ASIA: "Asia",
  JUDAS: "Judas",
  ACTIVE_KILL_ZONE: "Kill zone",
  DEAD_POOL: "Dead Pool",
};

const MINUTE = 60_000;

/** Whole minutes from `now` until `at`, rounded up (a boundary 30 seconds away is "1 minute"). */
export function minutesUntil(at: number, now: number) {
  return Math.max(0, Math.ceil((at - now) / MINUTE));
}

/**
 * Milliseconds to add to the browser clock so the strategy clock follows the server. A
 * browser up to `tolerance` after the server's render time only shows the page-load delay
 * and is trusted as is; a browser behind the server, or further ahead, is skewed and is
 * corrected to the server's time.
 */
export function clockOffset(serverNow: number, browserNow: number, tolerance = MINUTE) {
  const lag = browserNow - serverNow;
  return lag >= 0 && lag <= tolerance ? 0 : serverNow - browserNow;
}

/** "2h 18m", "45m", "1m". */
export function formatMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
