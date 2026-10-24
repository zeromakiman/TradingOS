"use client";

import { Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { EvidenceStager } from "@/components/evidence/evidence-stager";
import { EvidencePasteTarget } from "@/components/evidence/paste-target";
import type { EvidenceLabel } from "@/components/evidence/types";
import { uploadSummary } from "@/components/evidence/upload";
import { useEvidenceStager } from "@/components/evidence/use-evidence-stager";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import { useNotify } from "./action-message";

/**
 * New screenshots of a trade that has no position (docs/V2_ARCHITECTURE.md §7.1–7.2): Ctrl/⌘+V anywhere on the page
 * (outside plain text fields), drops on the page or the zone, the file picker and the camera stage images with a label,
 * timeframe and caption; "Save" uploads them one by one with progress, each with its own evidence id so a retry is a
 * replay. The default label follows the trade (`evidenceMode`): Pre-entry before entry, Other once the plan ended
 * (Pre-entry is then not offered at all). After entry, page-level capture belongs to the journal composer instead, so
 * a screenshot lands next to the note it illustrates.
 */

export interface EvidenceUploaderProps {
  tradeId: string;
  /** Label of new screenshots; the stager offers it with HTF, Context, Entry and Other. */
  defaultLabel: EvidenceLabel;
  /** Screenshots the trade can still take. */
  remaining: number;
}

export function EvidenceUploader({ tradeId, defaultLabel, remaining }: EvidenceUploaderProps) {
  const router = useRouter();
  const notify = useNotify();
  const stager = useEvidenceStager({ defaultLabel, max: remaining });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failure, setFailure] = useState<{ text: string; key: number } | null>(null);
  const pending = stager.pendingCount;

  const save = async () => {
    if (busy || pending === 0) return;
    setBusy(true);
    setFailure(null);
    const results = await stager.uploadAll(tradeId, { onProgress: (done, total) => setProgress({ done, total }) });
    const summary = uploadSummary(results);
    setBusy(false);
    setProgress(null);
    if (summary.saved > 0) {
      stager.clearUploaded();
      router.refresh();
    }
    if (summary.failed > 0) setFailure({ text: summary.message, key: Date.now() });
    else notify(summary.message);
  };

  const label = busy && progress && progress.total > 0
    ? `Saving ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
    : pending === 1 ? "Save 1 screenshot" : `Save ${pending} screenshots`;

  return (
    <EvidencePasteTarget onFiles={stager.addFiles} disabled={remaining === 0}>
      {/* Staged cards stack in the narrow side column and pair up where the section is wide. */}
      <div className="flex flex-col gap-3 [&_ul.grid]:grid-cols-1 @xl:[&_ul.grid]:grid-cols-2" id="add-screenshots">
        <EvidenceStager stager={stager} disabled={busy} title={remaining === 0 ? "Screenshot limit reached" : "Add screenshots"} />
        {failure && (
          <FormAlert key={failure.key} tone="error">
            {failure.text}
          </FormAlert>
        )}
        {pending > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="t-caption">Staged screenshots are saved to the trade when you choose Save. Their timing is recorded by the server.</p>
            <Button icon={<Upload aria-hidden="true" />} loading={busy} loadingText={label} onClick={() => void save()}>
              {label}
            </Button>
          </div>
        )}
      </div>
    </EvidencePasteTarget>
  );
}
