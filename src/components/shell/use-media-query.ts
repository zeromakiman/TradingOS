"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Live `matchMedia` result; `serverValue` is used for the server render and hydration. */
export function useMediaQuery(query: string, serverValue: boolean) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}

const subscribeNever = () => () => undefined;

/** "⌘" on Apple platforms, "Ctrl" elsewhere (and during the server render). */
export function useModifierKeyLabel() {
  return useSyncExternalStore(
    subscribeNever,
    () => (/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘" : "Ctrl"),
    () => "Ctrl",
  );
}
