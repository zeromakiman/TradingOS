import type { Metadata } from "next";
import { DeletedTradesScreen } from "@/components/journal/deleted-trades-screen";
import { loadDeletedTrades } from "@/lib/trades-data";

export const metadata: Metadata = { title: "Deleted trades · Trading OS" };

/**
 * Deleted trades (0020): the trades of the account context moved out of the Journal, EDGE, calendars, dashboards and
 * Today. Each can be restored, or deleted permanently once it no longer counts toward today's limits.
 */
export default async function DeletedTradesPage() {
  return <DeletedTradesScreen view={await loadDeletedTrades()} />;
}
