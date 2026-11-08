/** One to three digits followed by comma-separated groups of three: "2,350", "10,000", "1,250,000". */
const THOUSANDS_GROUPS = /^[+-]?\d{1,3}(,\d{3})+$/;

/**
 * Whether a comma in typed text can only be a decimal comma: exactly one comma, no point, and
 * not a thousands grouping. "1,10000" and "0,5" qualify; "2,350" does not, because it may mean
 * two thousand three hundred and fifty.
 */
function hasDecimalComma(text: string) {
  const comma = text.indexOf(",");
  return comma !== -1 && comma === text.lastIndexOf(",") && !text.includes(".") && !THOUSANDS_GROUPS.test(text);
}

/**
 * Normalises what a person typed into a decimal string without changing its digits or scale.
 * Whitespace is removed, and an unambiguous decimal comma becomes a point, because decimal
 * keypads in many locales only offer a comma: "1,10000" becomes "1.10000". Text whose comma
 * may group thousands ("2,350", "10,000", "25,000.50") is returned unchanged, so validation
 * rejects it visibly instead of storing a value a thousand times smaller. Nothing is rounded,
 * stripped of trailing zeros or converted to a number.
 */
export function normalizeDecimalInput(raw: string) {
  const text = raw.replace(/\s+/g, "");
  return hasDecimalComma(text) ? text.replace(",", ".") : text;
}
