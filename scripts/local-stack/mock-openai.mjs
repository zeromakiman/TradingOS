// LOCAL ACCEPTANCE TOOLING ONLY - never for Vercel Preview or production. Node preload that answers the two OpenAI
// Responses API endpoints the app calls (src/ai/provider.ts) from a deterministic local mock, so every AI flow can be
// exercised end to end against the local Supabase-compatible stack without a paid provider call:
//
//   AI_ENABLED=true OPENAI_API_KEY=sk-local-mock-<anything> MOCK_OPENAI=1 \
//     NODE_OPTIONS="--import=./scripts/local-stack/mock-openai.mjs" npx pnpm@11.19.0 dev
//
// Guards (fail closed):
// - Nothing happens unless MOCK_OPENAI is exactly "1" (then this module does not touch fetch at all).
// - With MOCK_OPENAI=1 the import throws, so the server cannot start, when OPENAI_API_KEY is set to anything that does
//   not start with "sk-local-mock", when it is unset but a .env file the app would load defines a non-mock key (read
//   with Next.js's own dotenv grammar, plus a strict single-line check of every line that can assign the key), or on
//   Vercel (VERCEL / VERCEL_ENV set). A real key never coexists with the mock.
// - globalThis.fetch is wrapped: POST https://api.openai.com/v1/responses/input_tokens and /v1/responses are answered
//   locally (only with an "sk-local-mock" bearer key); every other request to openai.com or *.openai.com (including
//   Request/URL-shaped objects of other fetch implementations that name it) is rejected with an error and never
//   forwarded; all other hosts go to the original fetch with the exact same arguments. Next.js wraps this fetch in its
//   own fetch patch when the server loads, so server actions and route handlers reach it.
// - One line per intercepted call in .local/logs/mock-openai.log (time, endpoint, json_schema name, model, request
//   bytes, scenario, HTTP status, or blocked / network-error / timeout / aborted / error for calls that end without
//   one): never keys, headers or payload content.
// Scenarios (.local/mock-openai-scenarios.json, re-read on every call) are documented in scripts/local-stack/README.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInputTokensResult, buildResponsesResult, describeRequest, INPUT_TOKENS_PATH, MOCK_KEY_PREFIX, MOCK_SCENARIOS, MockRequestError,
  OPENAI_API_HOST, parseScenarioConfig, RESPONSES_PATH, resolveScenario,
} from "./mock-openai-generator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const MOCK_SCENARIO_FILE = path.join(REPO_ROOT, ".local", "mock-openai-scenarios.json");
export const MOCK_LOG_FILE = path.join(REPO_ROOT, ".local", "logs", "mock-openai.log");
/** Files Next.js may load OPENAI_API_KEY from when the process environment does not define it. */
export const ENV_FILES = Object.freeze([
  ".env.development.local", ".env.production.local", ".env.test.local", ".env.local", ".env.development", ".env.production", ".env.test", ".env",
]);
const INSTALLED = Symbol.for("trading-os.mock-openai.installed");

export class MockOpenAiBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "MockOpenAiBlockedError";
  }
}

function readOptionalFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * dotenv's grammar exactly as @next/env 16.3.4 bundles it (dotenv 16 `parse`; its `(?:^|^)` and `(?:$|$)` written as
 * `^` and `$`), run over the whole file text like Next.js does: `KEY=value`, `KEY: value`, `export KEY=…`, a separator
 * or a quoted value on the following line, single, double or backtick quoted values spanning lines, trailing comments.
 */
const DOTENV_LINE = /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/gm;

/** Every value the dotenv grammar assigns to `name` in `text` (all of them, before ${VAR} expansion); never logged. */
export function dotenvValues(text, name) {
  const values = [];
  for (const match of String(text).replace(/\r\n?/g, "\n").matchAll(DOTENV_LINE)) {
    if (match[1] !== name) continue;
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, "$2");
    if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    values.push(value);
  }
  return values;
}

/** A line on which dotenv can assign OPENAI_API_KEY: the key first, after optional whitespace and `export`. */
const KEY_LINE = /^\s*(?:export\s+)?OPENAI_API_KEY(?![\w.-])/;
/** The only accepted form of such a line: one line, empty or sk-local-mock value, optionally quoted and commented. */
const SAFE_KEY_LINE = new RegExp(
  String.raw`^\s*(?:export\s+)?OPENAI_API_KEY(?:\s*=|:[ \t])[ \t]*(?:(["'\x60])(?:${MOCK_KEY_PREFIX}[^\s"'\x60]*)?\1|${MOCK_KEY_PREFIX}[^\s#"'\x60]*)?[ \t]*(?:#.*)?$`,
);

