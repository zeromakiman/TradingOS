// Types of curate.mjs (browser acceptance runner, local tooling only).

export declare const DOCS_DIR: string;
export declare const MAX_BYTES: number;
export interface PublishedGroup { readonly title: string; readonly names: readonly string[] }
export declare const PUBLISHED_GROUPS: readonly PublishedGroup[];
export declare const PUBLISHED: readonly string[];

export interface CuratedItem {
  name: string;
  key: string;
  title: string;
  viewport: "desktop" | "mobile";
  theme: "light" | "dark";
  flow: string;
  full: boolean;
  screen: string;
  file: string;
  bytes?: number;
  width?: number;
  height?: number;
  encoding?: string;
}

export declare function fitPng(input: Buffer, max?: number): Promise<{ data: Buffer; method: string }>;
export declare function screensReadme(chosen: readonly CuratedItem[], results: Record<string, unknown>): string;
export declare function publishRefusal(
  results: { verdict?: string; flows?: readonly string[]; viewports?: readonly string[] },
  capturedNames: readonly string[],
): string[];
export declare function publishCurated(
  env: { out: string; curated?: CuratedItem[]; recorder: { results: Record<string, unknown>; note(text: string): void; write(): void } },
  options: { publish: boolean },
): Promise<{ count: number; dir: string; published: string | null; refused: string[] }>;
