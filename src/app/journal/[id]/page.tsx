import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { currentSession } from "@/lib/account-context";
import { getSchemaStatus } from "@/lib/schema-gate";

/**
 * Legacy V1 plan page (docs/V2_ARCHITECTURE.md §1.2): a bookmark of `/journal/<plan id>` keeps working by redirecting to
 * the trade that owns the plan (`trade_plan_links`, read with the user's session). A plan that is unknown or belongs
 * to someone else is not found; nothing about it is revealed. Without the 2.0 schema the app's own pages explain the
 * required database update.
 */

const planId = z.uuid();
const linkRow = z.object({ trade_id: z.uuid() });

export default async function LegacyPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const plan = planId.safeParse(id.trim().toLowerCase());
  if (!plan.success) notFound();
  const [{ db, user }, schema] = await Promise.all([currentSession(), getSchemaStatus()]);
  if (!schema.ready) redirect("/today");
  const { data, error } = await db.from("trade_plan_links").select("trade_id").eq("plan_id", plan.data).eq("user_id", user.id).maybeSingle();
  if (error) throw new Error("Trade unavailable");
  const link = data ? linkRow.safeParse(data) : null;
  if (!link?.success) notFound();
  redirect(`/trades/${link.data.trade_id}`);
}
