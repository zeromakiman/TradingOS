"use client";

import { useEffect, useRef, useState } from "react";
import { cx } from "../ui/cx";
import { type SectionTracker, trackSections } from "./section-tracker";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./settings-model";

const SECTION_IDS: readonly SettingsSectionId[] = Object.freeze(SETTINGS_SECTIONS.map(section => section.id));

/**
 * Section navigation of Settings: a sticky list beside the sections on wide screens and a scrollable row of anchors
 * on phones. The section in view is marked `aria-current="location"` (section-tracker.ts). Links are plain anchors, so
 * the list works without JavaScript; `/settings#ai` lands on the AI section even though the page streams in after the
 * browser's own fragment scroll. The sections are the module's own list: server re-renders (after saving a form) must
 * not restart tracking, which would scroll the page back to the URL's section.
 */
export function SettingsNav() {
  const [current, setCurrent] = useState<SettingsSectionId>(SECTION_IDS[0]);
  const list = useRef<HTMLUListElement>(null);
  const tracker = useRef<SectionTracker | null>(null);

  // Phones: keep the current section's link inside the scrollable row (horizontal scroll only, never the page).
  useEffect(() => {
    const row = list.current;
    const link = row?.querySelector<HTMLElement>(`a[href="#${current}"]`);
    if (!row || !link || row.scrollWidth <= row.clientWidth) return;
    const left = link.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft || left + link.offsetWidth > row.scrollLeft + row.clientWidth - 40) row.scrollTo({ left: Math.max(0, left - 16), behavior: "smooth" });
  }, [current]);

  useEffect(() => {
    const active = trackSections(SECTION_IDS, setCurrent);
    tracker.current = active;
    return () => {
      active.stop();
      tracker.current = null;
    };
  }, []);

  const choose = (id: SettingsSectionId) => {
    if (tracker.current) tracker.current.choose(id);
    else setCurrent(id);
  };

  return (
    <nav aria-label="Settings sections" className="min-w-0">
      <ul ref={list} className="flex gap-1 overflow-x-auto pr-8 [scrollbar-width:none] max-lg:[mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] lg:flex-col lg:overflow-visible lg:pr-0">
        {SETTINGS_SECTIONS.map(section => {
          const active = section.id === current;
          return (
            <li key={section.id} className="flex-none">
              <a
                href={`#${section.id}`}
                aria-current={active ? "location" : undefined}
                onClick={() => choose(section.id)}
                className={cx(
                  "flex min-h-10 items-center whitespace-nowrap rounded-[var(--radius-control)] px-3 text-sm font-medium no-underline pointer-coarse:min-h-11",
                  // One set per state: `cx` doesn't merge utilities, so competing hover colours would be decided by CSS order.
                  active ? "bg-accent-soft text-accent" : section.id === "danger" ? "text-neg hover:bg-surface-sunken" : "text-2 hover:bg-surface-sunken hover:text-text",
                )}
              >
                {section.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
