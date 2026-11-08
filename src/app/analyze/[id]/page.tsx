import { notFound, redirect } from "next/navigation";
import { legacyProposalTarget } from "@/components/trade/forms/legacy";

type Params = Promise<{ id: string }>;

/**
 * Legacy V1 setup page (docs/V2_ARCHITECTURE.md §1.2): `/analyze/[proposal id]` opens the trade that proposal is a
 * revision of. A proposal that is not the signed-in user's answers 404, exactly like one that does not exist.
 */
export default async function LegacySetupPage({ params }: { params: Params }) {
  const { id } = await params;
  const target = await legacyProposalTarget(id);
  if (target.kind === "schema-outdated") redirect("/today");
  if (target.kind === "not-found") notFound();
  redirect(`/trades/${target.tradeId}`);
}
