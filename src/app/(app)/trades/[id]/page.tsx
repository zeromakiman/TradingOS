import type { Metadata } from "next";
import { notFound, unstable_rethrow } from "next/navigation";
import { newWorkspaceKeys, TradeWorkspace } from "@/components/trade/trade-workspace";
import { loadTradeExtras } from "@/components/trade/workspace-data";
import { getPreferences } from "@/lib/account-context";
import { getTradeDetail } from "@/lib/trades-data";

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  try {
    const detail = await getTradeDetail(id);
    return { title: detail ? `${detail.title} · Trade · Trading OS` : "Trade · Trading OS" };
  } catch (error) {
    // Sign-in redirects pass through; a failed read leaves the page itself to show its error state.
    unstable_rethrow(error);
    return { title: "Trade · Trading OS" };
  }
}

/**
 * Trade workspace (docs/V2_ARCHITECTURE.md §14.4): the trade and its decision history, read with the user's session.
 * A trade that is not the user's (or does not exist) is not found; nothing about it is revealed.
 */
export default async function TradePage({ params }: { params: Params }) {
  const { id } = await params;
  const [detail, preferences] = await Promise.all([getTradeDetail(id), getPreferences()]);
  if (!detail) notFound();
  const extras = await loadTradeExtras(detail);
  return (
    <TradeWorkspace
      detail={detail}
      extras={extras}
      now={new Date().toISOString()}
      display={preferences.timeDisplay}
      developerMode={preferences.developerMode}
      keys={newWorkspaceKeys()}
    />
  );
}
