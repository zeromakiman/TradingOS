// Pure rules of scripts/local-stack/screenshot.mjs (no I/O), kept apart so they can be tested without a browser:
// which app origins it may sign in to, and which captured pages fail the run.

const LOOPBACK_NAMES = new Set(["localhost", "[::1]"]);
const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** True for a hostname (as `URL#hostname` reports it) that can only reach this machine. */
export function isLoopbackHost(hostname) {
  return LOOPBACK_NAMES.has(hostname) || LOOPBACK_V4.test(hostname);
}

/**
 * Validates `--base`: the captures sign in with a stored local password, so the origin must be loopback (the local
 * stack only, never a hosted deployment). Returns `{ base }` (the origin, no trailing slash) or `{ error }`.
 */
export function loopbackBase(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: `--base must be an http URL such as http://127.0.0.1:3000, got "${raw}"` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: `--base must use http or https, got "${raw}"` };
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    return { error: `--base must be an origin such as http://127.0.0.1:3000 (no path, query or credentials), got "${raw}"` };
  }
  if (!isLoopbackHost(url.hostname)) {
    return { error: `--base must be a loopback URL (127.0.0.1, localhost or [::1]): screenshots sign in with local passwords and use the local stack only, got "${raw}"` };
  }
  return { base: url.origin };
}

/**
 * Sorts captured pages ({status: number|null}) for the exit code and the final summary. A page that could not be
 * loaded or answered HTTP >= 500 always fails the run; a 4xx (a missing route, or a trade/account the user cannot
 * see) fails it unless `allow4xx`. `notOk` is every page that did not answer 2xx, for the summary.
 */
export function judgePages(pages, { allow4xx = false } = {}) {
  const unreached = pages.filter(page => page.status === null);
  const serverErrors = pages.filter(page => page.status !== null && page.status >= 500);
  const clientErrors = pages.filter(page => page.status !== null && page.status >= 400 && page.status < 500);
  const notOk = pages.filter(page => page.status === null || page.status < 200 || page.status >= 300);
  const failing = notOk.filter(page => page.status === null || page.status >= 500 || (page.status >= 400 && !allow4xx));
  return { unreached, serverErrors, clientErrors, notOk, failing };
}

/** One sentence for a failed run, e.g. "2 of 5 page(s) failed: 1 answered HTTP 4xx, 1 could not be loaded". */
export function failureSummary(verdict, total, { allow4xx = false } = {}) {
  const parts = [
    !allow4xx && verdict.clientErrors.length ? `${verdict.clientErrors.length} answered HTTP 4xx` : null,
    verdict.serverErrors.length ? `${verdict.serverErrors.length} answered HTTP >= 500` : null,
    verdict.unreached.length ? `${verdict.unreached.length} could not be loaded` : null,
  ].filter(Boolean);
  const hint = !allow4xx && verdict.clientErrors.length ? " (pass --allow-4xx when a missing page is expected)" : "";
  return `${verdict.failing.length} of ${total} page(s) failed: ${parts.join(", ")}${hint}`;
}

/** True when next-env.d.ts is in the form `next dev` writes (it points at .next/dev/types instead of .next/types). */
export function nextEnvRewrittenByDev(text) {
  return text.includes("/.next/dev/types/");
}
