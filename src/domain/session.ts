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
