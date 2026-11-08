"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { clockOffset } from "@/components/shell/session-labels";
import { cx } from "@/components/ui/cx";
import type { Session } from "@/domain/session";
import { type RibbonModel, type RibbonSegment, renderOutdated, ribbonModel } from "./ribbon-model";

/**
 * Session ribbon (docs/V2_ARCHITECTURE.md §14.1): the strategy day (fixed UTC−5) as a 24-hour track with its sessions,
 * the current one highlighted, Dead Pool shaded, a "now" marker and the next boundary with a countdown. It ticks from
 * the server's time (`nowIso`), so a skewed browser clock does not move it. When a session boundary or the strategy
 * midnight passes, the page is refreshed once: the trading status (Dead Pool, the day's usage) is then judged again on
 * the server instead of showing an answer that no longer holds.
 */

const TICK_MS = 10_000;
/** Segments shorter than this carry no inline label (their name is in the summary and the hover title). */
const LABEL_MINUTES = 180;

const SEGMENT_CLASS: Record<Session, string> = {
  ACTIVE_KILL_ZONE: "bg-pos-soft text-pos",
  DEAD_POOL:
    "bg-[repeating-linear-gradient(135deg,var(--warn-soft)_0_7px,color-mix(in_srgb,var(--warn-border)_50%,var(--warn-soft))_7px_9px)] text-warn",
  ASIA: "bg-surface-sunken text-3",
  JUDAS: "bg-surface-sunken text-3",
};

const CURRENT_RING: Record<Session, string> = {
  ACTIVE_KILL_ZONE: "ring-pos",
  DEAD_POOL: "ring-warn",
  ASIA: "ring-border-strong",
  JUDAS: "ring-border-strong",
};

const percent = (minutes: number) => `${(minutes / 1440) * 100}%`;

interface Tick {
  minute: number;
  label: string;
  /** Hidden on narrow screens, where it would collide with its neighbour. */
  wideOnly: boolean;
  hidden: boolean;
}

/** Boundary labels under the track, thinned so neighbours never overlap (5% apart on wide screens, 14% on phones). */
export function ribbonTicks(segments: readonly RibbonSegment[]): Tick[] {
  const minutes = [...segments.map(segment => ({ minute: segment.from, label: segment.fromLabel })), { minute: 1440, label: "24:00" }];
  let lastWide = Number.NEGATIVE_INFINITY;
  let lastNarrow = Number.NEGATIVE_INFINITY;
  return minutes.map((tick, index) => {
    const edge = index === 0 || index === minutes.length - 1;
    const gapWide = (tick.minute - lastWide) / 1440;
    const gapNarrow = (tick.minute - lastNarrow) / 1440;
    const hidden = !edge && gapWide < 0.05;
    const wideOnly = !edge && !hidden && gapNarrow < 0.14;
    if (!hidden) lastWide = tick.minute;
    if (!hidden && !wideOnly) lastNarrow = tick.minute;
    return { ...tick, hidden, wideOnly };
  });
}

function Track({ model }: { model: RibbonModel }) {
  const currentStart = model.segments.find(segment => segment.current)?.from ?? model.minute;
  return (
    <div className="relative">
      <div className="relative flex h-8 overflow-hidden rounded-control border border-border">
        {model.segments.map(segment => (
          <div
            key={`${segment.session}-${segment.from}`}
            title={`${segment.label} ${segment.fromLabel}–${segment.toLabel} UTC−5`}
            className={cx(
              "relative flex min-w-0 items-center justify-center border-l-2 border-surface px-1 text-xs first:border-l-0",
              SEGMENT_CLASS[segment.session],
              segment.current && `z-[1] font-semibold ring-2 ring-inset ${CURRENT_RING[segment.session]}`,
            )}
            style={{ width: percent(segment.to - segment.from) }}
          >
            {segment.to - segment.from >= LABEL_MINUTES && <span className="truncate">{segment.label}</span>}
          </div>
        ))}
        {/* Sessions that already ended are washed out; the current one keeps its colour and the marker shows progress. */}
        <div className="pointer-events-none absolute inset-y-0 left-0 z-[2] bg-surface/50" style={{ width: percent(currentStart) }} />
      </div>
      <div className="pointer-events-none absolute -inset-y-1 z-[3] w-0.5 -translate-x-1/2 rounded-full bg-text" style={{ left: percent(model.minute) }} />
    </div>
  );
}

function Ticks({ model }: { model: RibbonModel }) {
  const ticks = ribbonTicks(model.segments);
  return (
    <div className="relative mt-1 h-4 text-[0.6875rem] leading-4 text-3 num">
      {ticks.map((tick, index) => (
        <span
          key={tick.minute}
          className={cx(
            "absolute top-0 whitespace-nowrap",
            index === 0 ? "translate-x-0" : index === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2",
            tick.hidden && "hidden",
            tick.wideOnly && "max-sm:hidden",
          )}
          style={{ left: percent(tick.minute) }}
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
}

export function SessionRibbon({ nowIso }: { nowIso: string }) {
  const router = useRouter();
  const serverNow = Date.parse(nowIso);
  const [now, setNow] = useState(serverNow);
  const refreshedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!Number.isFinite(serverNow)) return;
    const offset = clockOffset(serverNow, Date.now());
    const tick = () => setNow(Date.now() + offset);
    tick();
    const timer = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(timer);
  }, [serverNow]);

  useEffect(() => {
    // Once per render of the page: the refreshed page brings a new `nowIso` and its own next boundary.
    if (refreshedFor.current === nowIso || !renderOutdated(nowIso, now)) return;
    refreshedFor.current = nowIso;
    router.refresh();
  }, [now, nowIso, router]);

  if (!Number.isFinite(now)) return null;
  const model = ribbonModel(now);
  return (
    <section aria-labelledby="today-sessions-title" className="card px-4 pt-3 pb-2 md:px-5">
      <h2 id="today-sessions-title" className="sr-only">
        Sessions today
      </h2>
      <p className="sr-only">{model.summary}</p>
      <div aria-hidden="true">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-1 num">{model.time}</span>
            <span className="text-3">UTC−5</span>
            <span className="session-label" data-session={model.session}>
              {model.sessionLabel}
            </span>
          </p>
          <p className="t-meta">
            Next: <span className="font-medium text-1">{model.next.label}</span> at <span className="num">{model.next.time}</span>
            {model.next.nextDay ? " tomorrow" : ""} · in <span className="num">{model.next.countdown}</span>
          </p>
        </div>
        <div className="mt-2.5">
          <Track model={model} />
          <Ticks model={model} />
        </div>
      </div>
    </section>
  );
}
