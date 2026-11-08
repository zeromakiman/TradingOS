// Types of mock-openai-generator.mjs (local acceptance tooling only).

export declare const MOCK_KEY_PREFIX: "sk-local-mock";
export declare const OPENAI_API_HOST: "api.openai.com";
export declare const RESPONSES_PATH: "/v1/responses";
export declare const INPUT_TOKENS_PATH: "/v1/responses/input_tokens";
export declare const OVERSIZED_INPUT_TOKENS: number;
export declare const MAX_IMAGE_TOKENS: number;
export declare const FOREIGN_SOURCE_ID: string;
export declare const DIRECTIVE_TEXT: string;

export type MockScenarioName =
  | "ok" | "refusal" | "incomplete" | "http_500" | "http_429" | "http_401" | "http_403" | "network_error" | "invalid_json"
  | "schema_violation" | "foreign_source" | "hindsight_citation" | "trading_directive" | "count_unavailable" | "input_limit_exceeded";

export interface MockScenarioInfo {
  readonly endpoint: "responses" | "input_tokens";
  /** ProviderError code src/ai/provider.ts raises; null when the provider call succeeds. */
  readonly providerError: string | null;
  readonly description: string;
}
export declare const MOCK_SCENARIOS: Readonly<Record<MockScenarioName, MockScenarioInfo>>;
export declare const KNOWN_CONTRACTS: readonly string[];

export interface ScenarioEntry { scenario: MockScenarioName; delayMs: number | null }
export interface ScenarioConfig { entries: Map<string, ScenarioEntry>; delayMs: number }
export interface ScenarioChoice { scenario: MockScenarioName; delayMs: number; matched: string | null }
export declare class ScenarioConfigError extends Error {}
export declare function parseScenarioConfig(text: string | null | undefined): ScenarioConfig;
export declare function resolveScenario(config: ScenarioConfig | null | undefined, schemaName: string | null | undefined): ScenarioChoice;

export declare function requestSeed(bodyText: string): string;
export declare function textTokens(text: string): number;
export declare function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null;
export declare function imageTokens(dataUrl: string, detail?: string): number;
export declare function estimateInputTokens(countBody: string): number;
export declare function countEquivalentBody(payload: unknown): string;

export declare class MockRequestError extends Error {}
export interface ParsedResponsesRequest {
  payload: Record<string, unknown>;
  model: string;
  name: string;
  schema: Record<string, unknown>;
  context: unknown;
  prior: unknown[];
  maxOutputTokens: number | null;
}
export declare function describeRequest(bodyText: string): { schema: string | null; model: string | null };
export declare function parseResponsesRequest(bodyText: string): ParsedResponsesRequest;

export declare function fitText(text: string, min?: number, max?: number): string;
export declare function schemaErrors(value: unknown, schema: object): string[];
export declare function resolveRefs(wanted: readonly string[], allowed: readonly string[], minItems?: number, maxItems?: number, rotation?: number): string[];
export declare function generateOutput(request: { name: string; schema: object; context?: unknown; prior?: readonly unknown[]; seed?: string }): unknown;
export declare function violateOutput(output: unknown, scenario: MockScenarioName, request?: { context?: unknown }): unknown;

export interface MockHttpResult {
  status: number;
  body: unknown;
  /** The JSON instance behind output_text (generated scenarios only). */
  output?: unknown;
}
export declare function buildInputTokensResult(bodyText: string, scenario?: MockScenarioName): MockHttpResult;
export declare function buildResponsesResult(bodyText: string, options?: { scenario?: MockScenarioName; responseId?: string; createdAt?: number }): MockHttpResult;
