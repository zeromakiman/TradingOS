export type Session = "ASIA" | "JUDAS" | "ACTIVE_KILL_ZONE" | "DEAD_POOL";
export function strategyClock(instant: string | Date) {
  if (typeof instant === "string" && !/(Z|[+-]\d{2}:\d{2})$/.test(instant)) throw new Error("An explicit timezone is required.");
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid timestamp.");
  const shifted = new Date(date.getTime() - 300 * 60_000);
  const minute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const session: Session = minute >= 1080 || minute < 60 ? "ASIA" : minute < 120 ? "JUDAS" : minute < 720 ? "ACTIVE_KILL_ZONE" : "DEAD_POOL";
  return { day: shifted.toISOString().slice(0, 10), time: shifted.toISOString().slice(11, 16), session };
}

export interface SessionBoundary {
  /** The first instant of the next session, ISO 8601 UTC with milliseconds (`2026-09-04T17:00:00.000Z`). */
  at: string;
  /** The session that starts at `at`. */
  session: Session;
  /** Strategy-clock (fixed UTC−5) time of the boundary, `HH:MM`. */
  time: string;
  /** Strategy day of the boundary, `YYYY-MM-DD`. */
  day: string;
}

const MINUTE_MS = 60_000;
const DAY_MS = 1440 * MINUTE_MS;
const OFFSET_MS = 300 * MINUTE_MS;
/** Minutes after midnight UTC−5 at which a session starts, in day order (the same cut-offs as strategyClock). */
const SESSION_STARTS: readonly (readonly [minute: number, session: Session])[] = [
  [60, "JUDAS"], [120, "ACTIVE_KILL_ZONE"], [720, "DEAD_POOL"], [1080, "ASIA"],
];

/**
 * The next session boundary strictly after `instant`, exactly (pure offset arithmetic on the fixed
 * UTC−5 clock, no DST): the instant at which strategyClock first reports a different session, and
 * that session. An instant exactly on a boundary already belongs to the new session, so the following
 * boundary is returned. The UTC−5 midnight is not a boundary (Asia runs from 18:00 to 01:00).
 * Accepts the same input as strategyClock (strings need an explicit zone).
 */
export function nextBoundary(instant: string | Date): SessionBoundary {
  if (typeof instant === "string" && !/(Z|[+-]\d{2}:\d{2})$/.test(instant)) throw new Error("An explicit timezone is required.");
  const ms = new Date(instant).getTime();
  if (!Number.isFinite(ms)) throw new Error("Invalid timestamp.");
  const shifted = ms - OFFSET_MS;
  const midnight = Math.floor(shifted / DAY_MS) * DAY_MS;
  const start = SESSION_STARTS.find(([minute]) => midnight + minute * MINUTE_MS > shifted);
  const [minute, session] = start ?? SESSION_STARTS[0];
  const boundary = start ? midnight + minute * MINUTE_MS : midnight + DAY_MS + minute * MINUTE_MS;
  const wall = new Date(boundary).toISOString();
  return { at: new Date(boundary + OFFSET_MS).toISOString(), session, time: wall.slice(11, 16), day: wall.slice(0, 10) };
}
