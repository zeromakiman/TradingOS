import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Legacy URLs (docs/V2_ARCHITECTURE.md §1.2): every V1 page keeps working in V2, as the same V2 page or as a redirect,
// so no bookmark ends in a 404. The V1 list below is `git ls-tree -r --name-only bc5441c -- src/app` (pages and route
// handlers). Redirect pages run for real (the thrown Next.js digests carry their targets); only the session, the
// schema gate and the database rows they read are faked.

const m = vi.hoisted(() => ({
  ready: true,
  dbError: false,
  rows: {} as Record<string, Record<string, unknown>[]>,
  reads: [] as { table: string; filters: [string, unknown][] }[],
}));

const USER = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/schema-gate", () => ({
  getSchemaStatus: async () => (m.ready ? { ready: true, version: "2.0" } : { ready: false, reason: "OUTDATED", version: "1.4" }),
}));
vi.mock("@/lib/account-context", () => ({
  currentSession: async () => ({
    user: { id: USER },
    db: {
      from: (table: string) => {
        const read = { table, filters: [] as [string, unknown][] };
        m.reads.push(read);
        const query = {
          select: () => query,
          eq: (column: string, value: unknown) => {
            read.filters.push([column, value]);
            return query;
          },
          maybeSingle: async () => {
            if (m.dbError) return { data: null, error: { message: "SECRET relation detail" } };
            const row = (m.rows[table] ?? []).find(candidate => read.filters.every(([column, value]) => candidate[column] === value));
            return { data: row ?? null, error: null };
          },
        };
        return query;
      },
    },
  }),
}));

import Home from "@/app/page";
import LegacyAnalyzePage from "@/app/analyze/page";
import LegacySetupPage from "@/app/analyze/[id]/page";
import LegacyMonthlyReviewPage from "@/app/edge/monthly/page";
import LegacyRecentTradesReviewPage from "@/app/edge/recent/page";
import LegacyWeeklyReviewPage from "@/app/edge/weekly/page";
import LegacyPlanPage from "@/app/journal/[id]/page";
import LegacyPreviewPage from "@/app/preview/page";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "src", "app");

/** Pages and route handlers of V1 (bc5441c). */
const V1_PAGES = [
  "src/app/analyze/[id]/page.tsx", "src/app/analyze/page.tsx", "src/app/edge/monthly/page.tsx", "src/app/edge/page.tsx", "src/app/edge/recent/page.tsx",
  "src/app/edge/weekly/page.tsx", "src/app/forgot-password/page.tsx", "src/app/journal/[id]/page.tsx", "src/app/journal/page.tsx", "src/app/login/page.tsx",
  "src/app/page.tsx", "src/app/preview/page.tsx", "src/app/settings/page.tsx", "src/app/today/page.tsx", "src/app/update-password/page.tsx",
] as const;
const V1_ROUTE_HANDLERS = ["src/app/api/screenshots/[id]/route.ts", "src/app/api/setups/[id]/analyze/route.ts", "src/app/api/setups/[id]/screenshots/route.ts", "src/app/edge/export/route.ts"] as const;

/** How V2 answers each V1 URL (spec §1.2). */
const LEGACY_MAP: Record<string, { page: true } | { redirect: string }> = {
  "/": { redirect: "/today" },
  "/today": { page: true },
  "/analyze": { redirect: "/trades/new" },
  "/analyze/[id]": { redirect: "/trades/[id]" },
  "/journal": { page: true },
  "/journal/[id]": { redirect: "/trades/[id]" },
  "/edge": { page: true },
  "/edge/weekly": { redirect: "/review/weekly" },
  "/edge/recent": { redirect: "/review/recent" },
  "/edge/monthly": { redirect: "/review/monthly" },
  "/settings": { page: true },
  "/preview": { redirect: "/login" },
  "/login": { page: true },
  "/forgot-password": { page: true },
  "/update-password": { page: true },
};

/** URL pattern of an app file: route groups `(name)` add no segment. */
function urlOf(file: string): string {
  const segments = path.relative(APP, path.dirname(file)).split(path.sep).filter(segment => segment && !/^\(.+\)$/.test(segment));
  return `/${segments.join("/")}`;
}

function appFiles(dir: string, name: RegExp): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return appFiles(full, name);
    return name.test(entry) ? [full] : [];
  });
}

const v2Pages = new Map(appFiles(APP, /^page\.(tsx|ts|jsx|js)$/).map(file => [urlOf(file), file]));
const v2Routes = new Map(appFiles(APP, /^route\.(ts|js)$/).map(file => [urlOf(file), file]));

