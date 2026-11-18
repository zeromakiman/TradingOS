import { AllAccountsOverview } from "./all-accounts-overview";
import { loadTodayOverview, type TodayPageOptions } from "./load-today";
import type { TimeDisplay } from "@/domain/time-display";

/** Only this section waits for the range's financial ledger. */
export async function OverviewSection({ options, display }: { options: TodayPageOptions; display: TimeDisplay }) {
  const state = await loadTodayOverview(options);
  return state ? <AllAccountsOverview state={state} display={display} /> : null;
}

export function OverviewLoading() {
  return <section aria-label="All Accounts overview" aria-busy="true" className="rounded-xl border border-border p-6"><p role="status" className="text-sm text-2">Loading account overview...</p></section>;
}
