// Types of check-unused-exports.mjs (repository tooling only).

/** Exports kept on purpose without a caller, keyed `src/<path>#<name>`, each with its reason. */
export declare const KEPT: Readonly<Record<string, string>>;

export interface UnusedExport {
  /** Repository-relative path of the module, for example `src/lib/data.ts`. */
  file: string;
  name: string;
  /** Test files that import the export by name (they exercise code the app never runs). */
  tests: string[];
}

/**
 * The source without comments; every string literal (and template literal without `${}`) replaced by the placeholder
 * `\uE000<index>\uE000` of its value in `strings`, template text dropped while its `${}` expressions stay, and regular
 * expression literals replaced by `0`.
 */
export declare function lex(source: string): { code: string; strings: string[] };

export declare function findUnusedExports(options: { root: string; kept?: Readonly<Record<string, string>> }): {
  unused: UnusedExport[];
  /** KEPT entries that no longer apply: the export is gone or now has a caller. */
  stale: string[];
};
