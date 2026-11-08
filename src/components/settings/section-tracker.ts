import type { SettingsSectionId } from "./settings-model";

/**
 * Which Settings section the reader is in, for the section list (settings-nav.tsx). Positions decide it: the current
 * section is the last one whose top has passed the reading line. The short last sections (Danger zone, Developer) can
 * never scroll up to that line, so over the last screen of scrolling the line moves down to the bottom of the viewport
 * and each of them becomes current in turn; at the very end of the page the last heading in view is current.
 *
 * A section named by the URL (`/settings#ai`, the AI fix route) is scrolled to on arrival. The page streams in behind
 * its loading state, so the browser's own fragment scroll (and the router's) has already given up by the time the
 * section exists. A section chosen in the list, or named by the URL, stays current while the browser scrolls to it;
 * the reader's next scroll decides again.
 */

/** A section's top edge relative to the viewport, in CSS pixels (negative once scrolled past). */
export interface SectionTop {
  id: SettingsSectionId;
  top: number;
}

export interface SectionLayout {
  /** Page order. */
  tops: readonly SectionTop[];
  viewportHeight: number;
  /** How far the page can still scroll down, in CSS pixels (0 at the end of the page). */
  remaining: number;
}

/**
 * A section navigated to is parked 128px (`scroll-mt-32`, phones) or 96px (`lg:scroll-mt-24`) below the viewport top.
 * The reading line sits just below both, so a parked section is the current one.
 */
export const READING_LINE_PX = 144;

/** How long a chosen section stays current while the browser scrolls to it. */
export const CHOICE_HOLD_MS = 700;

/**
 * The reading line for a layout: `READING_LINE_PX` from the top until the last screen of scrolling, then moving down
 * with every pixel scrolled until it reaches the bottom of the viewport at the end of the page.
 */
export function readingLine({ viewportHeight, remaining }: Pick<SectionLayout, "viewportHeight" | "remaining">): number {
  return Math.max(READING_LINE_PX, viewportHeight - Math.max(0, remaining));
}

export function currentSection(layout: SectionLayout): SettingsSectionId | null {
  const line = readingLine(layout);
  let current = layout.tops[0]?.id ?? null;
  for (const { id, top } of layout.tops) if (top <= line) current = id;
  return current;
}

/** `#ai` → `ai`; null for anything that isn't one of the sections. */
export function sectionFromHash(ids: readonly SettingsSectionId[], hash: string): SettingsSectionId | null {
  return ids.find(id => `#${id}` === hash) ?? null;
}

/** What the tracker needs from the browser; tests pass their own. */
export interface SectionEnvironment {
  /** The URL fragment, such as `#ai`. */
  hash(): string;
  layout(ids: readonly SettingsSectionId[]): SectionLayout;
  /** Scrolls the section's top to its scroll margin. */
  reveal(id: SettingsSectionId): void;
  now(): number;
  /** Runs `callback` before the next paint; returns a function that cancels it. */
  nextFrame(callback: () => void): () => void;
  /** Listens to a window event; returns a function that stops listening. */
  on(type: "scroll" | "resize" | "hashchange", listener: () => void): () => void;
}

export function browserEnvironment(): SectionEnvironment {
  return {
    hash: () => window.location.hash,
    layout(ids) {
      const tops: SectionTop[] = [];
      for (const id of ids) {
        const element = document.getElementById(id);
        if (element) tops.push({ id, top: element.getBoundingClientRect().top });
      }
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      // A page that doesn't scroll at all keeps the reading line at the top: its first section is current.
      return { tops, viewportHeight: window.innerHeight, remaining: scrollable > 1 ? scrollable - window.scrollY : Number.POSITIVE_INFINITY };
    },
    reveal(id) {
      document.getElementById(id)?.scrollIntoView({ block: "start" });
    },
    now: () => performance.now(),
    nextFrame(callback) {
      const frame = window.requestAnimationFrame(callback);
      return () => window.cancelAnimationFrame(frame);
    },
    on(type, listener) {
      window.addEventListener(type, listener, { passive: true });
      return () => window.removeEventListener(type, listener);
    },
  };
}

export interface SectionTracker {
  /** The reader chose a section in the list (the link itself scrolls there). */
  choose(id: SettingsSectionId): void;
  stop(): void;
}

/** Reports the current section through `onCurrent`, now and whenever it changes, until `stop()`. */
export function trackSections(
  ids: readonly SettingsSectionId[],
  onCurrent: (id: SettingsSectionId) => void,
  env: SectionEnvironment = browserEnvironment(),
): SectionTracker {
  let heldUntil = Number.NEGATIVE_INFINITY;
  let cancelUpdate: (() => void) | null = null;
  let cancelReveal: (() => void) | null = null;

  const choose = (id: SettingsSectionId) => {
    heldUntil = env.now() + CHOICE_HOLD_MS;
    onCurrent(id);
  };

  const update = () => {
    cancelUpdate = null;
    if (env.now() < heldUntil) return;
    const id = currentSection(env.layout(ids));
    if (id) onCurrent(id);
  };

  const scheduleUpdate = () => {
    cancelUpdate ??= env.nextFrame(update);
  };

  /** Brings the URL's section into view; false when the fragment names no section. */
  const followHash = (): boolean => {
    const id = sectionFromHash(ids, env.hash());
    if (!id) return false;
    choose(id);
    cancelReveal?.();
    cancelReveal = env.nextFrame(() => {
      cancelReveal = null;
      choose(id);
      env.reveal(id);
    });
    return true;
  };

  if (!followHash()) scheduleUpdate();
  const listeners = [env.on("scroll", scheduleUpdate), env.on("resize", scheduleUpdate), env.on("hashchange", followHash)];

  return {
    choose,
    stop() {
      for (const stopListening of listeners) stopListening();
      cancelUpdate?.();
      cancelReveal?.();
      cancelUpdate = null;
      cancelReveal = null;
    },
  };
}
