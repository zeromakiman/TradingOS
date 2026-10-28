/**
 * In-memory Supabase query double for the periodic AI source loaders (weekly, recent trades, monthly). It records every
 * query (table, filters, order, limit) and answers from `rows` with PostgREST-like semantics: eq, in, not.is (null),
 * not.in, lte/gte/lt on instants, multi-key ordering, limit, exact count, head (count only, no rows) and maybeSingle.
 * `errors` makes a table fail.
 */
export interface RecordedQuery {
  table: string;
  columns: string;
  filters: [string, string, unknown][];
  orders: [string, boolean][];
  limit?: number;
  /** `select(columns, { head: true })`: only the count is returned, never a row. */
  head?: boolean;
}

export interface PeriodicDbState {
  rows: Record<string, Record<string, unknown>[]>;
  queries: RecordedQuery[];
  errors: Set<string>;
}

const instant = (value: unknown) => Date.parse(String(value));

function matches(row: Record<string, unknown>, [kind, key, value]: [string, string, unknown]): boolean {
  switch (kind) {
    case "eq": return row[key] === value;
    case "in": return (value as unknown[]).includes(row[key]);
    case "not_null": return row[key] !== null && row[key] !== undefined;
    case "not_in": return !String(value).replace(/^\(|\)$/g, "").split(",").includes(String(row[key]));
    case "lte": return instant(row[key]) <= instant(value);
    case "gte": return instant(row[key]) >= instant(value);
    case "lt": return instant(row[key]) < instant(value);
    default: throw new Error(`Unsupported filter ${kind}`);
  }
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = instant(a), y = instant(b);
  if (typeof a === "string" && typeof b === "string" && /^\d{4}-\d{2}-\d{2}T/.test(a) && Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return String(a).localeCompare(String(b));
}

/** A `db` whose `from(table)` chain behaves like the Supabase client for the calls the loaders make. */
export function periodicDb(state: PeriodicDbState) {
  return {
    from(table: string) {
      const query: RecordedQuery = { table, columns: "", filters: [], orders: [] };
      state.queries.push(query);
      let single = false;
      const result = () => {
        let rows = (state.rows[table] ?? []).filter(row => query.filters.every(filter => matches(row, filter)));
        const count = rows.length;
        rows = [...rows].sort((a, b) => {
          for (const [key, ascending] of query.orders) {
            const c = compare(a[key], b[key]);
            if (c) return ascending ? c : -c;
          }
          return 0;
        });
        if (query.limit !== undefined) rows = rows.slice(0, query.limit);
        return { data: query.head ? null : single ? (rows[0] ?? null) : rows, error: state.errors.has(table) ? { message: "failed" } : null, count };
      };
      const chain = {
        select: (columns = "*", options?: { count?: string; head?: boolean }) => {
          query.columns = columns;
          if (options?.head) query.head = true;
          return chain;
        },
        eq: (key: string, value: unknown) => { query.filters.push(["eq", key, value]); return chain; },
        in: (key: string, value: unknown) => { query.filters.push(["in", key, value]); return chain; },
        not: (key: string, operator: string, value: unknown) => {
          if (operator === "is" && value === null) query.filters.push(["not_null", key, null]);
          else if (operator === "in") query.filters.push(["not_in", key, value]);
          else throw new Error(`Unsupported not.${operator}`);
          return chain;
        },
        lte: (key: string, value: unknown) => { query.filters.push(["lte", key, value]); return chain; },
        gte: (key: string, value: unknown) => { query.filters.push(["gte", key, value]); return chain; },
        lt: (key: string, value: unknown) => { query.filters.push(["lt", key, value]); return chain; },
        order: (key: string, options?: { ascending?: boolean }) => { query.orders.push([key, options?.ascending ?? true]); return chain; },
        limit: (n: number) => { query.limit = n; return chain; },
        maybeSingle: () => { single = true; return chain; },
        // biome-ignore lint/suspicious/noThenProperty: Supabase query double.
        then: (resolve: (value: unknown) => void, reject?: (error: unknown) => void) => {
          try {
            resolve(result());
          } catch (error) {
            reject?.(error);
          }
        },
      };
      return chain;
    },
  };
}
