import { type Session, strategyClock } from "@/domain/session";

const DAY_MINUTES = 1440;
const order: Session[] = ["ASIA", "JUDAS", "ACTIVE_KILL_ZONE", "DEAD_POOL"];
const readable = (s: Session) => s.replaceAll("_", " ");

/**
 * Presentation only. Session boundaries are not defined here: every segment is
 * produced by calling the authoritative strategyClock minute by minute across
 * the strategy day, so the ribbon cannot disagree with it.
 */
export function sessionSegments(day: string) {
  const start = Date.parse(`${day}T05:00:00Z`), segments: { session: Session; from: number; span: number }[] = [];
  for (let minute = 0; minute < DAY_MINUTES; minute++) {
    const session = strategyClock(new Date(start + minute * 60_000)).session, last = segments.at(-1);
    if (last?.session === session) last.span += 1;
    else segments.push({ session, from: minute, span: 1 });
  }
  return segments;
}

/**
 * The next instant at which the authoritative clock reports a different session,
 * found by scanning forward from the current instant — including across the
 * UTC−5 date boundary, where the final ASIA segment continues into the next day.
 */
export function nextTransition(now: string | Date) {
  const current = strategyClock(now), from = new Date(now).getTime();
  for (let minute = 1; minute <= 2 * DAY_MINUTES; minute++) {
    const clock = strategyClock(new Date(from + minute * 60_000));
    if (clock.session !== current.session) return clock;
  }
  return null;
}

const clockMark = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

export function SessionRibbon({ now }: { now: string }) {
  const clock = strategyClock(now), segments = sessionSegments(clock.day), next = nextTransition(now);
  const [hours, minutes] = clock.time.split(":").map(Number), elapsed = hours * 60 + minutes;
  const present = order.filter(s => segments.some(segment => segment.session === s));
  return <section className="session-ribbon" aria-label="Strategy clock sessions">
    <div className="ribbon-head">
      <span>STRATEGY CLOCK · FIXED UTC−5</span>
      <span>NOW <strong>{clock.time}</strong> · {readable(clock.session)}{next && <> · NEXT <strong>{readable(next.session)}</strong> AT {next.time}{next.day !== clock.day && ` · ${next.day}`}</>}</span>
    </div>
    <div className="ribbon-track">
      {segments.map(s => <span key={`${s.session}-${s.from}`} className={`ribbon-seg s-${s.session}`} style={{ width: `${(s.span / DAY_MINUTES) * 100}%` }} title={`${readable(s.session)} from ${clockMark(s.from)}`}/>)}
      <span className="ribbon-now" style={{ left: `${(elapsed / DAY_MINUTES) * 100}%` }} aria-hidden="true"/>
    </div>
    <div className="ribbon-legend">{present.map(s => <span key={s}><i className={`ribbon-key ribbon-seg s-${s}`}/>{readable(s)}</span>)}</div>
  </section>;
}
