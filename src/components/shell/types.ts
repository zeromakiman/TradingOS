/** Props contract between the authenticated layout (data) and the presentational shell. */

import type { TimeDisplay, TimeDisplayMode } from "@/domain/time-display";
import type { ActionResult } from "../ui/action-result";

/** The domain's time display (§12.1): strategy UTC−5, local (with the browser's IANA zone) or UTC. */
export type { TimeDisplay, TimeDisplayMode };

export type ThemePreference = "light" | "dark" | "system";

export type TradingAccountType = "DEMO" | "EVALUATION" | "FUNDED" | "PERSONAL" | "OTHER";

export type TradingAccountStatus = "ACTIVE" | "ARCHIVED";

/** A trading account as the shell shows it (latest profile revision). */
export type ShellAccount = {
  id: string;
  name: string;
  currency: string;
  status: TradingAccountStatus;
  type: TradingAccountType;
};

/** The selected context: All Accounts is an aggregation context, never a record (§9.1). */
export type AccountContextSelection = { mode: "all" } | { mode: "account"; accountId: string };

/** A trade in the command palette index. Labels arrive pre-formatted; `id` is only used in links. */
export type PaletteTrade = {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT" | null;
  accountName: string;
  /** Date in the user's time display, for example "Oct 14". */
  dateLabel: string;
  /** User-facing state, for example "Live" or "Closed · review pending". */
  stateLabel: string;
  tags: string[];
  /** Formatted result for closed trades, for example "+1.20R". */
  resultLabel?: string | null;
};

/** Light index loaded once per request by the layout (§13.3). */
export type PaletteIndex = {
  accounts: ShellAccount[];
  liveTrades: PaletteTrade[];
  /** The last 50 trades, newest first. */
  recentTrades: PaletteTrade[];
};

/**
 * State a server action returns: the §12.2 `ActionState` (src/app/actions/state.ts), declared
 * structurally. The shell reads only `status` and `message`, so every `ActionState<T>` fits.
 */
export type { ActionResult as ShellActionState } from "../ui/action-result";

/**
 * A server action in the §12.2 shape, `(prev, form) => Promise<ActionState<T>>`. The shell calls
 * it directly, as §12.2 allows client components to: with the idle state and a FormData holding
 * the fields documented on each action type below. An error state (`{ status: "error", message }`)
 * and a thrown error both count as failures. Prop names end in `Action`, as Next.js expects for
 * functions passed to client components.
 */
export type ShellAction = (prev: ActionResult, form: FormData) => Promise<ActionResult>;

/**
 * Field `account`: "all" or a trading account id. Persists the context (cookie `tos_account`,
 * §9.2) and re-renders the page. On failure the shell navigates with `?account=` instead.
 */
export type SelectAccountAction = ShellAction;
/** Field `theme`: "light" | "dark" | "system" (cookie `tos_theme`). The shell has already applied it to the document. */
export type SetThemeAction = ShellAction;
/**
 * Fields `mode`: "strategy" | "local" | "utc", and `zone`: the browser's IANA zone ("Europe/Berlin"),
 * sent when it is known; "local" needs it (cookies `tos_time`, `tos_tz`). Times re-render on the server.
 */
export type SetTimeDisplayAction = ShellAction;
/**
 * No fields. Signs out and redirects to the login page, so it may return nothing; an error state
 * or a thrown error is reported. The V1 `logout()` form action fits as is.
 */
export type SignOutAction = (prev: ActionResult, form: FormData) => Promise<unknown>;
