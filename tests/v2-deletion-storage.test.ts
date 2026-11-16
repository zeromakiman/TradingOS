import { describe, expect, it, vi } from "vitest";

// Storage cleanup drain after a permanent deletion (0020): the queue rows are what the deletion's transaction recorded;
// only rows whose objects are gone are completed, so a failed removal stays queued for the next drain.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ trustedServer: () => { throw new Error("tests pass their own services"); } }));
import { type CleanupServices, drainStorageCleanup } from "@/lib/deletion-storage";

const USER = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const TRADE = "a0000000-0000-4000-8000-000000000001";

type Row = { id: number; user_id: string; bucket: string; kind: string; path: string };

function fakeDb(rows: Row[]) {
  return {
    from: (table: string) => {
      expect(table).toBe("storage_cleanup_queue");
      let user = "";
      let head = false;
      const chain = {
        select: (_columns: string, options?: { head?: boolean }) => { head = options?.head === true; return chain; },
        eq: (_column: string, value: string) => { user = value; return head ? Promise.resolve({ count: rows.filter(row => row.user_id === user).length, error: null }) : chain; },
        order: () => chain,
        limit: () => Promise.resolve({ data: rows.filter(row => row.user_id === user).map(({ user_id: _user, ...row }) => row), error: null }),
      };
      return chain;
    },
  };
}

function services(rows: Row[], options: { failObjects?: string[]; folder?: string[] } = {}) {
  const removed: string[] = [];
  const folder = [...(options.folder ?? [])];
  const bucket = (name: string) => ({
    list: async () => ({ data: folder.map(file => ({ name: file, id: `${name}-${file}` })), error: null }),
    remove: async (paths: string[]) => {
      if (paths.some(path => options.failObjects?.includes(path))) return { error: { message: "synthetic storage failure" } };
      removed.push(...paths.map(path => `${name}:${path}`));
      for (const path of paths) {
        const file = path.split("/").at(-1) as string;
        if (folder.includes(file)) folder.splice(folder.indexOf(file), 1);
      }
      return { error: null };
    },
  });
  const completed: number[] = [];
  const api: CleanupServices = {
    bucket: name => bucket(name),
    complete: async (user, ids) => {
      expect(user).toBe(USER);
      completed.push(...ids);
      for (const id of ids) rows.splice(rows.findIndex(row => row.id === id), 1);
      return true;
    },
  };
  return { api, removed, completed };
}

describe("drainStorageCleanup", () => {
  it("removes queued objects, sweeps queued folders, and completes only what succeeded", async () => {
    const rows: Row[] = [
      { id: 1, user_id: USER, bucket: "trade-evidence", kind: "OBJECT", path: `${USER}/${TRADE}/e1` },
      { id: 2, user_id: USER, bucket: "trade-evidence", kind: "PREFIX", path: `${USER}/${TRADE}` },
      { id: 3, user_id: USER, bucket: "setup-screenshots", kind: "OBJECT", path: `${USER}/p1/s1` },
      { id: 9, user_id: OTHER, bucket: "trade-evidence", kind: "OBJECT", path: `${OTHER}/${TRADE}/e9` },
    ];
    const { api, removed, completed } = services(rows, { failObjects: [`${USER}/p1/s1`], folder: ["orphan"] });
    const pending = await drainStorageCleanup(fakeDb(rows) as never, USER, api);
    expect(removed).toEqual([`trade-evidence:${USER}/${TRADE}/e1`, `trade-evidence:${USER}/${TRADE}/orphan`]);
    expect(completed).toEqual([1, 2]);
    // The failed legacy object stays queued (and the other user's row is never read or touched).
    expect(pending).toBe(1);
    expect(rows.map(row => row.id)).toEqual([3, 9]);
  });

  it("a later drain retries what is left and reports nothing pending once it is gone", async () => {
    const rows: Row[] = [{ id: 3, user_id: USER, bucket: "setup-screenshots", kind: "OBJECT", path: `${USER}/p1/s1` }];
    const { api, completed } = services(rows);
    expect(await drainStorageCleanup(fakeDb(rows) as never, USER, api)).toBe(0);
    expect(completed).toEqual([3]);
  });

  it("never touches a path outside the user's own folder", async () => {
    const rows: Row[] = [{ id: 4, user_id: USER, bucket: "trade-evidence", kind: "OBJECT", path: `${OTHER}/${TRADE}/e1` }];
    const { api, removed, completed } = services(rows);
    expect(await drainStorageCleanup(fakeDb(rows) as never, USER, api)).toBe(1);
    expect(removed).toEqual([]);
    expect(completed).toEqual([]);
  });
});
