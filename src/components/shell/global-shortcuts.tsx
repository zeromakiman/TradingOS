"use client";

import { useShellState } from "./shell-state";
import { JOURNAL_COMPOSER_SELECTOR, LIVE_ACTION_ID, PLAN_ACTION_ID } from "./shortcuts";
import { useGlobalShortcuts } from "./use-global-shortcuts";

/** Activates a header control so the shortcut behaves exactly like a click (client-side navigation). */
function activate(id: string) {
  const element = document.getElementById(id);
  if (!element) return false;
  element.click();
  return undefined;
}

/** Registers the shell's keyboard shortcuts; renders nothing. */
export function GlobalShortcuts() {
  const { paletteOpen, setPaletteOpen, setHelpOpen, singleKeyShortcuts } = useShellState();
  useGlobalShortcuts(
    {
      palette: () => {
        setPaletteOpen(!paletteOpen);
        return undefined;
      },
      plan: () => activate(PLAN_ACTION_ID),
      live: () => activate(LIVE_ACTION_ID),
      journal: () => {
        const composer = document.querySelector<HTMLElement>(JOURNAL_COMPOSER_SELECTOR);
        if (!composer) return false;
        composer.focus();
        return undefined;
      },
      help: () => {
        setHelpOpen(true);
        return undefined;
      },
    },
    { singleKeys: singleKeyShortcuts },
  );
  return null;
}
