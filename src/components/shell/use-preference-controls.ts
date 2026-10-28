"use client";

import { useState, useTransition } from "react";
import { clearFormAutosaves } from "../trade/forms/autosave";
import { useOptionalToast } from "../ui/toast";
import { type ActionFields, type CallableAction, persistChoice, themeFields, timeDisplayFields } from "./actions";
import { clearPaletteHistory } from "./palette-history";
import { isThemePreference, isTimeDisplayMode } from "./preference-options";
import { applyTheme, browserTimeZone } from "./preferences";
import type { SetThemeAction, SetTimeDisplayAction, SignOutAction, ThemePreference, TimeDisplay, TimeDisplayMode } from "./types";

/** Local, optimistic copy of a server-provided value that follows new server values. */
function useServerSyncedState<T>(serverValue: T) {
  const [value, setValue] = useState(serverValue);
  const [received, setReceived] = useState(serverValue);
  if (received !== serverValue) {
    setReceived(serverValue);
    setValue(serverValue);
  }
  return [value, setValue] as const;
}

type FailureCopy = { title: string; description: string };

/**
 * Persists a choice with a server action in a transition. A failure, whether the action returns
 * an error state or throws, runs `revert` and shows a toast (when the shell's toast stack is
 * available) with the action's own message, instead of reaching an error boundary.
 */
function usePersistence() {
  const [, startTransition] = useTransition();
  const toasts = useOptionalToast();
  return (action: CallableAction, fields: ActionFields, failure: FailureCopy, revert?: () => void) => {
    startTransition(async () => {
      await persistChoice(action, fields, {
        revert,
        notify: (message) => toasts?.toast({ tone: "negative", title: failure.title, description: message ?? failure.description }),
      });
    });
  };
}

/** Theme choice applied to the document at once and persisted by the server action. */
export function useThemeChoice(theme: ThemePreference, setThemeAction?: SetThemeAction) {
  const [current, setCurrent] = useServerSyncedState(theme);
  const persist = usePersistence();
  const change = (value: string) => {
    if (!isThemePreference(value)) return;
    setCurrent(value);
    applyTheme(value);
    // A failed save keeps the theme for this page view; the toast says it was not stored.
    if (!setThemeAction) return;
    persist(setThemeAction, themeFields(value), {
      title: "Theme not saved",
      description: "It applies until you reload the page. Try again in a moment.",
    });
  };
  return [current, change] as const;
}

/**
 * Time display choice persisted by the server action, which receives the browser's zone for
 * "Local time"; times re-render on the server. A failed save restores the previous choice.
 */
export function useTimeDisplayChoice(mode: TimeDisplayMode, setTimeDisplayAction?: SetTimeDisplayAction) {
  const [current, setCurrent] = useServerSyncedState(mode);
  const persist = usePersistence();
  const change = (value: string) => {
    if (!isTimeDisplayMode(value) || !setTimeDisplayAction) return;
    const previous = current;
    setCurrent(value);
    persist(
      setTimeDisplayAction,
      timeDisplayFields(value, browserTimeZone()),
      { title: "Time display not changed", description: "Try again in a moment." },
      () => setCurrent(previous),
    );
  };
  return [current, change] as const;
}

/**
 * Signs out with the server action, which redirects to the login page; a failure is reported with a toast. First this
 * browser forgets what belongs to the person: the palette's recent entries and the unsaved Plan Trade, Record Live
 * Trade and Edit Draft entries kept in this tab, so the next person on a shared browser never finds them.
 */
export function useSignOut(signOutAction: SignOutAction | undefined) {
  const persist = usePersistence();
  if (!signOutAction) return undefined;
  return () => {
    clearPaletteHistory();
    clearFormAutosaves();
    persist(signOutAction, {}, { title: "Sign-out did not finish", description: "Try again in a moment." });
  };
}

export type PreferenceControlsInput = {
  theme: ThemePreference;
  timeDisplay: TimeDisplay;
  setThemeAction?: SetThemeAction;
  setTimeDisplayAction?: SetTimeDisplayAction;
};

export function usePreferenceControls({ theme, timeDisplay, setThemeAction, setTimeDisplayAction }: PreferenceControlsInput) {
  const [currentTheme, changeTheme] = useThemeChoice(theme, setThemeAction);
  const [timeMode, changeTimeMode] = useTimeDisplayChoice(timeDisplay.mode, setTimeDisplayAction);
  return { theme: currentTheme, changeTheme, timeMode, changeTimeMode, canChangeTimeDisplay: setTimeDisplayAction !== undefined };
}
