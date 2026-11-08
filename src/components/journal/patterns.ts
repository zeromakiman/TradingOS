/**
 * HTML `pattern` values of the Journal's filter inputs, mirroring what `parseTradeFilters` accepts (src/lib/trades-data.ts:
 * SYMBOL, TAG, and comma-separated tag lists) so a value the server would ignore is caught in the field instead.
 *
 * Browsers compile `pattern` as `new RegExp(`^(?:${pattern})$`, "v")` (unicode sets), where `/`, `-` and doubled
 * punctuation inside a character class must be escaped; an invalid pattern silently disables validation. Each value is
 * therefore valid with both the `v` and the `u` flag (tests/v2-screen-journal.test.ts compiles them). Surrounding
 * whitespace is allowed because the server trims it. A tag ends with a non-space character, so the spaces before a
 * comma can only be read one way (no backtracking blow-up on long lists).
 */

const SYMBOL = String.raw`[A-Za-z0-9][A-Za-z0-9._\/\-]{0,19}`;
const TAG = String.raw`[A-Za-z0-9](?:[A-Za-z0-9 _\-]{0,30}[A-Za-z0-9_\-])?`;

/** One instrument symbol: `EURUSD`, `BTC/USD`, `US30.cash` (the server upper-cases it). */
export const INSTRUMENT_PATTERN = String.raw`\s*${SYMBOL}\s*`;

/** An optional instrument field: one symbol, or blank (no instrument filter). */
export const OPTIONAL_INSTRUMENT_PATTERN = String.raw`\s*(?:${SYMBOL}\s*)?`;

/** One tag: letters, digits, spaces, `_` and `-`, starting with a letter or digit, at most 32 characters. */
export const TAG_PATTERN = String.raw`\s*${TAG}\s*`;

/** Tags separated by commas (`news, london`), or blank; empty items are ignored, as on the server. */
export const TAG_LIST_PATTERN = String.raw`[\s,]*(?:${TAG}(?:\s*,[\s,]*${TAG})*[\s,]*)?`;

/** The accepted format in words: browsers add it to their "match the requested format" message. */
export const INSTRUMENT_FORMAT = "Letters, digits and . _ / - only, up to 20 characters.";
export const TAG_FORMAT = "Letters, digits, spaces, _ and - only, up to 32 characters.";
export const TAG_LIST_FORMAT = "Tags of letters, digits, spaces, _ and -, separated by commas.";
