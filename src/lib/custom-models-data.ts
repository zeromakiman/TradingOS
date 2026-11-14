import "server-only";
import { z } from "zod";
import { type CustomModel, currentModels, customModelRevisionRow, customModelRow, customModelUseRow } from "@/domain/custom-models";
import type { Db } from "./account-context";

/**
 * Custom models of the user's trading accounts (0020), read with the user's session (RLS). `accountIds` narrows the
 * read; `withUse` also reads which models were recorded on a trade (Manage → Models: assigned models can only be
 * archived).
 */
export async function loadCustomModels(db: Db, userId: string, options: { accountIds?: readonly string[]; withUse?: boolean } = {}): Promise<CustomModel[]> {
  let models = db.from("custom_models").select("id,account_id,created_at").eq("user_id", userId);
  let revisions = db.from("custom_model_revisions").select("id,model_id,name,description,status").eq("user_id", userId);
  let uses = db.from("trade_custom_models").select("model_id").eq("user_id", userId);
  if (options.accountIds) {
    models = models.in("account_id", [...options.accountIds]);
    revisions = revisions.in("account_id", [...options.accountIds]);
    uses = uses.in("account_id", [...options.accountIds]);
  }
  const [m, r, u] = await Promise.all([
    models.order("created_at", { ascending: true }).limit(1000),
    revisions.order("id", { ascending: true }).limit(5000),
    options.withUse ? uses.not("model_id", "is", null).limit(10000) : Promise.resolve({ data: [], error: null }),
  ]);
  if (m.error || r.error || u.error) throw new Error("Models are unavailable.");
  return currentModels(z.array(customModelRow).parse(m.data ?? []), z.array(customModelRevisionRow).parse(r.data ?? []), z.array(customModelUseRow).parse(u.data ?? []));
}
