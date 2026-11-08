/**
 * Recently used command-palette entries, a per-browser convenience (§13.4). The history is kept
 * per signed-in user and holds only hashes of entry ids, so the browser never stores tag text or
 * record ids; `clearPaletteHistory` forgets it at sign-out and when the account is erased.
 * Storage may be unavailable (private windows, blocked site data): the palette then simply has
 * no recent section.
 */

const PREFIX = "tos.palette.recent";
const LIMIT = 5;

/**
 * cyrb53, a fast and well-distributed 53-bit string hash. It only keeps text out of storage
 * and separates users; it is not a secret and protects nothing by itself.
 */
export function paletteHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const storageKey = (user: string) => `${PREFIX}.${paletteHash(user.trim().toLowerCase())}`;

/** Hashes of the user's recently chosen entries, newest first. */
export function readPaletteHistory(user: string): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey(user)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((hash): hash is string => typeof hash === "string").slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

/** Records that the user chose an entry and returns the updated history. */
export function rememberPaletteItem(user: string, itemId: string): string[] {
  const hash = paletteHash(itemId);
  const next = [hash, ...readPaletteHistory(user).filter((existing) => existing !== hash)].slice(0, LIMIT);
  try {
    window.localStorage.setItem(storageKey(user), JSON.stringify(next));
  } catch {
    // Without storage the history lasts until the palette closes.
  }
  return next;
}

/** Ids of the entries a history points to, newest first; entries that no longer exist are skipped. */
export function recentItemIds(itemIds: readonly string[], history: readonly string[]): string[] {
  const byHash = new Map(itemIds.map((id) => [paletteHash(id), id]));
  return history.flatMap((hash) => {
    const id = byHash.get(hash);
    return id === undefined ? [] : [id];
  });
}

/** Forgets every palette history kept in this browser, for every user: call it at sign-out and account erasure. */
export function clearPaletteHistory() {
  try {
    const store = window.localStorage;
    const keys = Array.from({ length: store.length }, (_, index) => store.key(index)).filter((key): key is string => key?.startsWith(PREFIX) ?? false);
    for (const key of keys) store.removeItem(key);
  } catch {
    // Nothing was stored.
  }
}
