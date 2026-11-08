// Types of the mock-openai.mjs preload (local acceptance tooling only).

export declare const REPO_ROOT: string;
export declare const MOCK_SCENARIO_FILE: string;
export declare const MOCK_LOG_FILE: string;
export declare const ENV_FILES: readonly string[];

export declare class MockOpenAiBlockedError extends Error {}

export interface MockEnvironmentOptions {
  repoRoot?: string;
  /** Returns a file's text, or null when it does not exist. */
  readFile?: (file: string) => string | null;
}
/** Every value Next.js's dotenv grammar assigns to `name` in a file's text (before ${VAR} expansion). */
export declare function dotenvValues(text: string, name: string): string[];
/** Why a dotenv file is unsafe next to the mock (a message fragment without the key), or null. */
export declare function envFileProblem(text: string): string | null;
export declare function assertMockEnvironment(env?: Record<string, string | undefined>, options?: MockEnvironmentOptions): void;
export declare function isOpenAiHost(hostname: string): boolean;
export declare function formatLogLine(at: Date, fields: Record<string, string | number | null | undefined>): string;

export interface MockFetchOptions {
  originalFetch: typeof fetch;
  scenarioFile?: string;
  logFile?: string;
  /** Scenario file text; null when the file is missing. Read on every intercepted call. */
  readScenarioText?: () => string | null;
  log?: (line: string) => void;
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  now?: () => Date;
}
export declare function createMockFetch(options: MockFetchOptions): typeof fetch;

export interface MockInstallation {
  readonly fetch: typeof fetch;
  uninstall(): void;
}
export declare function installMockOpenAi(
  options?: Omit<Partial<MockFetchOptions>, "originalFetch"> & MockEnvironmentOptions & { env?: Record<string, string | undefined>; target?: { fetch: typeof fetch } },
): MockInstallation | null;
