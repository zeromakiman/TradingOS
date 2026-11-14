import "server-only";
import { z } from "zod";
import { trustedServer } from "./supabase/admin";

/**
 * Storage cleanup after a permanent trade deletion or a trading-account deletion (0020). The database transaction has
 * already removed the rows and returned the storage paths of the trade's screenshots; the trusted server (secret key)
 * removes those objects, then sweeps `{userId}/{tradeId}/` in the evidence bucket, which also catches orphans of failed
 * uploads. Best effort: the rows are gone either way, the objects are unreadable without them (storage RLS), and the
 * account erasure sweeps `{userId}/` again. Never logs paths or ids.
 */

const LEGACY_BUCKET = "setup-screenshots";
const EVIDENCE_BUCKET = "trade-evidence";
const REMOVE_BATCH = 100;
const LIST_PAGE = 100;
const MAX_SWEEP_ROUNDS = 5;

export const deletionStorageSchema = z.object({
  legacy: z.array(z.string().min(1)),
  evidence: z.array(z.string().min(1)),
});
type DeletionStoragePaths = z.output<typeof deletionStorageSchema>;

interface Bucket {
  list(path: string, options: { limit: number; offset: number }): Promise<{ data: readonly { name: string; id: string | null }[] | null; error: unknown }>;
  remove(paths: string[]): Promise<{ error: unknown }>;
}

/** Only the user's own folder: a path from the database never reaches another user's objects. */
function owned(userId: string, paths: readonly string[]): string[] {
  return paths.filter(path => path.startsWith(`${userId}/`) && !path.includes(".."));
}

async function remove(bucket: Bucket, paths: readonly string[]): Promise<boolean> {
  let ok = true;
  for (let start = 0; start < paths.length; start += REMOVE_BATCH) {
    const { error } = await bucket.remove(paths.slice(start, start + REMOVE_BATCH));
    if (error) ok = false;
  }
  return ok;
}

/** Removes every object directly below `{prefix}/` (evidence objects are `{user}/{trade}/{evidence}`). */
async function sweep(bucket: Bucket, prefix: string): Promise<boolean> {
  for (let round = 0; round < MAX_SWEEP_ROUNDS; round += 1) {
    const { data, error } = await bucket.list(prefix, { limit: LIST_PAGE, offset: 0 });
    if (error || !data) return false;
    const objects = data.filter(entry => entry.id !== null && entry.name !== "" && !entry.name.includes("/")).map(entry => `${prefix}/${entry.name}`);
    if (objects.length === 0) return true;
    if (!(await remove(bucket, objects))) return false;
  }
  return false;
}

/** Removes the returned objects and sweeps each trade's evidence folder. Resolves false when anything was left. */
export async function removeDeletedTradeStorage(userId: string, tradeIds: readonly string[], paths: DeletionStoragePaths): Promise<boolean> {
  const trusted = trustedServer();
  const legacy = trusted.storage.from(LEGACY_BUCKET) as unknown as Bucket;
  const evidence = trusted.storage.from(EVIDENCE_BUCKET) as unknown as Bucket;
  let ok = await remove(legacy, owned(userId, paths.legacy));
  ok = (await remove(evidence, owned(userId, paths.evidence))) && ok;
  for (const tradeId of tradeIds) {
    if (!/^[0-9a-f-]{36}$/.test(tradeId)) continue;
    ok = (await sweep(evidence, `${userId}/${tradeId}`)) && ok;
  }
  return ok;
}