async function digestOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return String((error as { digest?: unknown }).digest);
  }
  throw new Error("Expected the page to redirect or to answer not found.");
}
const redirectTo = (target: string) => `NEXT_REDIRECT;replace;${target};307;`;
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

const PROPOSAL = "b1000000-0000-4000-8000-0000000000ff";
const PLAN = "c1000000-0000-4000-8000-0000000000aa";
const TRADE = "a1000000-0000-4000-8000-000000000001";

beforeEach(() => {
  m.ready = true;
  m.dbError = false;
  m.rows = {
    trade_revisions: [{ proposal_id: PROPOSAL, user_id: USER, trade_id: TRADE }],
    trade_plan_links: [{ plan_id: PLAN, user_id: USER, trade_id: TRADE }],
  };
  m.reads = [];
});

describe("the legacy map covers every V1 page", () => {
  it("lists each V1 page URL exactly once", () => {
    expect(V1_PAGES.map(file => urlOf(path.join(ROOT, file))).sort()).toEqual(Object.keys(LEGACY_MAP).sort());
  });

  it.each(Object.entries(LEGACY_MAP))("%s resolves to a V2 page, never to a 404", (url, answer) => {
    const page = v2Pages.get(url);
    expect(page, `${url} has no page in V2`).toBeDefined();
    if ("redirect" in answer) {
      // The redirect target is itself a V2 page.
      expect(v2Pages.has(answer.redirect), `${answer.redirect} has no page in V2`).toBe(true);
      expect(readFileSync(page as string, "utf8")).toMatch(/\bredirect\(/);
    }
  });

  it("keeps the V1 route handlers the spec keeps, and removes the V1 upload endpoint", () => {
    const methods = (url: string) => {
      const file = v2Routes.get(url);
      if (!file) return [];
      return [...readFileSync(file, "utf8").matchAll(/export\s+(?:async\s+function|const|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map(match => match[1]);
    };
    expect(V1_ROUTE_HANDLERS.map(file => urlOf(path.join(ROOT, file)))).toEqual(["/api/screenshots/[id]", "/api/setups/[id]/analyze", "/api/setups/[id]/screenshots", "/edge/export"]);
    // Legacy screenshot bytes, the legacy CSV and the legacy evaluator (kept, not linked from the V2 UI).
    expect(methods("/api/screenshots/[id]")).toContain("GET");
    expect(methods("/edge/export")).toContain("GET");
    expect(methods("/api/setups/[id]/analyze")).toContain("POST");
    // V1 uploaded screenshots through POST /api/setups/[id]/screenshots; V2 uploads evidence only through the trade route.
    expect(v2Routes.has("/api/setups/[id]/screenshots")).toBe(false);
    expect(methods("/api/trades/[id]/evidence")).toContain("POST");
  });

  it("no V2 source sends anything to the removed upload endpoint or links the legacy evaluator", () => {
    const sources = appFiles(path.join(ROOT, "src"), /\.(ts|tsx)$/).filter(file => !file.endsWith(path.join("api", "setups", "[id]", "analyze", "route.ts")));
    const offenders = sources.filter(file => {
      const text = readFileSync(file, "utf8");
      return /\/api\/setups\/[^"'`]*\/screenshots/.test(text) || /\/api\/setups\/\$\{[^}]+\}\/screenshots/.test(text) || /["'`]\/api\/setups\/[^"'`]*\/analyze/.test(text);
    });
    expect(offenders.map(file => path.relative(ROOT, file))).toEqual([]);
  });
});

describe("redirects", () => {
  it("/ opens Today", async () => {
    expect(await digestOf(() => Home())).toBe(redirectTo("/today"));
  });

  it("/preview opens sign-in", async () => {
    expect(await digestOf(() => LegacyPreviewPage())).toBe(redirectTo("/login"));
  });

  it("/analyze opens Plan Trade with the whole query string, repeated keys and encoding kept", async () => {
    expect(await digestOf(() => LegacyAnalyzePage({ searchParams: Promise.resolve({}) }))).toBe(redirectTo("/trades/new"));
    const searchParams = Promise.resolve({ account: "20000000-0000-4000-8000-000000000001", tag: ["a b", "c&d"], empty: undefined });
    expect(await digestOf(() => LegacyAnalyzePage({ searchParams }))).toBe(redirectTo("/trades/new?account=20000000-0000-4000-8000-000000000001&tag=a+b&tag=c%26d"));
  });

  type ReviewPage = (props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<void>;
  const reviews: [string, ReviewPage, Record<string, string | string[] | undefined>, string][] = [
    ["weekly", LegacyWeeklyReviewPage, { account: "all", week: "2026-10-14", page: "2" }, "/review/weekly?account=all&week=2026-10-14&page=2"],
    ["recent", LegacyRecentTradesReviewPage, { sample: "30", account: "20000000-0000-4000-8000-000000000001" }, "/review/recent?sample=30&account=20000000-0000-4000-8000-000000000001"],
    ["monthly", LegacyMonthlyReviewPage, { month: "2026-09", note: ["x y", "z"] }, "/review/monthly?month=2026-09&note=x+y&note=z"],
  ];
  it.each(reviews)("/edge/%s moves to the Review page with its query string in order", async (kind, Page, params, target) => {
    expect(await digestOf(() => Page({ searchParams: Promise.resolve(params) }))).toBe(redirectTo(target));
    expect(await digestOf(() => Page({ searchParams: Promise.resolve({}) }))).toBe(redirectTo(`/review/${kind}`));
  });

  it("never lets a query string change where a legacy link leads (no open redirect)", async () => {
    const hostile = { next: "https://attacker.example/x", to: "//attacker.example", back: "/journal/../settings", line: "a\r\nLocation: https://attacker.example" };
    const targets = [
      await digestOf(() => LegacyAnalyzePage({ searchParams: Promise.resolve(hostile) })),
      await digestOf(() => LegacyWeeklyReviewPage({ searchParams: Promise.resolve(hostile) })),
      await digestOf(() => LegacyRecentTradesReviewPage({ searchParams: Promise.resolve(hostile) })),
      await digestOf(() => LegacyMonthlyReviewPage({ searchParams: Promise.resolve(hostile) })),
    ].map(digest => digest.split(";")[2]);
    expect(targets.map(target => target.split("?")[0])).toEqual(["/trades/new", "/review/weekly", "/review/recent", "/review/monthly"]);
    for (const target of targets) {
      // Every value is encoded inside the query: no second path, scheme, host or header line.
      expect(new URL(target, "http://localhost").origin).toBe("http://localhost");
      expect(target).not.toMatch(/[\r\n]|\/\/attacker|https?:\/\//);
    }
  });

  it("/analyze/[proposal] opens the trade the proposal is a revision of, read for the signed-in owner", async () => {
    expect(await digestOf(() => LegacySetupPage({ params: Promise.resolve({ id: PROPOSAL.toUpperCase() }) }))).toBe(redirectTo(`/trades/${TRADE}`));
    expect(m.reads).toEqual([{ table: "trade_revisions", filters: [["proposal_id", PROPOSAL], ["user_id", USER]] }]);
  });

  it("/journal/[plan] opens the trade that owns the plan, read for the signed-in owner", async () => {
    expect(await digestOf(() => LegacyPlanPage({ params: Promise.resolve({ id: ` ${PLAN.toUpperCase()} ` }) }))).toBe(redirectTo(`/trades/${TRADE}`));
    expect(m.reads).toEqual([{ table: "trade_plan_links", filters: [["plan_id", PLAN], ["user_id", USER]] }]);
  });

  it("answers not found, without revealing anything, for another user's or an unknown record", async () => {
    m.rows = {
      trade_revisions: [{ proposal_id: PROPOSAL, user_id: OTHER, trade_id: TRADE }],
      trade_plan_links: [{ plan_id: PLAN, user_id: OTHER, trade_id: TRADE }],
    };
    expect(await digestOf(() => LegacySetupPage({ params: Promise.resolve({ id: PROPOSAL }) }))).toBe(NOT_FOUND);
    expect(await digestOf(() => LegacyPlanPage({ params: Promise.resolve({ id: PLAN }) }))).toBe(NOT_FOUND);
    m.rows = {};
    expect(await digestOf(() => LegacySetupPage({ params: Promise.resolve({ id: PROPOSAL }) }))).toBe(NOT_FOUND);
    expect(await digestOf(() => LegacyPlanPage({ params: Promise.resolve({ id: PLAN }) }))).toBe(NOT_FOUND);
  });

  it("answers not found for a malformed id before reading anything", async () => {
    expect(await digestOf(() => LegacySetupPage({ params: Promise.resolve({ id: "not-a-proposal" }) }))).toBe(NOT_FOUND);
    expect(await digestOf(() => LegacyPlanPage({ params: Promise.resolve({ id: "../settings" }) }))).toBe(NOT_FOUND);
    expect(m.reads).toEqual([]);
  });

  it("leaves an outdated database to the app's own pages: both links open Today without reading records", async () => {
    m.ready = false;
    expect(await digestOf(() => LegacySetupPage({ params: Promise.resolve({ id: PROPOSAL }) }))).toBe(redirectTo("/today"));
    expect(await digestOf(() => LegacyPlanPage({ params: Promise.resolve({ id: PLAN }) }))).toBe(redirectTo("/today"));
    expect(m.reads).toEqual([]);
  });

  it("fails into the error boundary on a read failure, never into a redirect or a database message", async () => {
    m.dbError = true;
    const setup = LegacySetupPage({ params: Promise.resolve({ id: PROPOSAL }) });
    await expect(setup).rejects.toThrow();
    await expect(setup).rejects.not.toHaveProperty("digest");
    await expect(setup).rejects.not.toThrow(/SECRET/);
    const plan = LegacyPlanPage({ params: Promise.resolve({ id: PLAN }) });
    await expect(plan).rejects.toThrow();
    await expect(plan).rejects.not.toHaveProperty("digest");
    await expect(plan).rejects.not.toThrow(/SECRET/);
  });
});

describe("legacy links answer with real HTTP redirects and 404s, not a streamed page", () => {
  // Once a Suspense fallback renders (a `loading.tsx` is one), Next.js has committed to 200 OK and streams the page: a
  // redirect() thrown after it becomes a client-side redirect and notFound() a 200 page carrying the not-found marker
  // (node_modules/next/dist/docs/01-app/02-guides/streaming.md, "The HTTP contract" › "Status codes"). V1 had a root
  // src/app/loading.tsx, so its bookmarks answered 200 with a client-side redirect; the cleanup deleted it, and the app's
  // pages keep their skeletons through src/app/(app)/loading.tsx, which is not above any legacy page. Keep it that way.
  const redirectPages = Object.entries(LEGACY_MAP).flatMap(([url, answer]) => ("redirect" in answer ? [[url, v2Pages.get(url) as string] as const] : []));
  /** Every folder from the page's own up to src/app: the segments whose loading, layout and template wrap the page. */
  const segmentFolders = (page: string) => {
    const folders = [path.dirname(page)];
    while (folders[folders.length - 1] !== APP) folders.push(path.dirname(folders[folders.length - 1]));
    return folders;
  };
  /** True when a layout or template renders its `children` inside a <Suspense> element. */
  const suspendsChildren = (source: string) => [...source.matchAll(/<Suspense\b[^>]*>([\s\S]*?)<\/Suspense>/g)].some(match => /\bchildren\b/.test(match[1]));

  it("checks every redirecting legacy page, through src/app itself", () => {
    expect(redirectPages.map(([url]) => url).sort()).toEqual(["/", "/analyze", "/analyze/[id]", "/edge/monthly", "/edge/recent", "/edge/weekly", "/journal/[id]", "/preview"]);
    expect(redirectPages.every(([, page]) => segmentFolders(page).at(-1) === APP)).toBe(true);
  });

  it.each(redirectPages)("%s has no loading boundary above it", (_, page) => {
    const loading = segmentFolders(page).flatMap(folder => readdirSync(folder).filter(entry => /^loading\.(tsx|ts|jsx|js)$/.test(entry)).map(entry => path.relative(ROOT, path.join(folder, entry))));
    expect(loading).toEqual([]);
  });

  it.each(redirectPages)("%s has no layout or template that suspends its content", (_, page) => {
    const wrappers = segmentFolders(page).flatMap(folder => readdirSync(folder).filter(entry => /^(layout|template)\.(tsx|ts|jsx|js)$/.test(entry)).map(entry => path.join(folder, entry)));
    expect(wrappers.length).toBeGreaterThan(0); // the root layout at least
    expect(wrappers.filter(file => suspendsChildren(readFileSync(file, "utf8"))).map(file => path.relative(ROOT, file))).toEqual([]);
  });

  it("the guard recognises a Suspense around children and ignores one around a sibling", () => {
    expect(suspendsChildren("<body><Suspense fallback={<Spinner />}>{children}</Suspense></body>")).toBe(true);
    expect(suspendsChildren("<body>{children}<Suspense fallback={null}><SignOutCleanup /></Suspense></body>")).toBe(false);
  });
});

describe("the legacy not-found pages exist where a V1 link can name a missing record", () => {
  it.each(["src/app/analyze/[id]/not-found.tsx", "src/app/journal/[id]/not-found.tsx"])("%s", file => {
    expect(existsSync(path.join(ROOT, file))).toBe(true);
  });
});
