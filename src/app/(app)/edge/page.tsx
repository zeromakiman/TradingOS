import type { Metadata } from "next";
import { loadEdge } from "@/components/edge/edge-data";
import { EdgeScreen } from "@/components/edge/edge-screen";

/** EDGE (docs/V2_ARCHITECTURE.md §14.6): deterministic analytics of the account context's closed trades. */
export const metadata: Metadata = { title: "EDGE · Trading OS" };

export default async function EdgePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const data = await loadEdge(await searchParams);
  return <EdgeScreen data={data} />;
}
