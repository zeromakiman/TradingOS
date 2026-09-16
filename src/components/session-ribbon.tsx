import { type Session, strategyClock } from "@/domain/session";

const order: Session[] = ["ASIA", "JUDAS", "ACTIVE_KILL_ZONE", "DEAD_POOL"];
const readable = (s: Session) => s.replaceAll("_", " ");

/**
 * Presentation only. Session boundaries are not defined here: every segment is
 * produced by calling the authoritative strategyClock at fifteen-minute marks
 * across the current strategy day, so the ribbon can never disagree with it.
 */
/** Fifteen-minute samples of the authoritative clock, collapsed into contiguous runs. */
export function sessionSegments(day: string) {
  const start = Date.parse(`${day}T05:00:00Z`), segments: { session: Session; from: number; span: number }[] = [];
  for (let i = 0; i < 96; i++) {
    const session = strategyClock(new Date(start + i * 900_000).toISOString()).session, last = segments.at(-1);
    if (last?.session === session) last.span += 1;
    else segments.push({ session, from: i, span: 1 });
  }
  return segments;
}

export function SessionRibbon({ now }: { now: string }) {
  const clock = strategyClock(now), segments = sessionSegments(clock.day);
  const [hours, minutes] = clock.time.split(":").map(Number), elapsed = hours * 60 + minutes;
  const upcoming = segments.find(s => s.from * 15 > elapsed) ?? segments[0];
  const mark = (index: number) => `${String(Math.floor((index * 15) / 60)).padStart(2, "0")}:${String((index * 15) % 60).padStart(2, "0")}`;
  const present = order.filter(s => segments.some(seg => seg.session === s));
  return <section className="session-ribbon" aria-label="Strategy clock sessions">
    <div className="ribbon-head">
      <span>STRATEGY CLOCK · FIXED UTC−5</span>
      <span>NOW <strong>{clock.time}</strong> · {readable(clock.session)} · NEXT <strong>{readable(upcoming.session)}</strong> AT {mark(upcoming.from)}</span>
    </div>
    <div className="ribbon-track">
      {segments.map(s => <span key={`${s.session}-${s.from}`} className={`ribbon-seg s-${s.session}`} style={{ width: `${(s.span / 96) * 100}%` }} title={`${readable(s.session)} from ${mark(s.from)}`}/>)}
      <span className="ribbon-now" style={{ left: `${(elapsed / 1440) * 100}%` }} aria-hidden="true"/>
    </div>
    <div className="ribbon-legend">{present.map(s => <span key={s}><i className={`ribbon-key ribbon-seg s-${s}`}/>{readable(s)}</span>)}</div>
  </section>;
}
