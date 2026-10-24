import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { autosaveKey } from "@/components/trade/forms/autosave";
import { loadEditDraft } from "@/components/trade/forms/form-data";
import { NotEditableView } from "@/components/trade/forms/not-editable";
import { draftFromRevision } from "@/components/trade/forms/plan-model";
import { PlanTradeForm } from "@/components/trade/forms/plan-trade-form";
import { SavedEvidence } from "@/components/trade/forms/saved-evidence";
import { getPreferences } from "@/lib/account-context";
import { getTradeDetail } from "@/lib/trades-data";

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const detail = await getTradeDetail(id);
  return { title: detail ? `Edit draft · ${detail.title} · Trading OS` : "Edit draft · Trading OS" };
}

/**
 * Edit Draft (docs/V2_ARCHITECTURE.md §2.5, §8.1, §14.2): the latest revision prefilled; saving creates the next
 * revision only while the draft is still at the revision this page loaded. Saved screenshots stay with the trade.
 * Unsaved edits are kept in the tab for this revision and restored after Back or a reload.
 */
export default async function EditDraftPage({ params }: { params: Params }) {
  const [{ id }, preferences] = await Promise.all([params, getPreferences()]);
  const loaded = await loadEditDraft(id);
  if (!loaded) notFound();
  if (loaded.kind === "not-editable") return <NotEditableView data={loaded.data} />;
  const { data } = loaded;
  return (
    <PlanTradeForm
      now={data.now}
      accounts={[data.account]}
      initial={draftFromRevision(data.prefill, data.account)}
      mode={{
        kind: "edit",
        tradeId: data.tradeId,
        title: data.title,
        revision: data.revision,
        expectedRevision: data.expectedRevision,
        stateLabel: data.stateLabel,
        stateTone: data.stateTone,
        archived: data.archived,
        aiAnalysesOfRevision: data.aiAnalysesOfRevision,
        contractUpdatedSymbol: data.contractUpdated?.symbol ?? null,
      }}
      evidenceCapacity={data.evidenceCapacity}
      savedEvidence={<SavedEvidence tradeId={data.tradeId} items={data.evidence} now={data.now} display={preferences.timeDisplay} />}
      autosaveKey={autosaveKey(data.autosaveScope, { form: "edit", tradeId: data.tradeId, revision: data.revision })}
    />
  );
}
