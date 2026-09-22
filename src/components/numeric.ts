/**
 * Presentation only. The tone is read from the sign that the authoritative
 * formatR already produced, so colour can never disagree with the printed
 * value. Nothing here parses or re-derives a trading number.
 */
export function rTone(formatted: string) {
  if (formatted.startsWith("+")) return "success";
  if (formatted.startsWith("-") || formatted.startsWith("\u2212")) return "red";
  return "muted";
}