/**
 * Why a dotenv file is unsafe next to the mock, or null. Two independent checks, both fail closed: every value
 * Next.js's grammar assigns to OPENAI_API_KEY must be empty or start with "sk-local-mock" (trimmed, as the app reads
 * the key), and every line that can assign the key must be a single-line empty or sk-local-mock assignment, so a
 * grammar this module does not model (multi-line, separator on another line) is refused rather than trusted.
 */
export function envFileProblem(text) {
  const values = dotenvValues(text, "OPENAI_API_KEY").map(value => value.trim());
  if (values.some(value => value !== "" && !value.startsWith(MOCK_KEY_PREFIX))) return "defines OPENAI_API_KEY with a value that does not start with";
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  if (lines.some(line => KEY_LINE.test(line) && !SAFE_KEY_LINE.test(line))) return "assigns OPENAI_API_KEY in a form the mock cannot verify starts with";
  return null;
}

/**
 * Throws unless the environment is safe for the mock: not on Vercel, and OPENAI_API_KEY (or, when the process
 * environment leaves it unset, any .env file the app would load) is empty or starts with "sk-local-mock".
 * Messages never contain the key.
 */
export function assertMockEnvironment(env = process.env, { repoRoot = REPO_ROOT, readFile = readOptionalFile } = {}) {
  if (env.VERCEL || env.VERCEL_ENV) {
    throw new Error("mock-openai: refusing to start on Vercel. The OpenAI mock is local acceptance tooling only.");
  }
  const key = typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.trim() : "";
  if (key !== "") {
    if (!key.startsWith(MOCK_KEY_PREFIX)) {
      throw new Error(`mock-openai: refusing to start: OPENAI_API_KEY does not start with "${MOCK_KEY_PREFIX}". A real key must never be combined with MOCK_OPENAI=1; use OPENAI_API_KEY=${MOCK_KEY_PREFIX}-<anything>.`);
    }
    return;
  }
  for (const name of ENV_FILES) {
    const text = readFile(path.join(repoRoot, name));
    if (text === null || text === undefined) continue;
    const problem = envFileProblem(text);
    if (problem) {
      throw new Error(`mock-openai: refusing to start: ${name} ${problem} "${MOCK_KEY_PREFIX}" and the process environment does not override it. Set OPENAI_API_KEY=${MOCK_KEY_PREFIX}-<anything> in the environment, or keep only a single-line OPENAI_API_KEY= (empty) or ${MOCK_KEY_PREFIX} assignment in ${name}.`);
    }
  }
}

const normalizedHost = hostname => String(hostname).toLowerCase().replace(/\.+$/, "");

/** openai.com and every subdomain (trailing dots included): never forwarded while the mock is active. */
export function isOpenAiHost(hostname) {
  const host = normalizedHost(hostname);
  return host === "openai.com" || host.endsWith(".openai.com");
}

const isRequest = input => typeof Request === "function" && input instanceof Request;

/** The URL fetch() itself requests for this input: a string, a URL, a Request, or anything else stringified. */
function effectiveUrl(input) {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return new URL(input.href);
    if (isRequest(input)) return new URL(input.url);
    return input === undefined || input === null ? null : new URL(String(input));
  } catch {
    return null;
  }
}

/**
 * Every URL an input can stand for. Besides the effective URL, the `url`/`href` fields of objects are checked, so a
 * Request or URL of another realm or fetch implementation can never slip past the OpenAI check (fail closed).
 */
function candidateUrls(input) {
  const urls = [effectiveUrl(input)];
  if (typeof input === "object" && input !== null) {
    for (const key of ["url", "href"]) {
      try {
        if (typeof input[key] === "string") urls.push(new URL(input[key]));
      } catch {
        // Not a URL.
      }
    }
  }
  return urls.filter(url => url !== null);
}

function endpointOf(url, method) {
  const exact = url.protocol === "https:" && url.hostname === OPENAI_API_HOST && (url.port === "" || url.port === "443")
    && url.username === "" && url.password === "" && url.search === "" && method === "POST";
  if (!exact) return null;
  if (url.pathname === RESPONSES_PATH) return "responses";
  if (url.pathname === INPUT_TOKENS_PATH) return "input_tokens";
  return null;
}

