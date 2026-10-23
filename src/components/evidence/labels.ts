import { evidenceName, TIMING_LABELS, type Timing } from "@/domain/timeline";
import { type CaptureMethod, EVIDENCE_LABELS, type EvidenceLabel, type Timeframe } from "./types";

/**
 * Words for the evidence vocabulary (docs/V2_ARCHITECTURE.md §7.1, §7.5, §15). Short forms are for
 * chips, option forms for selects. Names such as "M5 chart" or "Entry screenshot" come from the
 * domain (`evidenceName`), so source chips, the timeline and the gallery always agree.
 */

export const EVIDENCE_LABEL_TEXT: Readonly<Record<EvidenceLabel, string>> = Object.freeze({
  HTF: "HTF",
  CONTEXT: "Context",
  PRE_ENTRY: "Pre-entry",
  ENTRY: "Entry",
  MANAGEMENT: "Management",
  EXIT: "Exit",
  OTHER: "Other",
});

export const EVIDENCE_LABEL_OPTION_TEXT: Readonly<Record<EvidenceLabel, string>> = Object.freeze({
  HTF: "HTF (higher timeframe)",
  CONTEXT: "Context",
  PRE_ENTRY: "Pre-entry",
  ENTRY: "Entry",
  MANAGEMENT: "Management",
  EXIT: "Exit",
  OTHER: "Other",
});

export const TIMEFRAME_TEXT: Readonly<Record<Timeframe, string>> = Object.freeze({
  DAILY: "Daily",
  H4: "H4",
  H1: "H1",
  M30: "M30",
  M15: "M15",
  M5: "M5",
  M3: "M3",
  OTHER: "Other timeframe",
});

/** Default label of new screenshots by the band they will most likely land in (spec §7.1). */
export const DEFAULT_LABEL_BY_TIMING: Readonly<Record<Timing, EvidenceLabel>> = Object.freeze({
  BEFORE_ENTRY: "PRE_ENTRY",
  WHILE_LIVE: "MANAGEMENT",
  AFTER_CLOSE: "EXIT",
});

export function defaultLabelForTiming(timing: Timing): EvidenceLabel {
  return DEFAULT_LABEL_BY_TIMING[timing];
}

/** Labels that fit a screenshot of any timing (spec §7.1). */
const ANY_TIMING_LABELS: readonly EvidenceLabel[] = Object.freeze(["HTF", "CONTEXT", "ENTRY", "OTHER"]);

/**
 * Labels a stager offers, from its default label (spec §7.1): the default plus HTF, Context, Entry and
 * Other, in the canonical order. Only a stager whose default is Pre-entry (before entry) offers Pre-entry,
 * so a live or after-close screenshot can't be presented as pre-entry evidence (§5.3). `current` keeps an
 * item's existing label selectable, so the select still shows it.
 */
export function labelOptionsForDefault(defaultLabel: EvidenceLabel, current?: EvidenceLabel | null): EvidenceLabel[] {
  const allowed = new Set<EvidenceLabel>([defaultLabel, ...ANY_TIMING_LABELS]);
  if (current) allowed.add(current);
  return EVIDENCE_LABELS.filter(label => allowed.has(label));
}

/**
 * Labels offered for a screenshot of `timing` (spec §7.1, §5.3): the band's default (Pre-entry, Management
 * or Exit) plus HTF, Context, Entry and Other; `current` stays selectable.
 */
export function labelOptionsForTiming(timing: Timing, current?: EvidenceLabel | null): EvidenceLabel[] {
  return labelOptionsForDefault(defaultLabelForTiming(timing), current);
}

/** "Before entry", "While live", "After close" (exact copy, spec §5.3). */
export function timingLabel(timing: Timing): string {
  return TIMING_LABELS[timing];
}

/** "M5 chart", "Daily chart", "Entry screenshot", "Screenshot". */
export function evidenceDisplayName(label: EvidenceLabel | null, timeframe: Timeframe | null): string {
  return evidenceName(label, timeframe);
}

/** "Entry · M5" for chips and summaries. */
export function evidenceTagText(label: EvidenceLabel, timeframe: Timeframe | null): string {
  return timeframe ? `${EVIDENCE_LABEL_TEXT[label]} · ${TIMEFRAME_TEXT[timeframe]}` : EVIDENCE_LABEL_TEXT[label];
}

const CAPTURE_NAMES: Readonly<Record<CaptureMethod, string>> = Object.freeze({
  PASTE: "Pasted screenshot",
  DROP: "Dropped image",
  FILE: "Chosen image",
  CAMERA: "Photo",
});

/** Readable name of a staged file: pasted images carry generic names such as "image.png". */
export function stagedFileName(fileName: string, method: CaptureMethod): string {
  const cleaned = [...fileName].filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join("").trim();
  if (method === "PASTE" || method === "CAMERA" || cleaned === "" || /^image\.(png|jpe?g|webp)$/i.test(cleaned)) return CAPTURE_NAMES[method];
  return shortFileName(cleaned);
}

/** Long names keep their start and extension: "EURUSD-london-session-…-m5.png". */
export function shortFileName(name: string, max = 40): string {
  const characters = [...name];
  if (characters.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  const keep = Math.max(8, max - [...extension].length - 1);
  return `${characters.slice(0, keep).join("")}…${extension}`;
}
