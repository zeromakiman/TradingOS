import { z } from "zod";

/**
 * Custom models (0020): per-account names a trader records live-first trades with, next to the Risk Engine's own
 * OB first touch and OTE. A custom model is a journal label only. The trade's entry model stays OTHER, and the Risk
 * Engine, the proposal schema and every AI context keep reading only that. Pure module.
 */

export const CUSTOM_MODEL_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type CustomModelStatus = (typeof CUSTOM_MODEL_STATUSES)[number];

export interface CustomModel {
  id: string;
  accountId: string;
  name: string;
  description: string | null;
  status: CustomModelStatus;
  createdAt: string;
  /** Recorded on at least one trade (it can then only be archived). */
  used: boolean;
}

export const customModelRow = z.object({ id: z.uuid(), account_id: z.uuid(), created_at: z.string() });
export const customModelRevisionRow = z.object({
  id: z.number().int(), model_id: z.uuid(), name: z.string().min(1), description: z.string().nullable(), status: z.enum(CUSTOM_MODEL_STATUSES),
});
export const customModelUseRow = z.object({ model_id: z.uuid().nullable() });

/** Names the Risk Engine's own models use: never a custom model's name (compared case-insensitively). */
export function reservedModelName(name: string): boolean {
  const key = name.trim().toLowerCase().replace(/[\s_]+/g, " ");
  return key === "ob first touch" || key === "ote" || key === "other";
}

/** Every model with its latest revision, by name. */
export function currentModels(
  models: readonly z.output<typeof customModelRow>[],
  revisions: readonly z.output<typeof customModelRevisionRow>[],
  uses: readonly z.output<typeof customModelUseRow>[] = [],
): CustomModel[] {
  const latest = new Map<string, z.output<typeof customModelRevisionRow>>();
  for (const revision of revisions) {
    const current = latest.get(revision.model_id);
    if (!current || revision.id > current.id) latest.set(revision.model_id, revision);
  }
  const used = new Set(uses.map(use => use.model_id).filter((id): id is string => id !== null));
  return models
    .flatMap(model => {
      const revision = latest.get(model.id);
      return revision
        ? [{ id: model.id, accountId: model.account_id, name: revision.name, description: revision.description, status: revision.status, createdAt: model.created_at, used: used.has(model.id) }]
        : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || (a.id < b.id ? -1 : 1));
}
