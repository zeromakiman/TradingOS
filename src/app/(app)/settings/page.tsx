import type { Metadata } from "next";
import { loadSettingsPage } from "@/components/settings/settings-data";
import { SettingsPage } from "@/components/settings/settings-page";

export const metadata: Metadata = { title: "Settings · Trading OS" };
export const dynamic = "force-dynamic";

/** Settings (docs/V2_ARCHITECTURE.md §14.11). `?account=` (the AI fix route) is applied by the proxy to the context. */
export default async function Page() {
  return <SettingsPage data={await loadSettingsPage()} />;
}
