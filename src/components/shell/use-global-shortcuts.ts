"use client";

import { useEffect, useRef } from "react";
import { type ShortcutAction, shortcutFor } from "./shortcuts";

/** Return `false` when the shortcut does not apply here, so the key press is left alone. */
export type ShortcutHandlers = Partial<Record<ShortcutAction, () => boolean | undefined>>;

const OPEN_LAYER = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]';

/**
 * Global shortcuts (§13.4): Ctrl/⌘+K and "/" (palette), P (Plan Trade), L (Record Live
 * Trade), J (journal composer), ? (shortcut help). Single keys apply only while `singleKeys`
 * is on, and are ignored while typing and while a dialog or menu is open; Ctrl/⌘+K always
 * works and also closes the open palette.
 */
export function useGlobalShortcuts(handlers: ShortcutHandlers, { singleKeys }: { singleKeys: boolean }) {
  const latest = useRef({ handlers, singleKeys });

  useEffect(() => {
    latest.current = { handlers, singleKeys };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const paletteOpen = document.querySelector("[data-command-palette]") !== null;
      const layerOpen = document.querySelector(OPEN_LAYER) !== null;
      const action = shortcutFor(event, { dialogOpen: layerOpen, singleKeys: latest.current.singleKeys });
      if (!action) return;
      if (action === "palette" && layerOpen && !paletteOpen) return;
      const handler = latest.current.handlers[action];
      if (!handler || handler() === false) return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