function authorizationOf(input, init) {
  try {
    const source = init?.headers ?? (isRequest(input) ? input.headers : undefined);
    return new Headers(source ?? undefined).get("authorization");
  } catch {
    return null;
  }
}

async function bodyOf(input, init) {
  if (init && init.body !== undefined && init.body !== null) return typeof init.body === "string" ? init.body : new Response(init.body).text();
  if (isRequest(input)) return input.clone().text();
  return "";
}

/** Error text for the log `note`: one line, bounded, never request content (generator messages carry paths only). */
function noteOf(code, error) {
  const detail = String(error?.message ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 140);
  return detail ? `${code}:${detail}` : code;
}

/** Log fields of a request body: json_schema name, model and byte length (never content). */
function bodyFields(body) {
  return { ...describeRequest(body), bytes: Buffer.byteLength(body) };
}

/** Log status of a call that ended early: `timeout` (the provider's AbortSignal.timeout), `aborted` or `error`. */
function failureStatus(error, signal) {
  const reason = signal?.aborted ? signal.reason : error;
  if (reason?.name === "TimeoutError") return "timeout";
  return signal?.aborted || reason?.name === "AbortError" ? "aborted" : "error";
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function fileLogger(file) {
  let warned = false;
  return line => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${line}\n`);
    } catch (error) {
      if (!warned) {
        warned = true;
        process.emitWarning(`mock-openai: cannot write ${file}: ${error?.message ?? error}`);
      }
    }
  };
}

/** One log line: no keys, headers or payload content (the schema name and model are the only request fields). */
export function formatLogLine(at, fields) {
  const value = item => (item === null || item === undefined || item === "" ? "-" : String(item).replace(/\s+/g, "_"));
  const parts = [at.toISOString(), value(fields.method), value(fields.endpoint), `schema=${value(fields.schema)}`, `model=${value(fields.model)}`,
    `bytes=${value(fields.bytes)}`, `scenario=${value(fields.scenario)}`, `status=${value(fields.status)}`];
  if (fields.note) parts.push(`note=${value(fields.note)}`);
  return parts.join(" ");
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-mock-openai": "1" } });
}

/**
 * The fetch replacement. Injected dependencies keep it testable without a network: `originalFetch` receives every
 * non-OpenAI call unchanged, `readScenarioText` returns the scenario file text (null = missing), `log` receives one
 * line per intercepted call, `sleep(ms, signal)` implements delayMs.
 */
export function createMockFetch({
  originalFetch, scenarioFile = MOCK_SCENARIO_FILE, logFile = MOCK_LOG_FILE, readScenarioText, log, sleep = abortableSleep, now = () => new Date(),
} = {}) {
  if (typeof originalFetch !== "function") throw new TypeError("mock-openai: originalFetch must be a function");
  const readScenarios = readScenarioText ?? (() => readOptionalFile(scenarioFile));
  const writeLog = log ?? fileLogger(logFile);
  const record = fields => writeLog(formatLogLine(now(), fields));
  let responses = 0;

  return async function mockOpenAiFetch(...args) {
    const [input, init] = args;
    const openAi = candidateUrls(input).find(candidate => isOpenAiHost(candidate.hostname));
    if (!openAi) return originalFetch(...args);
    const url = effectiveUrl(input);
    const method = String(init?.method ?? (isRequest(input) ? input.method : "GET")).toUpperCase();
    // Only an input whose effective URL is exactly a mocked endpoint is answered; everything else is blocked.
    const endpoint = url && isOpenAiHost(url.hostname) ? endpointOf(url, method) : null;
    const where = `${normalizedHost(openAi.hostname)}${openAi.pathname}`;
    if (!endpoint) {
      record({ method, endpoint: where, scenario: "blocked", status: "blocked" });
      throw new MockOpenAiBlockedError(`mock-openai: blocked ${method} ${where}. Only POST ${OPENAI_API_HOST}${RESPONSES_PATH} and ${INPUT_TOKENS_PATH} are answered locally; nothing is forwarded to OpenAI.`);
    }
    if (!authorizationOf(input, init)?.startsWith(`Bearer ${MOCK_KEY_PREFIX}`)) {
      record({ method, endpoint: where, scenario: "blocked-key", status: "blocked" });
      throw new MockOpenAiBlockedError(`mock-openai: blocked a request without a "${MOCK_KEY_PREFIX}" API key; nothing is forwarded to OpenAI.`);
    }
    const signal = init?.signal ?? (isRequest(input) ? input.signal : undefined);
    // Exactly one line per intercepted call: `entry` collects the fields as they become known, and a call that ends
    // early (aborted, timed out during delayMs, unreadable body) is logged with what was known before it rejects.
    const entry = { method, endpoint: endpoint === "responses" ? RESPONSES_PATH : INPUT_TOKENS_PATH, schema: null, model: null, bytes: null, scenario: null, note: null };
    let logged = false;
    let delaying = 0;
    const finish = fields => {
      logged = true;
      record({ ...entry, ...fields });
    };
    try {
      signal?.throwIfAborted();
      const body = await bodyOf(input, init);
      Object.assign(entry, bodyFields(body));
      let choice;
      try {
        choice = resolveScenario(parseScenarioConfig(readScenarios()), entry.schema);
      } catch (error) {
        // A broken scenario file must be loud but must not hold budget: refusals carry usage and settle normally.
        choice = { scenario: "refusal", delayMs: 0 };
        entry.note = noteOf("invalid-scenario-file", error);
      }

      if (endpoint === "input_tokens") {
        entry.scenario = MOCK_SCENARIOS[choice.scenario]?.endpoint === "input_tokens" ? choice.scenario : "ok";
        const result = buildInputTokensResult(body, entry.scenario);
        finish({ status: result.status });
        return jsonResponse(result.status, result.body);
      }

      entry.scenario = MOCK_SCENARIOS[choice.scenario]?.endpoint === "responses" ? choice.scenario : "ok";
      if (choice.delayMs > 0) {
        delaying = choice.delayMs;
        await sleep(choice.delayMs, signal);
        signal?.throwIfAborted();
        delaying = 0;
      }
      if (entry.scenario === "network_error") {
        finish({ status: "network-error" });
        throw new TypeError("fetch failed (local mock scenario network_error)");
      }
      responses += 1;
      const options = { responseId: `resp_mock_${responses}`, createdAt: Math.floor(now().getTime() / 1000) };
      let result;
      try {
        result = buildResponsesResult(body, { ...options, scenario: entry.scenario });
      } catch (error) {
        if (error instanceof MockRequestError) {
          result = { status: 400, body: { error: { message: `mock-openai: ${error.message}`, type: "invalid_request_error", param: null, code: null } } };
          entry.note = "bad-request";
        } else {
          // A generator defect answers as a refusal (usage included) instead of an error that would hold budget.
          result = buildResponsesResult(body, { ...options, scenario: "refusal" });
          entry.note = noteOf("generator-error", error);
        }
      }
      finish({ status: result.status });
      return jsonResponse(result.status, result.body);
    } catch (error) {
      if (!logged) {
        // An abort before the body was read still names the schema when the body is a string (as provider.ts sends).
        if (entry.bytes === null && typeof init?.body === "string") Object.assign(entry, bodyFields(init.body));
        const status = failureStatus(error, signal);
        const note = status === "error" ? noteOf("failed", error) : delaying ? `during-delay-${delaying}ms` : entry.note;
        finish({ status, note });
      }
      throw error;
    }
  };
}

/**
 * Installs the mock on `target` (default globalThis) when env.MOCK_OPENAI === "1" and returns {fetch, uninstall};
 * returns null and changes nothing otherwise. Throws (before touching fetch) when the environment guards fail.
 */
export function installMockOpenAi({ env = process.env, target = globalThis, ...options } = {}) {
  if (env.MOCK_OPENAI !== "1") return null;
  assertMockEnvironment(env, options);
  const current = target.fetch;
  if (typeof current !== "function") throw new Error("mock-openai: fetch is not available in this runtime");
  if (current[INSTALLED]) return current[INSTALLED];
  const mockFetch = createMockFetch({ ...options, originalFetch: current });
  const handle = Object.freeze({
    fetch: mockFetch,
    uninstall() {
      if (target.fetch === mockFetch) target.fetch = current;
    },
  });
  Object.defineProperty(mockFetch, INSTALLED, { value: handle });
  target.fetch = mockFetch;
  return handle;
}

if (process.env.MOCK_OPENAI === "1") {
  installMockOpenAi();
  process.stderr.write(`[mock-openai] active (pid ${process.pid}): POST ${OPENAI_API_HOST}${RESPONSES_PATH} and ${INPUT_TOKENS_PATH} are answered locally; other OpenAI requests are blocked. Log: .local/logs/mock-openai.log\n`);
}
