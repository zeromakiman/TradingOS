import { DatabaseZap } from "lucide-react";
import type { ReactNode } from "react";
import { logout } from "@/app/actions";
import { setAccountContext, setTheme, setTimeDisplay, signOut } from "@/app/actions/context";
import { AppShell } from "@/components/shell/app-shell";
import type { PaletteIndex } from "@/components/shell/types";
import { buttonClasses } from "@/components/ui/button";
import { currentSession, getAccountContext, getPreferences, shellAccounts, shellSelection } from "@/lib/account-context";
import { operationalFailure } from "@/lib/operational-log";
import { getSchemaStatus, SCHEMA_OUTDATED_MESSAGE, SCHEMA_OUTDATED_TITLE } from "@/lib/schema-gate";
import { loadPaletteTrades } from "@/lib/trades-data";

/**
 * Authenticated application layout (docs/V2_ARCHITECTURE.md §1.2, §13.3, §13.10). Once per request it loads the
 * schema gate, the signed-in user, the trading accounts and the selected context, the display preferences and the
 * command palette index (accounts, live trades, the last 50 trades), then renders the presentational shell. On a
 * database without the 2.0 schema marker it renders only the "Database update required" page: no page below it
 * renders, and every server action refuses to write.
 */

function SchemaGate() {
  return (
    <main id="main-content" className="empty-state" style={{ minHeight: "100dvh", justifyContent: "center" }}>
      <div className="empty-state-icon" aria-hidden="true">
        <DatabaseZap />
      </div>
      <h1 className="empty-state-title">{SCHEMA_OUTDATED_TITLE}</h1>
      <p className="empty-state-description">{SCHEMA_OUTDATED_MESSAGE}</p>
      <form action={logout} className="empty-state-actions">
        <button type="submit" className={buttonClasses({ variant: "secondary" })}>
          Sign out
        </button>
      </form>
    </main>
  );
}

const EMPTY_PALETTE = { liveTrades: [], recentTrades: [] };

export default async function AppLayout({ children }: { children: ReactNode }) {
  const [{ db, user }, schema] = await Promise.all([currentSession(), getSchemaStatus()]);
  if (!schema.ready) return <SchemaGate />;
  const [context, preferences] = await Promise.all([getAccountContext(), getPreferences()]);
  const now = new Date().toISOString();
  const accounts = shellAccounts(context);
  // The palette searches every account's trades; without it the shell still works, so a failed read degrades.
  const trades = await loadPaletteTrades({ db, userId: user.id, scope: { mode: "all" }, accounts: context.accounts, now, display: preferences.timeDisplay })
    .catch(() => {
      operationalFailure("data_read_failed");
      return EMPTY_PALETTE;
    });
  const paletteIndex: PaletteIndex = { accounts, liveTrades: trades.liveTrades, recentTrades: trades.recentTrades };
  return (
    <AppShell
      user={{ email: user.email ?? "" }}
      accounts={accounts}
      context={shellSelection(context)}
      clock={{ nowIso: now }}
      paletteIndex={paletteIndex}
      developerMode={preferences.developerMode}
      theme={preferences.theme}
      timeDisplay={preferences.timeDisplay}
      sidebarCollapsed={preferences.sidebarCollapsed}
      notice={context.noticeText}
      storedContextUnavailable={context.storedUnavailable === true}
      selectAccountAction={setAccountContext}
      setThemeAction={setTheme}
      setTimeDisplayAction={setTimeDisplay}
      signOutAction={signOut}
    >
      {children}
    </AppShell>
  );
}
