export const PROMPT_VERSION = "trading-os-evaluator-1.0";
export const STAGES = {
  A: "Evaluate independently in role A using the immutable input package. Do not receive or assume another evaluator's findings.",
  B: "Evaluate independently in role B using the same immutable input package. Do not receive or assume evaluator A's findings.",
  RECONCILER: "Reconcile the supplied A and B reports against the original immutable evidence. Preserve unresolved findings explicitly."
} as const;
export interface EvaluationProvider {
  evaluate(input: { model: string; systemPrompt: string; stagePrompt: string; evidenceManifest: unknown; schema: unknown; signal: AbortSignal }): Promise<{ status: "COMPLETED" | "REFUSED" | "INCOMPLETE"; output: unknown; responseId: string; model: string }>;
}
