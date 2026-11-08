"use server";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { logout } from "@/app/actions";
import { isValidTimeZone, type TimeDisplayMode } from "@/domain/time-display";
import {
  ACCOUNT_COOKIE, ALL_ACCOUNTS_VALUE, currentSession, DEVELOPER_COOKIE, deleteContextCookie, LAST_ACCOUNT_COOKIE, loadAccount, parseAccountValue,
  setContextCookie, THEME_COOKIE, type ThemePreference, TIME_COOKIE, TIME_ZONE_COOKIE,
} from "@/lib/account-context";
import { operationalFailure } from "@/lib/operational-log";
import { type ActionState, actionError, actionSuccess, FAILED_COPY, formFlag, formText } from "./state";

/**
 * Context and display preferences (docs/V2_ARCHITECTURE.md §6.6, §9.2, §13.1, §13.9). Cookies only: nothing is
 * written to the database, so these actions run without the schema gate. Each one re-renders the shell.
 *
 * Actions (§12.2 shape, also the shell's `*Action` props in src/components/shell/types.ts): setAccountContext (field
 * `account` = all | account id), setTheme (`theme`), setTimeDisplay (`mode` = strategy | local | utc, `zone` = the
 * browser's IANA zone, required for local), setDeveloperMode (`enabled` checkbox) and signOut (no fields).
 */

const THEMES: readonly ThemePreference[] = ["light", "dark", "system"];
const MODES: readonly TimeDisplayMode[] = ["strategy", "local", "utc"];

class PreferenceError extends Error {}

/** Stores the context; an account must be the user's and active (archived accounts are history only). */
async function storeAccountContext(raw: string | undefined): Promise<void> {
  const value = parseAccountValue(raw);
  if (value === null) throw new PreferenceError("Choose All Accounts or one of your trading accounts.");
  if (value !== ALL_ACCOUNTS_VALUE) {
    const { db, user } = await currentSession();
    const account = await loadAccount(db, user.id, value);
    if (account?.status !== "ACTIVE") throw new PreferenceError("That trading account isn't available.");
    await setContextCookie(LAST_ACCOUNT_COOKIE, value);
  }
  await setContextCookie(ACCOUNT_COOKIE, value);
  revalidatePath("/", "layout");
}

async function storeTheme(raw: string | undefined): Promise<void> {
  const theme = THEMES.find(option => option === raw);
  if (!theme) throw new PreferenceError("Choose light, dark or system.");
  await setContextCookie(THEME_COOKIE, theme);
  revalidatePath("/", "layout");
}

/** Local time needs the browser's IANA zone (captured client-side); strategy and UTC need none. */
async function storeTimeDisplay(rawMode: string | undefined, rawZone: string | undefined): Promise<void> {
  const mode = MODES.find(option => option === rawMode);
  if (!mode) throw new PreferenceError("Choose strategy time, local time or UTC.");
  if (mode === "local") {
    if (!isValidTimeZone(rawZone)) throw new PreferenceError("Your browser's time zone could not be read. Choose strategy time or UTC.");
    await setContextCookie(TIME_ZONE_COOKIE, rawZone);
  } else {
    await deleteContextCookie(TIME_ZONE_COOKIE);
  }
  await setContextCookie(TIME_COOKIE, mode);
  revalidatePath("/", "layout");
}

function failure(error: unknown): ActionState {
  unstable_rethrow(error);
  if (error instanceof PreferenceError) return actionError(error.message);
  operationalFailure("request_failed");
  return actionError(FAILED_COPY);
}

export async function setAccountContext(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    await storeAccountContext(formText(form, "account"));
    return actionSuccess();
  } catch (error) {
    return failure(error);
  }
}

export async function setTheme(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    await storeTheme(formText(form, "theme"));
    return actionSuccess();
  } catch (error) {
    return failure(error);
  }
}

export async function setTimeDisplay(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    await storeTimeDisplay(formText(form, "mode"), formText(form, "zone"));
    return actionSuccess();
  } catch (error) {
    return failure(error);
  }
}

export async function setDeveloperMode(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    if (formFlag(form, "enabled")) await setContextCookie(DEVELOPER_COOKIE, "1");
    else await deleteContextCookie(DEVELOPER_COOKIE);
    revalidatePath("/", "layout");
    return actionSuccess(formFlag(form, "enabled") ? "Technical details open by default." : "Technical details stay collapsed.");
  } catch (error) {
    return failure(error);
  }
}

/** Shell `signOutAction` in the §12.2 shape: the V1 sign-out (local session, auth cookies, redirect to /login). */
export async function signOut(_prev: ActionState, _form: FormData): Promise<ActionState> {
  await logout();
  return actionSuccess();
}
