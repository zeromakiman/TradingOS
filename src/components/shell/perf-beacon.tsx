"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Production timing as the person experiences it, reported once per page load and once per client-side navigation to
 * `/api/perf` (a `tos-perf-client` log line). A page load reports TTFB, first and largest contentful paint; a navigation
 * reports the time from the click to the new page committing, and how many router fetches (RSC requests), server
 * actions, refreshes and clicks it took, which tells a repeated click from a context-sync refresh or action. Only
 * timings, counts and the route (ids replaced by `:id`) are sent.
 */

const QUIET_MS = 3000;
const MAX_ENTRIES = 8;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

type Note = "refresh" | "persist";
const noted: Record<Note, number> = { refresh: 0, persist: 0 };

/** The shell's context sync refreshes the page or stores its context (a server action) on its own. */
export function notePerf(note: Note) {
  noted[note]++;
}

function route(pathname: string): string {
  return pathname.replace(UUID, ":id").slice(0, 96) || "/";
}

interface Report {
  type: "load" | "nav";
  route: string;
  navMs?: number;
  ttfbMs?: number;
  fcpMs?: number;
  lcpMs?: number;
  rsc: number;
  rscMs: number[];
  actions: number;
  clicks: number;
  refreshes: number;
  persists: number;
}

interface Pending {
  report: Report;
  clickAt: number | null;
  noted: Record<Note, number>;
  timer: ReturnType<typeof setTimeout> | null;
}

function send(report: Report) {
  if (process.env.NODE_ENV !== "production") {
    console.info("[tos-perf]", report);
    return;
  }
  try {
    navigator.sendBeacon("/api/perf", new Blob([JSON.stringify(report)], { type: "application/json" }));
  } catch {
    // Timing is best effort; a page never fails because of it.
  }
}

function start(type: Report["type"], pathname: string, clickAt: number | null): Pending {
  return { report: { type, route: route(pathname), rsc: 0, rscMs: [], actions: 0, clicks: clickAt === null ? 0 : 1, refreshes: 0, persists: 0 }, clickAt, noted: { ...noted }, timer: null };
}

export function PerfBeacon() {
  const pathname = usePathname() ?? "/";
  const pending = useRef<Pending | null>(null);
  const flush = useRef<() => void>(() => {});

  useEffect(() => {
    flush.current = () => {
      const current = pending.current;
      if (!current) return;
      pending.current = null;
      if (current.timer) clearTimeout(current.timer);
      current.report.refreshes = noted.refresh - current.noted.refresh;
      current.report.persists = noted.persist - current.noted.persist;
      send(current.report);
    };
    const quiet = () => {
      const current = pending.current;
      if (!current) return;
      if (current.timer) clearTimeout(current.timer);
      current.timer = setTimeout(() => flush.current(), QUIET_MS);
    };

    const load = start("load", location.pathname, null);
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (nav) load.report.ttfbMs = Math.round(nav.responseStart);
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    if (fcp) load.report.fcpMs = Math.round(fcp.startTime);
    pending.current = load;
    quiet();

    const observers: PerformanceObserver[] = [];
    const observe = (type: string, onEntry: (entry: PerformanceEntry) => void) => {
      try {
        const observer = new PerformanceObserver(list => list.getEntries().forEach(onEntry));
        observer.observe({ type, buffered: true });
        observers.push(observer);
      } catch {
        // Not supported by this browser.
      }
    };
    observe("paint", entry => {
      if (entry.name === "first-contentful-paint" && pending.current?.report.type === "load") pending.current.report.fcpMs = Math.round(entry.startTime);
    });
    observe("largest-contentful-paint", entry => {
      if (pending.current?.report.type === "load") pending.current.report.lcpMs = Math.round(entry.startTime);
    });
    observe("resource", entry => {
      const resource = entry as PerformanceResourceTiming;
      if (resource.initiatorType !== "fetch" || !pending.current) return;
      let url: URL;
      try {
        url = new URL(resource.name);
      } catch {
        return;
      }
      if (url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/_next/")) return;
      const report = pending.current.report;
      // Router fetches carry `_rsc`; a server action posts to the page's own URL without it.
      if (url.searchParams.has("_rsc") || url.pathname.endsWith(".rsc")) {
        report.rsc++;
        if (report.rscMs.length < MAX_ENTRIES) report.rscMs.push(Math.round(resource.duration));
      } else {
        report.actions++;
      }
      quiet();
    });

    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || link.origin !== location.origin) return;
      const target = route(link.pathname);
      const current = pending.current;
      if (current?.report.type === "nav" && current.report.route === target) {
        current.report.clicks++;
        quiet();
        return;
      }
      flush.current();
      pending.current = start("nav", link.pathname, performance.now());
      quiet();
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") flush.current();
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("visibilitychange", onHide);
      for (const observer of observers) observer.disconnect();
      flush.current();
    };
  }, []);

  // A committed navigation: the one the click started, or one without a click (back, palette, keyboard shortcut).
  useEffect(() => {
    const current = pending.current;
    const target = route(pathname);
    if (current?.report.type === "load" && current.report.route === target) return;
    if (current?.report.type === "nav" && current.report.route === target) {
      if (current.report.navMs === undefined && current.clickAt !== null) current.report.navMs = Math.round(performance.now() - current.clickAt);
      return;
    }
    flush.current();
    pending.current = start("nav", pathname, null);
    pending.current.timer = setTimeout(() => flush.current(), QUIET_MS);
  }, [pathname]);

  return null;
}
