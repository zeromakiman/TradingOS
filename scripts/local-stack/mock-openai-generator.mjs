// LOCAL ACCEPTANCE TOOLING ONLY (never Preview or production): a deterministic stand-in for the OpenAI Responses API.
//
// Pure module: no I/O, no globals, no network and no randomness. Every response is derived from the request body
// (its json_schema, the facts context and a hash of the body), so the same request always gets the same answer. The
// preload (mock-openai.mjs) owns fetch interception, the scenario file and the log; this module only builds bodies.
//
// What it produces for /v1/responses: an output instance generated from the request's text.format.schema (JSON
// Schema: $ref/$defs, anyOf/oneOf/allOf, enum/const, type arrays, properties/required/additionalProperties, items,
// minItems/maxItems, minLength/maxLength, pattern, minimum/maximum), with calm advisory text chosen per field, and
// per-contract post-processing so the app's server-side validators accept it (canonical citations, evidence status,
// the timeline hindsight guard and no-plan rules, the setup evaluator's provenance and decision rules).
import { createHash } from "node:crypto";

export const MOCK_KEY_PREFIX = "sk-local-mock";
export const OPENAI_API_HOST = "api.openai.com";
export const RESPONSES_PATH = "/v1/responses";
export const INPUT_TOKENS_PATH = "/v1/responses/input_tokens";
/** Count returned by the input_limit_exceeded scenario: above every reviewed operation's maxInputTokens. */
export const OVERSIZED_INPUT_TOKENS = 1_000_000;
/** One high-detail image under the tile formula is at most 85 + 8 × 170 tokens (768 × 2048 after scaling). */
export const MAX_IMAGE_TOKENS = 1445;
/** Citation used by the foreign_source scenario; never part of a real manifest. */
export const FOREIGN_SOURCE_ID = "trade:00000000-0000-4000-8000-000000000000";
/** Text used by the trading_directive scenario; matches the app's directive regex. */
export const DIRECTIVE_TEXT = "Take the trade at the next touch of the zone.";

function scenario(endpoint, providerError, description) {
  return Object.freeze({ endpoint, providerError, description });
}

/**
 * Scenarios selectable through .local/mock-openai-scenarios.json. `endpoint` is the call the scenario changes,
 * `providerError` the ProviderError code src/ai/provider.ts raises (null: the provider call succeeds and the app's
 * own validator decides).
 */
export const MOCK_SCENARIOS = Object.freeze({
  ok: scenario("responses", null, "Completed response; output_text is a schema-valid JSON instance generated from the request."),
  refusal: scenario("responses", "REFUSED", "Completed response whose message content is a refusal item; usage included."),
  incomplete: scenario("responses", "INCOMPLETE", "status incomplete (max_output_tokens) with a truncated output_text; usage charges max_output_tokens."),
  http_500: scenario("responses", "MODEL_ERROR", "HTTP 500 server_error body without usage."),
  http_429: scenario("responses", "RATE_LIMIT", "HTTP 429 rate_limit_exceeded body without usage."),
  http_401: scenario("responses", "OPENAI_AUTH", "HTTP 401 invalid_api_key body without usage."),
  http_403: scenario("responses", "MODEL_ACCESS", "HTTP 403 model access body without usage."),
  network_error: scenario("responses", "TIMEOUT_OR_NETWORK", "The mocked fetch rejects like a dropped connection; no usage."),
  invalid_json: scenario("responses", "INVALID_JSON", "Completed response whose output_text is plain text, not JSON; usage included."),
  schema_violation: scenario("responses", null, "Valid JSON that breaks the contract (first property removed, unknown property added)."),
  foreign_source: scenario("responses", null, "Valid output with one citation outside the request's allowed source ids."),
  hindsight_citation: scenario("responses", null, "Timeline review: thesisCheck cites an after-close record. Other schemas: same as foreign_source."),
  trading_directive: scenario("responses", null, "Valid output whose first text field is a trading directive."),
  count_unavailable: scenario("input_tokens", "INPUT_COUNT_UNAVAILABLE", "HTTP 503 from /v1/responses/input_tokens; generation is never called."),
  input_limit_exceeded: scenario("input_tokens", "INPUT_LIMIT_EXCEEDED", "input_tokens 1,000,000 (above every operation's limit); generation is never called."),
});

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const rec = value => (isRecord(value) ? value : {});
const arr = value => (Array.isArray(value) ? value : []);
const str = (value, fallback = "") => (typeof value === "string" && value.trim() !== "" ? value : fallback);
const utf8Bytes = text => Buffer.byteLength(text, "utf8");
const unique = values => [...new Set(values)];
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic integer in [0, n) for a seed and a key. */
function variant(seed, key, n) {
  return n > 1 ? fnv1a(`${seed}|${key}`) % n : 0;
}

/** Seed of one request: a hash of its exact body, so equal requests produce equal outputs. */
export function requestSeed(bodyText) {
  return createHash("sha256").update(String(bodyText)).digest("hex").slice(0, 16);
}

function nonNegativeInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** A recorded numeric value (string or number), as opposed to a missing one. */
function isRecordedNumber(value) {
  return (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) || (typeof value === "number" && Number.isFinite(value));
}

/** Relative difference above 0.1% between two recorded numeric strings (quoted values, never recalculated). */
function differsMaterially(planned, actual) {
  if (!isRecordedNumber(planned) || !isRecordedNumber(actual)) return false;
  const a = Number(planned);
  const b = Number(actual);
  return Math.abs(a - b) > Math.max(Math.abs(a), 1e-12) * 0.001;
}

/**
 * The recorded execution against the locked plan, from recorded values only (compared, never recalculated), shared
 * by Review Trade V1 and the timeline review so both read the same records the same way: DEVIATION when the entry
 * price differs or the fill size is above (`oversize`, the app's own flag, or the recorded quantities) or below the
 * planned quantity; ALIGNED when every comparable value matches; INSUFFICIENT_EVIDENCE when nothing is comparable.
 */
function compareExecution({ plannedEntry, entry, plannedQuantity, quantity, oversize }) {
  const entryKnown = isRecordedNumber(plannedEntry) && isRecordedNumber(entry);
  const sizeKnown = isRecordedNumber(plannedQuantity) && isRecordedNumber(quantity);
  const entryDiffers = entryKnown && differsMaterially(plannedEntry, entry);
  const sizeDiffers = sizeKnown && differsMaterially(plannedQuantity, quantity);
  const above = oversize === true || (sizeDiffers && Number(quantity) > Number(plannedQuantity));
  const below = !above && sizeDiffers && Number(quantity) < Number(plannedQuantity);
  const quoted = value => (isRecordedNumber(value) ? ` (${value})` : "");
  const size = above ? "above" : "below";
  const sizeClause = `the recorded fill size${quoted(quantity)} is ${size} the planned quantity${quoted(plannedQuantity)}`;
  const facts = { entryKnown, sizeKnown, entryDiffers, sizeAbove: above, sizeBelow: below };
  if (entryDiffers && (above || below)) {
    return { ...facts, assessment: "DEVIATION", text: `The recorded entry price${quoted(entry)} differs from the planned entry${quoted(plannedEntry)}, and ${sizeClause}; the values are quoted from the records, not recalculated.` };
  }
  if (above || below) {
    const capitalised = sizeClause[0].toUpperCase() + sizeClause.slice(1);
    return { ...facts, assessment: "DEVIATION", text: `${capitalised}, so the position differed from the locked plan${entryKnown ? " even though the entry followed it" : ""}.` };
  }
  if (entryDiffers) {
    return { ...facts, assessment: "DEVIATION", text: `The recorded entry price${quoted(entry)} differs from the planned entry${quoted(plannedEntry)}; the values are quoted from the records, not recalculated.` };
  }
  if (entryKnown && sizeKnown) return { ...facts, assessment: "ALIGNED", text: "The recorded entry and size match the locked plan." };
  if (entryKnown) return { ...facts, assessment: "ALIGNED", text: "The recorded entry matches the locked plan; no planned quantity is recorded to compare the size with." };
  if (sizeKnown) return { ...facts, assessment: "ALIGNED", text: "The recorded size matches the locked plan; no planned entry price is recorded to compare the entry with." };
  return { ...facts, assessment: "INSUFFICIENT_EVIDENCE", text: "The locked plan and the execution do not record comparable entry and size values, so the execution cannot be compared with the plan." };
}

// ---------------------------------------------------------------------------------------------------------------
// Token estimates
// ---------------------------------------------------------------------------------------------------------------

/** ceil(UTF-8 bytes / 4): the documented rough English-text estimate. */
export function textTokens(text) {
  return Math.ceil(utf8Bytes(String(text)) / 4);
}

/** Pixel size of a PNG, JPEG or WebP image, or null when the header cannot be read. */
export function imageDimensions(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("ascii", 12, 16) === "IHDR") {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  }
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
  }
  return null;
}

const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;

/**
 * Tokens of one input image. Base64 bytes are not text tokens: a high-detail image is priced by 512px tiles after
 * fitting it into 2048 × 2048 and scaling the shortest side down to 768 (85 + 170 per tile); low detail is 85.
 * Unreadable images count as the maximum, MAX_IMAGE_TOKENS.
 */
export function imageTokens(dataUrl, detail = "high") {
  if (detail === "low") return 85;
  const match = IMAGE_DATA_URL.exec(String(dataUrl));
  const size = match ? imageDimensions(Buffer.from(match[1], "base64")) : null;
  if (!size || !(size.width > 0) || !(size.height > 0)) return MAX_IMAGE_TOKENS;
  let { width, height } = size;
  const fit = Math.min(1, 2048 / Math.max(width, height));
  width *= fit;
  height *= fit;
  const shrink = Math.min(1, 768 / Math.min(width, height));
  width *= shrink;
  height *= shrink;
  return 85 + 170 * Math.ceil(width / 512) * Math.ceil(height / 512);
}

/**
 * Honest input estimate of a count body: ceil(UTF-8 bytes / 4) of the text, so oversized contexts are still refused
 * by the app's own limits. Data-URL images are counted with imageTokens() instead of by their base64 length (which
 * would make any real screenshot exceed every limit); without images this is exactly ceil(bytes / 4).
 */
export function estimateInputTokens(countBody) {
  const body = String(countBody);
  let payload = null;
  try {
    payload = JSON.parse(body);
  } catch {
    return textTokens(body);
  }
  let imageBytes = 0;
  let images = 0;
  for (const message of arr(rec(payload).input)) {
    for (const part of arr(rec(message).content)) {
      if (rec(part).type === "input_image" && typeof part.image_url === "string") {
        imageBytes += utf8Bytes(part.image_url);
        images += imageTokens(part.image_url, part.detail);
      }
    }
  }
  return Math.ceil(Math.max(0, utf8Bytes(body) - imageBytes) / 4) + images;
}

/** The count body src/ai/provider.ts sends for a generation payload (same fields, same order). */
export function countEquivalentBody(payload) {
  const p = rec(payload);
  return JSON.stringify({ model: p.model, instructions: p.instructions, input: p.input, reasoning: p.reasoning, text: p.text, truncation: p.truncation });
}

// ---------------------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------------------

export class MockRequestError extends Error {}

/** Schema name and model of a body, for the log only (never content). Unparseable bodies give nulls. */
export function describeRequest(bodyText) {
  try {
    const payload = rec(JSON.parse(String(bodyText)));
    const name = rec(rec(payload.text).format).name;
    return { schema: typeof name === "string" ? name : null, model: typeof payload.model === "string" ? payload.model : null };
  } catch {
    return { schema: null, model: null };
  }
}

function requestFacts(input) {
  for (const message of arr(input)) {
    for (const part of arr(rec(message).content)) {
      if (rec(part).type !== "input_text" || typeof part.text !== "string" || !part.text.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(part.text);
        if (isRecord(parsed) && Object.hasOwn(parsed, "context")) return { context: parsed.context, prior: arr(parsed.prior_evaluations) };
      } catch {
        // Not the facts item; keep looking.
      }
    }
  }
  return { context: null, prior: [] };
}

/** Parses a /v1/responses body as sent by src/ai/provider.ts. */
export function parseResponsesRequest(bodyText) {
  let payload;
  try {
    payload = JSON.parse(String(bodyText));
  } catch {
    throw new MockRequestError("The request body is not JSON.");
  }
  if (!isRecord(payload)) throw new MockRequestError("The request body must be a JSON object.");
  const format = rec(rec(payload.text).format);
  if (format.type !== "json_schema" || typeof format.name !== "string" || !isRecord(format.schema)) {
    throw new MockRequestError("The request has no text.format json_schema.");
  }
  const facts = requestFacts(payload.input);
  const maxOutput = payload.max_output_tokens;
  return {
    payload,
    model: typeof payload.model === "string" ? payload.model : "gpt-mock",
    name: format.name,
    schema: format.schema,
    context: facts.context,
    prior: facts.prior,
    maxOutputTokens: Number.isInteger(maxOutput) && maxOutput > 0 ? maxOutput : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Scenario configuration (.local/mock-openai-scenarios.json)
// ---------------------------------------------------------------------------------------------------------------

export class ScenarioConfigError extends Error {}
const MAX_DELAY_MS = 600_000;

function scenarioName(value, key) {
  if (typeof value !== "string" || !Object.hasOwn(MOCK_SCENARIOS, value)) {
    throw new ScenarioConfigError(`"${key}": unknown scenario ${JSON.stringify(value)}; expected one of ${Object.keys(MOCK_SCENARIOS).join(", ")}`);
  }
  return value;
}

function delayValue(value, key) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_DELAY_MS) {
    throw new ScenarioConfigError(`"${key}": delayMs must be an integer from 0 to ${MAX_DELAY_MS}`);
  }
  return value;
}

/**
 * Parses the scenario file text (null = file missing = everything "ok"). Shape: an object mapping a json_schema
 * name or "*" to a scenario name or {"scenario": name, "delayMs": n}, plus an optional top-level "delayMs".
 */
export function parseScenarioConfig(text) {
  const entries = new Map();
  if (text === null || text === undefined) return { entries, delayMs: 0 };
  let raw;
  try {
    raw = JSON.parse(String(text));
  } catch {
    throw new ScenarioConfigError("the scenario file is not valid JSON");
  }
  if (!isRecord(raw)) throw new ScenarioConfigError("the scenario file must contain a JSON object");
  let delayMs = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (key === "delayMs") {
      delayMs = delayValue(value, key);
    } else if (typeof value === "string") {
      entries.set(key, { scenario: scenarioName(value, key), delayMs: null });
    } else if (isRecord(value)) {
      const extra = Object.keys(value).filter(field => field !== "scenario" && field !== "delayMs");
      if (extra.length) throw new ScenarioConfigError(`"${key}": unknown fields ${extra.join(", ")}`);
      entries.set(key, {
        scenario: value.scenario === undefined ? "ok" : scenarioName(value.scenario, key),
        delayMs: value.delayMs === undefined ? null : delayValue(value.delayMs, key),
      });
    } else {
      throw new ScenarioConfigError(`"${key}" must be a scenario name or an object {"scenario", "delayMs"}`);
    }
  }
  return { entries, delayMs };
}

/** Scenario for one json_schema name: its own entry, else "*", else "ok". */
export function resolveScenario(config, schemaName) {
  const entries = config?.entries instanceof Map ? config.entries : new Map();
  const key = typeof schemaName === "string" && entries.has(schemaName) ? schemaName : entries.has("*") ? "*" : null;
  const entry = key === null ? null : entries.get(key);
  return { scenario: entry?.scenario ?? "ok", delayMs: entry?.delayMs ?? config?.delayMs ?? 0, matched: key };
}

// ---------------------------------------------------------------------------------------------------------------
// Text fitting
// ---------------------------------------------------------------------------------------------------------------

const FILLER = "The supplied records do not establish more than this.";

/** Cuts `value` to at most `max` characters at a sentence, else a word boundary, never below `min` characters. */
function truncateText(value, max, min = 0) {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  const slice = value.slice(0, max);
  const sentence = slice.lastIndexOf(". ");
  if (sentence >= Math.floor(max / 2) && sentence + 1 >= min) return slice.slice(0, sentence + 1);
  const space = slice.lastIndexOf(" ", max - 2);
  const head = (space > 0 ? slice.slice(0, space) : slice.slice(0, max - 1)).replace(/[\s,;:]+$/, "");
  const word = `${head}.`.slice(0, max);
  return word.length >= min ? word : slice;
}

/** Whitespace-normalised text within [min, max] characters, cut at a sentence or word boundary. */
export function fitText(text, min = 1, max = Number.POSITIVE_INFINITY) {
  let value = String(text ?? "").replace(/\s+/g, " ").trim();
  while (value.length < min) value = `${value} ${FILLER}`.trim();
  return truncateText(value, max, min);
}

// ---------------------------------------------------------------------------------------------------------------
// JSON Schema walking
// ---------------------------------------------------------------------------------------------------------------

function pointer(root, ref) {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) throw new Error(`mock-openai: unsupported $ref ${ref}`);
  let node = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(node) || !Object.hasOwn(node, key)) throw new Error(`mock-openai: unresolved $ref ${ref}`);
    node = node[key];
  }
  return node;
}

function makeResolver(root) {
  return node => {
    let current = node;
    for (let hops = 0; isRecord(current) && typeof current.$ref === "string"; hops++) {
      if (hops > 64) throw new Error(`mock-openai: $ref cycle at ${current.$ref}`);
      current = pointer(root, current.$ref);
    }
    return current;
  };
}

function typesOf(node) {
  if (Array.isArray(node.type)) return node.type.filter(type => typeof type === "string");
  if (typeof node.type === "string") return [node.type];
  if (isRecord(node.properties)) return ["object"];
  if (node.items !== undefined || Array.isArray(node.prefixItems)) return ["array"];
  return [];
}

function isNullSchema(node) {
  if (!isRecord(node)) return false;
  const types = typesOf(node);
  return (types.length === 1 && types[0] === "null") || (Array.isArray(node.enum) && node.enum.length === 1 && node.enum[0] === null);
}

/** String values a citation node allows: an enum, a const or an anyOf/oneOf of enum branches. */
function enumValues(node, resolve) {
  const n = resolve(node);
  if (!isRecord(n)) return null;
  if (Array.isArray(n.enum)) return n.enum.filter(value => typeof value === "string");
  if (typeof n.const === "string") return [n.const];
  const union = n.anyOf ?? n.oneOf;
  if (Array.isArray(union)) {
    const parts = union.map(branch => enumValues(branch, resolve));
    return parts.every(Array.isArray) ? unique(parts.flat()) : null;
  }
  return null;
}

function itemsOf(node) {
  if (Array.isArray(node.items)) return node.items[0];
  if (node.items !== undefined) return node.items;
  return Array.isArray(node.prefixItems) ? node.prefixItems[0] : undefined;
}

const keyOf = path => path.map(part => (typeof part === "number" ? "*" : part)).join(".");

/**
 * Constraint slots by normalised path ("headline.text", "patterns.*.sourceRefs", "limitations.*"): string length
 * bounds, array bounds and, for every sourceRefs array, the citation ids its item schema allows.
 */
function scanSlots(root, resolve) {
  const slots = new Map();
  const merge = (key, values) => slots.set(key, { ...slots.get(key), ...values });
  const visit = (node, path, stack) => {
    const n = resolve(node);
    if (!isRecord(n) || stack.includes(n) || path.length > 32) return;
    const next = [...stack, n];
    const key = keyOf(path);
    for (const branch of [...arr(n.anyOf), ...arr(n.oneOf), ...arr(n.allOf)]) visit(branch, path, next);
    const types = typesOf(n);
    if (types.includes("string")) {
      merge(key, { minLength: nonNegativeInt(n.minLength, 0), maxLength: nonNegativeInt(n.maxLength, Number.POSITIVE_INFINITY) });
    }
    const items = itemsOf(n);
    if (types.includes("array") || items !== undefined) {
      const allowed = path[path.length - 1] === "sourceRefs" && items !== undefined ? enumValues(items, resolve) : null;
      merge(key, { minItems: nonNegativeInt(n.minItems, 0), maxItems: nonNegativeInt(n.maxItems, Number.POSITIVE_INFINITY), allowed });
      if (items !== undefined) visit(items, [...path, 0], next);
    }
    if (isRecord(n.properties)) for (const [name, child] of Object.entries(n.properties)) visit(child, [...path, name], next);
  };
  visit(root, [], []);
  return slots;
}

function mergeSchemas(parts) {
  const merged = { type: undefined, properties: {}, required: [] };
  for (const part of parts) {
    if (!isRecord(part)) continue;
    merged.type ??= part.type;
    Object.assign(merged.properties, rec(part.properties));
    merged.required.push(...arr(part.required));
    for (const [key, value] of Object.entries(part)) if (!Object.hasOwn(merged, key)) merged[key] = value;
  }
  if (merged.type === undefined) merged.type = "object";
  return merged;
}

/** Validation errors of a value against a JSON Schema (the keywords generated above); empty means valid. */
export function schemaErrors(value, root) {
  const resolve = makeResolver(root);
  const check = (node, v, at, out, depth) => {
    if (out.length > 25 || depth > 64) return;
    const n = resolve(node);
    if (n === false) out.push(`${at}: no value is allowed`);
    if (!isRecord(n)) return;
    const same = other => JSON.stringify(other) === JSON.stringify(v);
    if (n.const !== undefined && !same(n.const)) out.push(`${at}: must equal ${JSON.stringify(n.const)}`);
    // Messages name paths and keywords only, never values: they can reach the mock's log as a note.
    if (Array.isArray(n.enum) && !n.enum.some(same)) out.push(`${at}: value is not in the enum`);
    for (const part of arr(n.allOf)) check(part, v, at, out, depth + 1);
    for (const [keyword, union] of [["anyOf", n.anyOf], ["oneOf", n.oneOf]]) {
      if (!Array.isArray(union)) continue;
      const passing = union.filter(branch => {
        const errors = [];
        check(branch, v, at, errors, depth + 1);
        return errors.length === 0;
      }).length;
      if (keyword === "anyOf" ? passing === 0 : passing !== 1) out.push(`${at}: ${keyword} matched ${passing} branches`);
    }
    const types = typesOf(n);
    const typeOk = type => (type === "null" ? v === null : type === "array" ? Array.isArray(v) : type === "object" ? isRecord(v)
      : type === "integer" ? Number.isInteger(v) : type === "number" ? typeof v === "number" && Number.isFinite(v) : typeof v === type);
    if (types.length && !types.some(typeOk)) {
      out.push(`${at}: expected ${types.join("|")}`);
      return;
    }
    if (typeof v === "string") {
      const length = [...v].length;
      if (Number.isInteger(n.minLength) && length < n.minLength) out.push(`${at}: shorter than ${n.minLength}`);
      if (Number.isInteger(n.maxLength) && length > n.maxLength) out.push(`${at}: longer than ${n.maxLength}`);
      if (typeof n.pattern === "string" && !new RegExp(n.pattern, "u").test(v)) out.push(`${at}: does not match ${n.pattern}`);
    }
    if (typeof v === "number") {
      if (typeof n.minimum === "number" && v < n.minimum) out.push(`${at}: below minimum`);
      if (typeof n.maximum === "number" && v > n.maximum) out.push(`${at}: above maximum`);
      if (typeof n.exclusiveMinimum === "number" && v <= n.exclusiveMinimum) out.push(`${at}: not above exclusiveMinimum`);
      if (typeof n.exclusiveMaximum === "number" && v >= n.exclusiveMaximum) out.push(`${at}: not below exclusiveMaximum`);
    }
    if (Array.isArray(v)) {
      if (Number.isInteger(n.minItems) && v.length < n.minItems) out.push(`${at}: fewer than ${n.minItems} items`);
      if (Number.isInteger(n.maxItems) && v.length > n.maxItems) out.push(`${at}: more than ${n.maxItems} items`);
      if (n.uniqueItems === true && new Set(v.map(item => JSON.stringify(item))).size !== v.length) out.push(`${at}: items are not unique`);
      const items = itemsOf(n);
      if (items !== undefined) for (const [index, item] of v.entries()) check(items, item, `${at}[${index}]`, out, depth + 1);
    }
    if (isRecord(v)) {
      const properties = rec(n.properties);
      for (const key of arr(n.required)) if (!Object.hasOwn(v, key)) out.push(`${at}: missing ${key}`);
      for (const [key, item] of Object.entries(v)) {
        if (Object.hasOwn(properties, key)) check(properties[key], item, `${at}.${key}`, out, depth + 1);
        else if (n.additionalProperties === false) out.push(`${at}: unexpected property ${key}`);
        else if (isRecord(n.additionalProperties)) check(n.additionalProperties, item, `${at}.${key}`, out, depth + 1);
      }
    }
  };
  const errors = [];
  check(root, value, "$", errors, 0);
  return errors;
}

// ---------------------------------------------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------------------------------------------

/**
 * Picks citation ids from `allowed` (the request schema's enum, so every id is valid by construction). `wanted`
 * lists exact ids or prefix wildcards ("trade:*" takes one matching id, rotated so items cite different records).
 * Duplicates are removed, at most three ids are kept (more only when minItems demands it) and the list is filled up
 * to minItems from the allowed ids in order.
 */
export function resolveRefs(wanted, allowed, minItems = 1, maxItems = Number.POSITIVE_INFINITY, rotation = 0) {
  const out = [];
  const add = id => {
    if (allowed.includes(id) && !out.includes(id)) out.push(id);
  };
  for (const pattern of arr(wanted)) {
    if (typeof pattern !== "string") continue;
    if (pattern.endsWith("*")) {
      const matches = allowed.filter(id => id.startsWith(pattern.slice(0, -1)) && !out.includes(id));
      if (matches.length) add(matches[rotation % matches.length]);
    } else {
      add(pattern);
    }
  }
  const cap = Math.min(maxItems, Math.max(minItems, 3));
  out.splice(cap);
  for (let i = 0; out.length < Math.min(minItems, maxItems) && i < allowed.length; i++) add(allowed[(rotation + i) % allowed.length]);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------------------------

function uuidFor(seed, key) {
  const hex = [0, 1, 2, 3].map(part => fnv1a(`${seed}|${key}|${part}`).toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function patternString(g, pattern, path, min, max) {
  let re = null;
  try {
    re = new RegExp(pattern, "u");
  } catch {
    re = new RegExp(pattern);
  }
  const candidates = ["0", "1", "1.0", "0.5", "0".repeat(64), "a".repeat(64), uuidFor(g.seed, keyOf(path)), "2026-01-01", "2026-01-01T00:00:00Z", "A", "a", "x", "mock"];
  const hit = candidates.find(candidate => candidate.length >= min && candidate.length <= max && re.test(candidate));
  if (hit === undefined) throw new Error(`mock-openai: cannot satisfy pattern ${pattern} at ${keyOf(path)}`);
  return hit;
}

function formatString(g, format, path) {
  if (format === "uuid") return uuidFor(g.seed, keyOf(path));
  if (format === "date-time") return "2026-01-01T00:00:00.000Z";
  if (format === "date") return "2026-01-01";
  if (format === "time") return "00:00:00";
  if (format === "email") return "mock@example.test";
  if (format === "uri" || format === "url") return "https://example.test/mock";
  return null;
}

function generateNumber(node, integer) {
  const step = integer ? 1 : 1e-6;
  let low = typeof node.minimum === "number" ? node.minimum : Number.NEGATIVE_INFINITY;
  let high = typeof node.maximum === "number" ? node.maximum : Number.POSITIVE_INFINITY;
  if (typeof node.exclusiveMinimum === "number") low = Math.max(low, node.exclusiveMinimum + step);
  if (node.exclusiveMinimum === true && Number.isFinite(low)) low += step;
  if (typeof node.exclusiveMaximum === "number") high = Math.min(high, node.exclusiveMaximum - step);
  if (node.exclusiveMaximum === true && Number.isFinite(high)) high -= step;
  let value = Number.isFinite(low) ? low : Math.min(0, high);
  if (integer) value = Math.ceil(value);
  if (typeof node.multipleOf === "number" && node.multipleOf > 0) value = Math.ceil(value / node.multipleOf) * node.multipleOf;
  return value;
}

const GENERIC_TEXT = {
  summary: [
    "The supplied records describe a small sample, so the observations below are tentative.",
    "The selected records support only tentative observations; nothing beyond them is assumed.",
  ],
  limitation: ["Only the supplied records were reviewed.", "Evidence outside this request was not available."],
  question: ["What recorded evidence would change this assessment?", "Which supplied record best supports the stated thesis?"],
  lesson: [
    "Keep recording plans, notes and exits so later reviews can separate process from outcome.",
    "Write the invalidation into each plan so the review can compare it with the execution.",
  ],
  reason: ["Assessed from the supplied records only; no additional evidence is assumed.", "The supplied records do not establish more than this."],
  locator: ["Supplied record"],
  other: [
    "The supplied records support only a tentative observation here; nothing beyond them is assumed.",
    "This observation is limited to the recorded facts in the request and is not a new fact.",
    "The available records do not establish more than this; the evidence is limited to what was supplied.",
  ],
};

function genericText(g, path) {
  const name = [...path].reverse().find(part => typeof part === "string") ?? "";
  const kind = /summary|headline/i.test(name) ? "summary" : /limitation/i.test(name) ? "limitation" : /question/i.test(name) ? "question"
    : /lesson|focus|monitor/i.test(name) ? "lesson" : /locator/i.test(name) ? "locator"
      : /rationale|reason|description|statement|explanation/i.test(name) ? "reason" : "other";
  const list = GENERIC_TEXT[kind];
  const index = typeof path[path.length - 1] === "number" ? path[path.length - 1] : 0;
  return list[(variant(g.seed, keyOf(path), list.length) + index) % list.length];
}

/** Applicable bank entries of a top-level field: pinned ones first, the rest rotated by the request seed. */
function bankEntries(g, field) {
  if (g.cache.has(field)) return g.cache.get(field);
  const raw = arr(rec(g.plan.entries)[field]).filter(entry => !entry.when || entry.when(g.facts));
  const concrete = raw.map(entry => ({
    text: typeof entry.text === "function" ? entry.text(g.facts) : entry.text,
    refs: typeof entry.refs === "function" ? entry.refs(g.facts) : arr(entry.refs),
    pinned: typeof entry.pin === "function" ? entry.pin(g.facts) : entry.pin === true,
  }));
  const pinned = concrete.filter(entry => entry.pinned);
  const rest = concrete.filter(entry => !entry.pinned);
  const offset = variant(g.seed, field, rest.length);
  const ordered = [...pinned, ...rest.slice(offset), ...rest.slice(0, offset)];
  g.cache.set(field, ordered);
  return ordered;
}

function entryAt(g, objectPath) {
  if (objectPath.length === 0 || objectPath.length > 2) return null;
  const [field, index = 0] = objectPath;
  if (typeof field !== "string" || typeof index !== "number") return null;
  const list = bankEntries(g, field);
  return list.length ? list[index % list.length] : null;
}

function textFor(g, path) {
  const last = path[path.length - 1];
  if ((last === "text" || last === "interpretation") && path.length >= 2) {
    const entry = entryAt(g, path.slice(0, -1));
    if (entry) return entry.text;
  }
  const strings = arr(rec(g.plan.strings)[path[0]]).filter(entry => !entry.when || entry.when(g.facts));
  if (strings.length && path.length === 2 && typeof last === "number") {
    const entry = strings[(variant(g.seed, path[0], strings.length) + last) % strings.length];
    return typeof entry.text === "function" ? entry.text(g.facts) : entry.text;
  }
  return genericText(g, path);
}

function arrayCount(g, path, min, max) {
  let count = path.length === 1 ? 2 : 1;
  if (path.length === 1 && typeof path[0] === "string") {
    const configured = rec(g.plan.count)[path[0]];
    if (Number.isInteger(configured)) count = configured;
    else if (Array.isArray(configured)) count = configured[0] + variant(g.seed, `${path[0]}#count`, configured[1] - configured[0] + 1);
    const bank = bankEntries(g, path[0]);
    if (bank.length) count = Math.min(count, bank.length);
  }
  return clamp(count, min, max);
}

function generateNode(g, node, path, depth = 0) {
  if (depth > 64) throw new Error("mock-openai: schema nesting is too deep");
  const n = g.resolve(node);
  if (!isRecord(n)) return null;
  if (n.const !== undefined) return structuredClone(n.const);
  if (Array.isArray(n.enum) && n.enum.length) {
    const preferred = rec(g.plan.enums)[keyOf(path)];
    return n.enum.includes(preferred) ? preferred : n.enum.find(value => value !== null) ?? n.enum[0];
  }
  const union = Array.isArray(n.anyOf) && n.anyOf.length ? n.anyOf : Array.isArray(n.oneOf) && n.oneOf.length ? n.oneOf : null;
  if (union) {
    const branches = union.map(g.resolve);
    return generateNode(g, branches.find(branch => !isNullSchema(branch)) ?? branches[0], path, depth + 1);
  }
  if (Array.isArray(n.allOf) && n.allOf.length) return generateNode(g, mergeSchemas(n.allOf.map(g.resolve)), path, depth + 1);
  const types = typesOf(n);
  const type = types.find(candidate => candidate !== "null") ?? types[0];
  if (type === "object") {
    const out = {};
    for (const [key, child] of Object.entries(rec(n.properties))) out[key] = generateNode(g, child, [...path, key], depth + 1);
    return out;
  }
  if (type === "array") {
    const min = nonNegativeInt(n.minItems, 0);
    const max = nonNegativeInt(n.maxItems, Number.POSITIVE_INFINITY);
    const slot = g.slot(keyOf(path));
    if (Array.isArray(slot.allowed)) {
      const entry = entryAt(g, path.slice(0, -1));
      return resolveRefs(entry?.refs ?? [], slot.allowed, min, max, variant(g.seed, keyOf(path), 997) + (typeof path[1] === "number" ? path[1] : 0));
    }
    const items = itemsOf(n);
    const count = arrayCount(g, path, min, max);
    const out = [];
    for (let i = 0; i < count; i++) out.push(items === undefined ? null : generateNode(g, items, [...path, i], depth + 1));
    return out;
  }
  if (type === "string") {
    const min = nonNegativeInt(n.minLength, 0);
    const max = nonNegativeInt(n.maxLength, Number.POSITIVE_INFINITY);
    if (typeof n.pattern === "string") return patternString(g, n.pattern, path, min, max);
    const formatted = typeof n.format === "string" ? formatString(g, n.format, path) : null;
    if (formatted !== null) return formatted;
    return fitText(textFor(g, path), Math.max(min, 1), max);
  }
  if (type === "integer" || type === "number") return generateNumber(n, type === "integer");
  if (type === "boolean") return rec(g.plan.booleans)[keyOf(path)] === true;
  return null;
}

function createGeneration(schema, plan, request) {
  const resolve = makeResolver(schema);
  const slots = scanSlots(schema, resolve);
  const g = {
    schema, plan, resolve, slots, cache: new Map(),
    seed: String(request.seed ?? "0"), name: request.name, context: request.context ?? null, prior: arr(request.prior),
  };
  g.facts = typeof plan.facts === "function" ? plan.facts(rec(g.context), g) : {};
  g.slot = key => slots.get(key) ?? {};
  g.fit = (key, text) => {
    const slot = g.slot(key);
    return fitText(text, Math.max(slot.minLength ?? 1, 1), slot.maxLength ?? Number.POSITIVE_INFINITY);
  };
  g.refs = (key, wanted, rotation = 0) => {
    const slot = g.slot(key);
    return resolveRefs(wanted, arr(slot.allowed), slot.minItems ?? 1, slot.maxItems ?? Number.POSITIVE_INFINITY, rotation);
  };
  g.items = (key, list) => list.slice(0, Math.max(0, g.slot(key).maxItems ?? list.length));
  return g;
}

// ---------------------------------------------------------------------------------------------------------------
// Contract plans: facts, text banks (text + citation preferences per field) and post-processing
// ---------------------------------------------------------------------------------------------------------------

const directionWord = value => (value === "LONG" ? "long" : value === "SHORT" ? "short" : "recorded");
const modelWord = value => (value === "OB_FIRST_TOUCH" ? "order block first-touch" : value === "OTE" ? "OTE" : "recorded");
const sessionWord = value => str(value, "recorded").toLowerCase().replaceAll("_", " ");

function preTradeFacts(ctx) {
  const proposal = rec(ctx.proposal);
  const deterministic = rec(ctx.deterministic);
  const evidence = arr(ctx.selectedEvidence);
  return {
    instrument: str(proposal.instrument, "instrument"),
    direction: directionWord(proposal.direction),
    model: modelWord(proposal.entryModel),
    ote: proposal.entryModel === "OTE",
    evidence: evidence.length,
    blocked: deterministic.status === "TRADE_BLOCKED",
    warnings: arr(deterministic.issues).filter(issue => rec(issue).severity === "WARN").length,
    session: sessionWord(deterministic.session),
    strategy: str(rec(ctx.strategy).version, "the supplied strategy"),
  };
}

const ANALYZE_SETUP = {
  facts: preTradeFacts,
  count: { confluences: 2, weaknesses: [2, 3], invalidation: [1, 2], observations: [1, 2] },
  entries: {
    setupStructure: [
      { text: f => `The saved ${f.instrument} ${f.direction} proposal defines an entry, a stop and a target for the ${f.model} model. The structure described in the thesis is user-reported; the supplied records do not verify it independently.`, refs: ["proposal", "currentThesis"] },
      { text: f => `The recorded proposal frames a ${f.direction} ${f.instrument} setup around the ${f.model} model, with the entry, stop and target taken from the saved draft. ${f.evidence ? "The selected screenshots illustrate the area the thesis describes but do not establish the earlier price history." : "No screenshot was selected, so the structure rests on the written thesis alone."}`, refs: ["proposal", "evidence:*", "currentThesis"] },
    ],
    entryModelAssessment: [
      { text: f => `The recorded plan follows the selected strategy's ${f.model} entry model as written; whether the zone was untouched before the entry cannot be confirmed from the supplied records.`, refs: ["strategy", "proposal"] },
      { text: f => `The ${f.model} model is assessed only against the supplied strategy definition (${f.strategy}). Evidence for the higher-timeframe bias is limited to ${f.evidence ? "the selected screenshots" : "the written thesis"}.`, refs: ["strategy", "evidence:*", "currentThesis"] },
    ],
    confluences: [
      { when: f => f.evidence > 0, text: "The selected screenshot shows the structure the thesis refers to; it is the user's chart, not verified market data.", refs: ["evidence:*", "currentThesis"] },
      { text: "The recorded target sits at the liquidity named in the thesis, so the draw on liquidity is stated before the entry.", refs: ["proposal", "currentThesis"] },
      { text: "The thesis names a condition that would invalidate the idea, which keeps the plan reviewable afterwards.", refs: ["currentThesis"] },
      { when: f => f.evidence === 0, pin: true, text: "No confluence is established by the supplied records beyond the written thesis.", refs: ["currentThesis"] },
    ],
    weaknesses: [
      { when: f => f.evidence === 0, pin: true, text: "Visual evidence was not supplied, so the reported sweep, displacement and first touch rest on the narrative alone.", refs: ["currentThesis"] },
      { when: f => f.blocked, pin: true, text: "The recorded Risk Engine result blocks this proposal; this analysis does not change that result.", refs: ["deterministic"] },
      { when: f => f.evidence > 0, text: "Higher-timeframe context is limited to the selected screenshots; the wider premium or discount position is not shown.", refs: ["evidence:*"] },
      { text: "The pre-market direction is the user's assumption in the thesis and is not verified by the supplied records.", refs: ["currentThesis"] },
      { when: f => !f.blocked && f.warnings > 0, text: "The recorded Risk Engine warnings remain in effect; this analysis does not resolve them.", refs: ["deterministic"] },
    ],
    invalidation: [
      { text: f => `A documented earlier touch of the zone would contradict the ${f.ote ? "OTE conditions" : "first-touch condition"} of the supplied strategy.`, refs: ["strategy", "proposal"] },
      { text: "A close back through the reported sweep extreme on the setup timeframe would contradict the structure described in the thesis.", refs: ["currentThesis"] },
      { text: "If the liquidity named as the target was already taken before the entry, the stated draw on liquidity would no longer apply.", refs: ["currentThesis", "proposal"] },
    ],
    observations: [
      { text: "The thesis states both the reason for the setup and what would invalidate it, which makes a later review straightforward.", refs: ["currentThesis"] },
      { text: f => (f.blocked ? "The recorded Risk Engine block remains in effect; these observations describe the process only." : "The recorded Risk Engine result remains authoritative; these observations describe the process only."), refs: ["deterministic"] },
      { text: f => `The recorded session (${f.session}) comes from the risk check, not from current market data.`, refs: ["deterministic"] },
    ],
  },
  finalize(out, g) {
    out.evidenceStatus = g.facts.evidence > 0 ? "SELECTED_NOT_INDEPENDENTLY_VERIFIED" : "NONE_SELECTED";
  },
};

const CHALLENGE_BIAS = {
  facts: preTradeFacts,
  count: { invalidation: 2, missingEvidence: [1, 2], questions: 2 },
  entries: {
    counterArgument: [
      { text: f => `The thesis treats the reported sweep as confirmation for the ${f.direction} idea, but a sweep can also start a deeper move toward higher-timeframe liquidity. Nothing in the supplied records rules out that alternative.`, refs: ["currentThesis", "proposal"] },
      { text: f => `The ${f.direction} bias relies on a pre-market direction that the thesis itself presents as an assumption. ${f.blocked ? "The recorded Risk Engine block also remains unresolved." : "The recorded Risk Engine result does not address the bias."}`, refs: ["currentThesis", "deterministic"] },
    ],
    invalidation: [
      { text: f => `If the zone was already touched earlier in the session, the ${f.model} condition of the strategy would no longer hold.`, refs: ["strategy", "proposal"] },
      { text: "A close back through the reported sweep extreme would show that the described structure shift did not hold.", refs: ["currentThesis"] },
      { text: "Evidence that the target liquidity was taken before the entry would remove the stated reason for the setup.", refs: ["proposal", "currentThesis"] },
    ],
    missingEvidence: [
      { pin: true, text: f => (f.evidence ? "The selected charts show the setup timeframe only; no higher-timeframe chart supports the stated bias." : "No chart is selected, so the reported sweep and displacement are unverified."), refs: ["evidence:*", "currentThesis"] },
      { text: "The pre-market context is user-reported only; no supplied record verifies it.", refs: ["currentThesis"] },
    ],
    questions: [
      { text: "What would you need to see on the higher timeframe to abandon the bias before the plan is locked?", refs: ["currentThesis"] },
      { text: "Is the target the nearest opposing liquidity, or is there an untested level before it?", refs: ["proposal", "currentThesis"] },
      { text: "Which recorded observation distinguishes this setup from the alternative explanation above?", refs: ["currentThesis", "strategy"] },
    ],
  },
};

function periodicFacts(ctx) {
  const sample = rec(ctx.sample);
  const trades = arr(ctx.trades).filter(isRecord);
  const count = Number.isInteger(sample.count) ? sample.count : Number.isInteger(sample.actual) ? sample.actual : trades.length;
  const notes = trades.flatMap(trade => arr(trade.events)).filter(event => rec(event).event_type === "NOTE_ADDED").length;
  return {
    count,
    small: count < 30,
    notes,
    requested: Number.isInteger(sample.requested) ? sample.requested : count,
    fewer: sample.fewerThanRequested === true,
    summaryMode: ctx.mode === "DETERMINISTIC SUMMARY",
  };
}

const WEEKLY_REVIEW = {
  facts: periodicFacts,
  count: { processQuality: [1, 2], ruleAdherence: 1, setupModelPatterns: 1, executionMistakes: 1, behavioralPatterns: 1, whatImproved: 1, needsAttention: [1, 2], focusNextWeek: 1 },
  entries: {
    weekSummary: [
      { text: f => `${plural(f.count, "completed trade")} ${f.count === 1 ? "is" : "are"} recorded for the selected week. ${f.small ? "The sample is small, so every observation below is tentative." : "One week cannot establish a recurring habit, so observations describe this week only."}`, refs: ["period", "sample"] },
      { text: f => `The selected week contains ${plural(f.count, "completed trade")} from ${f.count === 1 ? "a locked plan" : "locked plans"}. The patterns described below are tentative and do not establish improvement versus other weeks.`, refs: ["sample", "period"] },
    ],
    processQuality: [
      { text: "Each included trade has a locked plan with a written thesis recorded before the entry.", refs: ["trade:*", "trade:*"] },
      { text: "Plans, versions and executions are linked for every included trade, which keeps the review traceable.", refs: ["sample", "trade:*"] },
    ],
    ruleAdherence: [
      { text: "The recorded executions stay within the sealed risk versions of their plans; no rule exception is visible in the supplied records.", refs: ["trade:*"] },
      { text: "No recorded event shows a change to the stop or target outside the supplied rules.", refs: ["trade:*", "event:*"] },
    ],
    setupModelPatterns: [
      { text: "The entry models used this week match the strategy definitions attached to each plan; the sample is too small to compare them.", refs: ["edge", "sample"] },
      { text: "No setup pattern can be established from this number of trades.", refs: ["sample"] },
    ],
    executionMistakes: [
      { text: "No execution mistake can be established from the recorded events alone; notes written during the trades are sparse.", refs: ["sample", "trade:*"] },
      { text: "The recorded fills match the planned entries; no execution deviation is visible in the supplied records.", refs: ["trade:*"] },
    ],
    behavioralPatterns: [
      { text: f => (f.notes ? "The recorded notes describe waiting for the planned model; one week cannot establish a recurring behavioral pattern." : "No notes were recorded during the week, and the absence of a note is not evidence of a mistake."), refs: ["event:*", "sample"] },
      { text: "No recurring behavior can be established from one week of records.", refs: ["sample"] },
    ],
    whatImproved: [
      { text: "Improvement cannot be established from this sample; no comparable earlier week is supplied.", refs: ["sample"] },
    ],
    needsAttention: [
      { text: "Record a short note when a position is managed or closed before the target, so the reason can be reviewed later.", refs: ["trade:*"] },
      { text: "Keep the thesis and its invalidation in every plan; it is the main evidence for process reviews.", refs: ["sample"] },
    ],
    focusNextWeek: [
      { text: "Keep writing the invalidation in every thesis and add one note per trade while it is live.", refs: ["sample"] },
      { text: "Continue recording plans before the entry and compare each execution with its locked plan.", refs: ["sample"] },
    ],
  },
};

const RECENT_TRADES = {
  facts: periodicFacts,
  count: { strengths: [1, 2], executionMistakes: 1, entryModelPatterns: 1, sessionPatterns: 1, processDiscipline: [1, 2], behavioralPatterns: 1, outliers: 1, monitorNext: [1, 2] },
  entries: {
    strengths: [
      { text: "Every included trade has a locked plan and a recorded execution, so plan and result can be compared directly.", refs: ["sample", "trade:*"] },
      { text: "The recorded entries follow the entry models defined in the attached strategy versions.", refs: ["strategy:*", "trade:*"] },
    ],
    executionMistakes: [
      { text: f => `With ${plural(f.count, "trade")} in the sample, no recurring execution mistake can be established from the recorded events.`, refs: ["sample", "trade:*"] },
      { text: "No recorded event shows an entry outside the planned price or size.", refs: ["trade:*"] },
    ],
    entryModelPatterns: [
      { text: "The sample is too small to compare the order block and OTE models; any difference would be tentative.", refs: ["edge", "sample"] },
      { text: "Entry models match the plans' strategy versions in every included trade.", refs: ["strategy:*", "trade:*"] },
    ],
    sessionPatterns: [
      { text: "The recorded entry sessions are too few to establish a session pattern.", refs: ["sample", "trade:*"] },
      { text: "Session timing is taken from the persisted entry times; no session can be singled out from this sample.", refs: ["trade:*"] },
    ],
    processDiscipline: [
      { pin: true, text: f => `${f.fewer ? `Fewer completed trades are available than the ${f.requested} requested, so the sample holds ${plural(f.count, "trade")}. ` : ""}The included trades were planned and locked before the entry, and their risk versions are attached.`, refs: ["sample", "risk:*"] },
      { text: "Recorded risk stayed within the sealed risk versions of the included plans.", refs: ["risk:*", "trade:*"] },
    ],
    behavioralPatterns: [
      { text: "No recurring behavior can be established; notes are recorded for only part of the sample.", refs: ["event:*", "sample"] },
      { text: "The recorded notes describe the planned process; motives are not inferred from outcomes.", refs: ["event:*", "trade:*"] },
    ],
    outliers: [
      { text: "A single recorded result is not sufficient to define an outlier; values are taken from the persisted realized R only.", refs: ["edge", "sample"] },
    ],
    monitorNext: [
      { text: "Monitor whether each trade keeps a written invalidation and one live note, not market outcomes.", refs: ["sample"] },
      { text: "Keep recording exits with a short reason so future samples can separate process from outcome.", refs: ["sample", "trade:*"] },
    ],
  },
};

const detailed = f => !f.summaryMode;
const summary = f => f.summaryMode;
const MONTHLY_REVIEW = {
  facts: periodicFacts,
  count: { processQuality: 1, ruleAdherence: 1, entryModelPatterns: 1, sessionPatterns: 1, executionQuality: 1, behavioralPatterns: 1, recurringStrengths: 1, recurringMistakes: 1, whatImproved: 1, whatDegraded: 1, keyLessons: [1, 2], focusNextMonth: 1 },
  entries: {
    monthSummary: [
      { when: detailed, text: f => `${plural(f.count, "completed trade")} ${f.count === 1 ? "is" : "are"} included for the selected month. With this sample size, every pattern below is tentative.`, refs: ["period", "sample"] },
      { when: summary, text: f => `The month is reviewed in deterministic summary mode across ${plural(f.count, "trade")}; individual plans and notes are omitted, so process causes cannot be assessed.`, refs: ["period", "sample", "edge"] },
    ],
    processQuality: [
      { when: detailed, text: "Every included trade carries its locked plan, strategy version and execution, so the process can be reviewed per trade.", refs: ["trade:*", "sample"] },
      { when: summary, text: "Individual plans are omitted in summary mode, so process quality cannot be assessed beyond the aggregate metrics.", refs: ["sample", "edge"] },
    ],
    ruleAdherence: [
      { when: detailed, text: "No recorded event shows a rule exception; adherence is described from the supplied plans and events only.", refs: ["trade:*", "strategy:*"] },
      { when: summary, text: "Rule adherence cannot be assessed because individual plans, rules and notes are omitted in this mode.", refs: ["sample"] },
    ],
    entryModelPatterns: [
      { text: f => `The breakdown by entry model is supplied by Trading OS; ${f.small ? "the sample is too small to call one model stronger" : "one month cannot establish that one model is stronger"}.`, refs: ["models", "sample"] },
    ],
    sessionPatterns: [
      { text: "The session breakdown shows where the trades were taken; no session pattern can be established from one month of results.", refs: ["sessions", "sample"] },
    ],
    executionQuality: [
      { when: detailed, text: "The recorded fills match the planned entries; no execution issue is visible in the supplied records.", refs: ["trade:*"] },
      { when: summary, text: "Execution details are omitted in summary mode, so execution quality cannot be assessed.", refs: ["sample"] },
    ],
    behavioralPatterns: [
      { when: detailed, text: "The recorded notes do not establish a behavioral pattern; motives are not inferred from outcomes.", refs: ["event:*", "sample"] },
      { when: summary, text: "Notes are omitted in summary mode, so behavioral patterns cannot be assessed.", refs: ["sample"] },
    ],
    recurringStrengths: [
      { text: f => (f.small ? "The sample is too small to identify a recurring strength with confidence." : "One month of results cannot establish a recurring strength with confidence."), refs: ["sample", "edge"] },
    ],
    recurringMistakes: [
      { text: "No recurring mistake can be established from the supplied records.", refs: ["sample"] },
    ],
    whatImproved: [
      { text: "Change cannot be established from the supplied evidence; no comparable earlier and later observations are recorded in this month.", refs: ["sample"] },
    ],
    whatDegraded: [
      { text: "Change cannot be established from the supplied evidence; no comparable earlier and later observations are recorded in this month.", refs: ["sample"] },
    ],
    keyLessons: [
      { text: "A single month describes this period only; outcomes alone do not establish process quality.", refs: ["sample", "edge"] },
      { text: "Outcome metrics describe results, not process; plan and note records are needed to explain why a trade worked or failed.", refs: ["edge"] },
    ],
    focusNextMonth: [
      { text: "Keep recording the thesis, the invalidation and one live note per trade so next month's review can assess the process.", refs: ["sample"] },
    ],
  },
};

/** REVIEW_TRADE (V1): assessments follow the recorded plan vs execution; citations use the trade's own manifest. */
const REVIEW_TRADE = {
  count: { lessons: 2, limitations: 1 },
  finalize(out, g) {
    const ctx = rec(g.context);
    const plan = rec(ctx.originalPlan);
    const proposal = rec(plan.proposal);
    const execution = rec(ctx.execution);
    const notes = arr(ctx.events).filter(event => rec(event).event_type === "NOTE_ADDED").map(event => `event:${event.id}`);
    const evidence = arr(ctx.selectedEvidence).map(item => `evidence:${rec(item).id}`);
    const comparison = compareExecution({
      plannedEntry: proposal.entry, entry: execution.entry_price, plannedQuantity: execution.planned_quantity, quantity: execution.quantity,
      oversize: execution.oversize,
    });
    const versus = comparison.assessment;
    const modelMatches = execution.entry_model === undefined || proposal.model === undefined || execution.entry_model === proposal.model;
    const blocked = rec(ctx.deterministic).status === "TRADE_BLOCKED";
    const observation = (key, assessment, text, refs) => ({ assessment, interpretation: g.fit(`${key}.interpretation`, text), sourceRefs: g.refs(`${key}.sourceRefs`, refs) });
    out.planAdherence = observation("planAdherence", versus, versus === "ALIGNED"
      ? `${comparison.text} The exit is recorded with its persisted realized R.` : comparison.text, ["originalPlan", "execution"]);
    out.executionQuality = observation("executionQuality", "INSUFFICIENT_EVIDENCE", evidence.length
      ? "The selected screenshot shows the entry area, but the supplied records cannot confirm the timing quality of the fill."
      : "Recorded execution values are available, but the timing quality of the entry cannot be confirmed without a selected chart.", [...evidence.slice(0, 1), "execution"]);
    out.modelFit = observation("modelFit", modelMatches ? "ALIGNED" : "DEVIATION", modelMatches
      ? `The recorded entry model matches the plan's ${modelWord(proposal.model)} model as defined in the supplied strategy.`
      : "The recorded entry model differs from the model named in the locked plan.", ["strategy", "originalPlan"]);
    out.processDiscipline = observation("processDiscipline", blocked ? "DEVIATION" : "ALIGNED", blocked
      ? "The recorded Risk Engine result for this plan shows a block; this review does not change that result."
      : "The plan was locked with a recorded Risk Engine result, and the execution stayed within the sealed risk version.", ["deterministic", "riskVersion"]);
    out.deviations = observation("deviations", versus, versus === "ALIGNED"
      ? `No deviation from the locked plan is visible in the recorded ${comparison.entryKnown && comparison.sizeKnown ? "entry and size" : comparison.entryKnown ? "entry" : "size"}.`
      : versus === "DEVIATION" ? "The recorded execution departs from the locked plan as described under plan adherence."
        : "No deviation can be established because the plan and the execution do not record comparable values.", ["execution", "originalPlan"]);
    out.behavioralMistakes = observation("behavioralMistakes", "INSUFFICIENT_EVIDENCE", notes.length
      ? "The recorded notes describe the plan being followed; one trade cannot establish a behavioral mistake or a habit."
      : "No notes were recorded during the trade; the absence of a note is not evidence of a mistake.", [...notes.slice(0, 2), "execution"]);
    out.lessons = g.items("lessons", [
      observation("lessons.*", "INSUFFICIENT_EVIDENCE", "Record a short note at each management decision so a later review can separate process from outcome.", [...notes.slice(0, 1), "execution"]),
      observation("lessons.*", versus, "Compare each execution with its locked plan before reading the outcome; a result alone does not confirm the process.", ["originalPlan", "execution"]),
    ]);
    out.limitations = g.items("limitations", [
      "One trade cannot establish repeated behavioral patterns.",
      evidence.length ? "Selected screenshots are the user's charts and are not independently verified." : "No screenshots were selected, so chart context was not reviewed.",
    ]).map(text => g.fit("limitations.*", text));
  },
};

/** Journal kinds (src/domain/timeline.ts) and V1 event types that record a management action while live. */
const MANAGEMENT_KINDS = new Set(["STOP_CHANGE", "TARGET_CHANGE", "PARTIAL_CLOSE", "STOP_MOVED", "TARGET_CHANGED", "PARTIAL_CLOSED", "SL_TO_BE", "MANUAL_OVERRIDE", "POSITION_ADDED"]);

/**
 * REVIEW_TRADE_TIMELINE (V1 contract of the V2 timeline review): the thesis check cites only pre-entry sources (its
 * schema enum already enforces that), NO_PLAN_RECORDED forces NOT_RECORDED/NO_PLAN, a locked plan never gets NO_PLAN
 * and NOT_RECORDED only when its thesis is absent. After-close records are cited only as hindsight.
 */
const REVIEW_TRADE_TIMELINE = {
  count: { patterns: 0, limitations: 1 },
  finalize(out, g) {
    const ctx = rec(g.context);
    const planned = ctx.planStatus === "LOCKED_PLAN";
    const plan = rec(ctx.plan);
    const execution = rec(ctx.execution);
    const sources = arr(rec(ctx.sourceManifest).sources).filter(isRecord);
    const timeline = arr(ctx.timeline).filter(isRecord);
    const banded = timing => sources.filter(source => (source.kind === "TIMELINE" || source.kind === "EVIDENCE") && source.timing === timing).map(source => source.id);
    const before = banded("BEFORE_ENTRY");
    const after = banded("AFTER_CLOSE");
    const isNote = id => id.startsWith("journal:") || id.startsWith("event:");
    const live = timeline.filter(item => item.timing === "WHILE_LIVE" && item.kind !== "ENTRY" && item.kind !== "ENTRY_DETAILS");
    const changes = live.filter(item => MANAGEMENT_KINDS.has(item.kind));
    const flagged = timeline.filter(item => arr(item.flags).includes("RECORDED_AFTER_EXECUTION_BEGAN")).map(item => item.sourceId);
    const revised = timeline.filter(item => item.kind === "DRAFT_REVISION" && item.timing === "BEFORE_ENTRY" && rec(item.details).thesisMatchesLockedPlan === false
      && item.text !== "No thesis recorded in this revision.").map(item => item.sourceId);
    const thesisRecorded = planned && plan.thesis !== null && plan.thesis !== undefined;
    const evidenceCount = arr(ctx.evidence).length;
    const assessed = (key, assessment, text, refs) => ({ assessment, text: g.fit(`${key}.text`, text), sourceRefs: g.refs(`${key}.sourceRefs`, refs) });
    const finding = (key, text, refs) => ({ text: g.fit(`${key}.text`, text), sourceRefs: g.refs(`${key}.sourceRefs`, refs) });

    let thesis;
    if (!planned) thesis = ["NOT_RECORDED", "No thesis was recorded before execution; notes written later cannot stand in for a pre-trade plan.", ["strategy", ...before]];
    else if (!thesisRecorded) thesis = ["NOT_RECORDED", "The locked plan carries no written thesis, so there is no pre-entry reasoning to check.", ["originalPlan", ...before]];
    else if (revised.length) thesis = ["CHANGED", `${revised.length === 1 ? "A draft revision recorded before entry shows" : `${revised.length} draft revisions recorded before entry show`} that the thesis was revised before the plan was locked; the locked plan carries the final version.`, ["originalPlan", ...revised]];
    else thesis = ["CONSISTENT", "The locked thesis matches the records written before entry, and nothing recorded before entry contradicts it.", ["originalPlan", ...before.filter(isNote), ...before]];
    out.thesisCheck = assessed("thesisCheck", ...thesis);

    let versus;
    if (!planned) versus = ["NO_PLAN", "There is no locked plan to compare the recorded execution with.", ["execution"]];
    else {
      // The same comparison as Review Trade V1: entry price, and fill size above (oversize) or below the plan.
      const plannedQuantity = execution.plannedQuantity ?? plan.plannedQuantity;
      const comparison = compareExecution({ plannedEntry: plan.entry, entry: execution.entryPrice, plannedQuantity, quantity: execution.quantity, oversize: execution.oversize });
      versus = [comparison.assessment, comparison.text, ["execution", "originalPlan"]];
    }
    out.executionVsPlan = assessed("executionVsPlan", ...versus);

    let management;
    if (!live.length) management = ["NO_LIVE_RECORDS", "Nothing was recorded while the trade was live, so management cannot be assessed.", ["execution"]];
    else if (changes.length >= 3) management = ["REACTIVE", `${changes.length} management changes were recorded while the trade was live; the records do not show new evidence for each change.`, changes.map(item => item.sourceId)];
    else management = ["DISCIPLINED", `${plural(live.length, "record")} ${live.length === 1 ? "was" : "were"} written while the trade was live and ${live.length === 1 ? "describes" : "describe"} the management as it happened.`, live.map(item => item.sourceId)];
    out.liveManagement = assessed("liveManagement", ...management);

    const patterns = [];
    const silent = changes.filter(item => str(item.text) === "").map(item => item.sourceId);
    if (silent.length) patterns.push(finding("patterns.*", "A stop or target change was recorded while live without a written reason in the same record.", silent));
    if (flagged.length) patterns.push(finding("patterns.*", "A note was recorded after the reported entry time; logging the entry right away keeps the timeline unambiguous.", flagged));
    out.patterns = g.items("patterns", patterns);

    const afterNotes = after.filter(isNote);
    out.keyLesson = afterNotes.length
      ? finding("keyLesson", "Keep post-trade notes separate from the plan: they explain the outcome in hindsight and do not show what was known before entry.", afterNotes)
      : finding("keyLesson", "Record the entry trigger in a short note before the entry so the plan can be compared with the execution.", ["execution", ...before.filter(isNote)]);
    const verdict = { ALIGNED: "followed the locked plan", DEVIATION: "departed from the locked plan" }[versus[0]] ?? "could not be compared with the locked plan";
    out.headline = planned
      ? finding("headline", `The recorded execution ${verdict}; ${live.length ? "live management is documented" : "nothing was recorded while the trade was live"}.`, ["execution", "originalPlan"])
      : finding("headline", "No pre-trade plan was recorded, so the review covers the execution and the records written while the trade was open.", ["execution", ...live.map(item => item.sourceId)]);
    const limitations = ["One trade cannot establish a recurring pattern."];
    limitations.push(evidenceCount ? `${evidenceCount === 1 ? "One screenshot was" : `${evidenceCount} screenshots were`} selected; screenshots are not independently verified.` : "No screenshots were selected for this review.");
    if (afterNotes.length) limitations.push("Notes written after the close are treated as hindsight, not as pre-entry evidence.");
    out.limitations = g.items("limitations", limitations).map(text => g.fit("limitations.*", text));
  },
};

/** Evaluator timeframe of each legacy screenshot role (src/lib/screenshots.ts SCREENSHOT_ROLES); OTHER has none. */
const ROLE_TIMEFRAMES = Object.freeze({ DAILY: "D1", D1: "D1", H4: "H4", H1: "H1", M30: "M30", M15: "M15", M5: "M5", M3: "M3" });
/** htf_context slots: assessment key, evaluator timeframe and the name used in text. */
const HTF_SLOTS = Object.freeze([["daily", "D1", "daily"], ["h4", "H4", "H4"], ["h1", "H1", "H1"]]);
/** Charts that can show the structure shift and the order block: the strategy's M5 model first, then other intraday. */
const SETUP_TIMEFRAMES = Object.freeze(["M5", "M3", "M15", "M30"]);
const GRADE_COMPONENTS = ["HTF_ALIGNMENT", "LIQUIDITY_CONTEXT", "MSS_QUALITY", "DISPLACEMENT_QUALITY", "ENTRY_MODEL_VALIDITY", "TARGET_QUALITY", "EVIDENCE_CLARITY"];
/** "A daily", "An H4", "An H1" (the htf_context names). */
const withArticle = name => (name === "daily" ? "A daily" : `An ${name}`);
/** "daily", "daily or H4", "daily, H4 or H1" (conjunction "and" for lists of supplied items). */
function listOf(items, conjunction = "or") {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/**
 * Legacy setup evaluator (ict_setup_v2: schema 2.0 around the 1.0 assessment). Every evidence and finding id is scoped
 * to the pass analysis id, observed evidence comes only from CHART_IMAGE sources, the decision stays CONDITIONAL (or
 * INSUFFICIENT_EVIDENCE without a setup-timeframe chart) with a material finding, detailed qualities mirror the core
 * ones, missing OTE parameters are never invented, and a RECONCILER accounts for every prior finding exactly once.
 * Text follows the supplied screenshot roles: the structure shift is read from the setup chart (M5 first, then another
 * intraday chart, then an unlabelled one), daily/H4/H1 charts fill htf_context, and the gap names what is missing.
 */
const SETUP_V2 = {
  finalize(out, g) {
    const ctx = rec(g.context);
    const role = ["A", "B", "RECONCILER"].includes(ctx.role) ? ctx.role : "A";
    const analysisId = str(ctx.analysisId, "mock-analysis");
    const scoped = suffix => `${analysisId}:${suffix}`;
    const sources = Object.entries(rec(ctx.sources));
    const charts = sources.filter(([, type]) => type === "CHART_IMAGE").map(([id]) => id).slice(0, 8);
    const reports = sources.filter(([, type]) => type === "USER_REPORT").map(([id]) => id).slice(0, 1);
    const roleOf = new Map(arr(rec(ctx.manifest).screenshots).filter(isRecord).map(shot => [shot.id, str(shot.role, "chart")]));
    const timeframeOf = id => {
      const shotRole = roleOf.get(id);
      return typeof shotRole === "string" && Object.hasOwn(ROLE_TIMEFRAMES, shotRole) ? ROLE_TIMEFRAMES[shotRole] : null;
    };
    const setupChart = SETUP_TIMEFRAMES.map(tf => charts.find(id => timeframeOf(id) === tf)).find(id => id !== undefined)
      ?? charts.find(id => timeframeOf(id) === null) ?? null;
    const timeframe = (setupChart === null ? null : timeframeOf(setupChart)) ?? "UNKNOWN";
    const setupModel = ["OB_FIRST_TOUCH", "OTE"].includes(ctx.setupModel) ? ctx.setupModel : "UNKNOWN";
    const oteParameters = ctx.oteParametersAvailable === true;
    const htfNames = Object.fromEntries(HTF_SLOTS.map(([, tf, name]) => [tf, name]));
    const observed = charts.map((source, index) => {
      const tf = timeframeOf(source);
      const label = roleOf.get(source) ?? "Chart";
      const [locator, statement] = source === setupChart
        ? [`${label} screenshot: candles around the marked zone`, "The screenshot shows a swing that the proposal describes as the structure shift; its significance is not established by this image alone."]
        : Object.hasOwn(htfNames, tf)
          ? [`${label} screenshot: visible higher-timeframe range`, `The ${htfNames[tf]} screenshot shows the higher-timeframe range around the proposal; it does not establish the bias on its own.`]
          : [`${label} screenshot: surrounding price context`, "The screenshot shows the surrounding price context; earlier history outside the crop is not visible."];
      return { id: scoped(`obs-${index + 1}`), source_id: source, source_type: "CHART_IMAGE", locator, statement, confidence: "MEDIUM" };
    });
    const reported = reports.map(source => ({
      id: scoped("usr-1"), source_id: source, locator: "proposal narrative",
      statement: "The proposal narrative reports the setup thesis; it is not independently visible in the screenshots.",
    }));
    const first = observed.filter(item => item.source_id === setupChart).map(item => item.id);
    /** Observation id of the first chart supplied for each higher timeframe. */
    const htfObservation = Object.fromEntries(HTF_SLOTS.map(([, tf]) => [tf, observed.find(item => timeframeOf(item.source_id) === tf)?.id ?? null]));
    const htfSupplied = HTF_SLOTS.filter(([, tf]) => htfObservation[tf]).map(([, , name]) => name);
    const htfMissing = HTF_SLOTS.filter(([, tf]) => !htfObservation[tf]).map(([, , name]) => name);
    const htfIds = HTF_SLOTS.map(([, tf]) => htfObservation[tf]).filter(id => id !== null);
    const inferred = first.length ? [{ id: scoped("inf-1"), premise_evidence_ids: first, statement: "The visible swing may be the structure shift named in the thesis, but its importance cannot be confirmed from the crop.", confidence: "LOW" }] : [];
    const assess = (status, evidence, rationale) => ({
      status, confidence: status === "NOT_ASSESSED" || status === "NOT_APPLICABLE" ? "UNKNOWN" : "LOW", evidence_ids: evidence, rule_ids: [], rationale,
    });
    const notAssessed = rationale => assess("NOT_ASSESSED", [], rationale);
    const noSetupChart = charts.length ? "No setup-timeframe screenshot is supplied." : "No chart is supplied.";
    const [gapCode, gapText] = !charts.length ? ["MISSING_CHART", "No chart screenshot is supplied, so the structure cannot be assessed."]
      : !setupChart ? ["MISSING_TIMEFRAME", "No setup-timeframe (M5) screenshot is supplied, so the structure shift and the order block cannot be assessed from the charts."]
        : !htfSupplied.length ? ["MISSING_TIMEFRAME", "No higher-timeframe screenshot (daily, H4 or H1) is supplied, so the higher-timeframe bias and the external liquidity target cannot be assessed."]
          : htfMissing.length ? ["MISSING_TIMEFRAME", `No ${listOf(htfMissing)} screenshot is supplied, so the higher-timeframe context rests on the ${listOf(htfSupplied, "and")} screenshot${htfSupplied.length === 1 ? "" : "s"} alone.`]
            : ["MISSING_TARGET_CONTEXT", "The external liquidity target is not marked on the supplied screenshots, so the target cannot be assessed."];
    const gap = { id: scoped("gap-1"), code: gapCode, material_to_decision: true, evidence_ids: [], rule_ids: [], description: gapText };
    const uncertainty = first.length ? [{ id: scoped("unc-1"), code: "AMBIGUOUS_MSS", material_to_decision: true, evidence_ids: first, rule_ids: [],
      description: "The visible swing may mark the structure shift, but the importance of the broken swing is not established by the supplied crop." }] : [];
    const priorFindings = unique(g.prior.flatMap(prior => {
      const a = rec(rec(prior).assessment);
      return ["missing_evidence", "uncertainties", "contradictions", "warnings", "rule_violations"].flatMap(key => arr(a[key]).map(item => rec(item).id)).filter(id => typeof id === "string");
    }));
    const priorAnalyses = unique(g.prior.map(prior => rec(rec(prior).assessment).analysis_id).filter(id => typeof id === "string"));
    const roleText = role === "B" ? "The challenge pass tested" : role === "RECONCILER" ? "The reconciliation re-checked" : "The supporting pass reviewed";
    const ruling = setupChart ? "MATERIAL_UNCERTAINTY" : "MATERIAL_EVIDENCE_MISSING";
    const htfContext = Object.fromEntries(HTF_SLOTS.map(([key, tf, name]) => [key, htfObservation[tf]
      ? assess("AMBIGUOUS", [htfObservation[tf]], `${withArticle(name)} screenshot is supplied; the ${name} bias it shows is not established from one image.`)
      : notAssessed(`No ${name} screenshot is supplied.`)]));
    const assessment = rec(out.assessment);
    out.assessment = Object.assign(assessment, {
      schema_version: "1.0", analysis_id: analysisId,
      input_hash: /^[0-9a-f]{64}$/.test(String(ctx.inputHash)) ? ctx.inputHash : "0".repeat(64),
      strategy_version: str(ctx.strategyVersionId, "unknown-strategy"), risk_plan_version: str(ctx.riskPlanVersionId, "unknown-risk-plan"),
      instrument: str(ctx.instrument, "UNKNOWN"), evaluator_role: role,
      direction: ["LONG", "SHORT"].includes(ctx.direction) ? ctx.direction : "UNKNOWN", setup_model: setupModel,
      htf_context: { ...htfContext, alignment: "UNKNOWN" },
      liquidity_events: [], liquidity_target: null,
      mss: first.length ? assess("AMBIGUOUS", first, "A swing break is visible, but its importance and the preceding liquidity are not established.") : notAssessed(noSetupChart),
      mss_timeframe: timeframe, mss_quality: first.length ? "ADEQUATE" : "UNKNOWN",
      displacement: first.length ? assess("AMBIGUOUS", first, "The move after the swing is visible, but the crop does not show whether it was meaningful displacement.") : notAssessed(noSetupChart),
      displacement_quality: first.length ? "AMBIGUOUS" : "UNKNOWN",
      order_block: {
        validity: first.length ? assess("AMBIGUOUS", first, "A candidate zone is visible; first-touch history before the crop cannot be confirmed.") : notAssessed(noSetupChart),
        timeframe, originating_candle: "UNKNOWN",
        zone_construction: notAssessed("Zone edges are not readable with enough precision from the screenshot."),
        first_touch: notAssessed("Continuous price history before the zone is not visible."),
        proximal_edge_entry: notAssessed("The proposed entry is a user report, not a readable chart price."),
      },
      ote: {
        validity: setupModel === "OTE" ? assess("AMBIGUOUS", first, "The retracement leg is described in the proposal; anchors are not confirmed from the screenshot.") : assess("NOT_APPLICABLE", [], "The proposal uses the order block model, not OTE."),
        rationale: setupModel === "OTE" ? "UNKNOWN" : "NOT_APPLICABLE",
        anchor_definition: notAssessed(oteParameters ? "Anchor conventions are supplied but not visible on the screenshot." : "The strategy does not supply OTE parameters."),
        versioned_parameters_available: oteParameters ? "YES" : "NO",
      },
      entry_valid: first.length ? assess("AMBIGUOUS", first, "The entry relates to the visible zone, but first-touch conditions cannot be confirmed.") : notAssessed(noSetupChart),
      target_valid: notAssessed("The external liquidity target is not visible in the supplied screenshots."),
      observed_evidence: observed, user_reported_evidence: reported, inferred_evidence: inferred,
      missing_evidence: [gap], uncertainties: uncertainty, contradictions: [], rule_violations: [], warnings: [],
      grade_components: GRADE_COMPONENTS.map(component => {
        if (component === "HTF_ALIGNMENT" && htfIds.length) {
          return { component, rating: "UNKNOWN", assessment: assess("AMBIGUOUS", htfIds, `The ${listOf(htfSupplied, "and")} screenshot${htfSupplied.length === 1 ? " is" : "s are"} supplied, but the alignment with the proposal is not established from the images alone.`) };
        }
        if (component === "HTF_ALIGNMENT") return { component, rating: "UNKNOWN", assessment: notAssessed("No higher-timeframe screenshot is supplied.") };
        if (component === "MSS_QUALITY" && first.length) return { component, rating: "ADEQUATE", assessment: assess("AMBIGUOUS", first, "A swing break is visible; its importance is not established.") };
        if (component === "EVIDENCE_CLARITY" && first.length) {
          return { component, rating: "WEAK", assessment: assess("AMBIGUOUS", [...first, ...htfIds], htfIds.length
            ? `The screenshots cover the setup timeframe and the ${listOf(htfSupplied, "and")} context; earlier history and the target are outside the crops.`
            : `The ${charts.length === 1 ? "screenshot covers" : "screenshots cover"} the setup timeframe only.`) };
        }
        return { component, rating: "UNKNOWN", assessment: notAssessed("Not assessable from the supplied evidence.") };
      }),
      qualitative_decision: "CONDITIONAL",
      decision_reason: {
        code: ruling, evidence_ids: first, rule_ids: [],
        summary: `${roleText} the supplied evidence: material ${setupChart ? "uncertainty about the structure shift" : "gaps in the chart evidence"} remains, so the setup stays conditional on the trader's own review.`,
      },
      reconciliation: role === "RECONCILER"
        ? { reviewed_analysis_ids: priorAnalyses, accepted_finding_ids: priorFindings, rejected_finding_ids: [], unresolved_finding_ids: [],
          summary: "Both independent passes report the same material gaps; every prior finding is accepted and carried into this assessment." }
        : { reviewed_analysis_ids: [], accepted_finding_ids: [], rejected_finding_ids: [], unresolved_finding_ids: [], summary: "Not applicable" },
    });
    const fact = (value, evidenceClass, evidence, explanation) => ({ value, evidence_class: evidenceClass, evidence_ids: evidence, explanation });
    const unknownFact = explanation => fact("UNKNOWN", "UNKNOWN", [], explanation);
    const noPrice = () => ({ value: null, evidence_class: "UNKNOWN", evidence_ids: [] });
    out.schema_version = "2.0";
    out.trade_plan_id = str(ctx.proposalId, "unknown-proposal");
    out.decision = setupChart ? "CONDITIONAL" : "INSUFFICIENT_EVIDENCE";
    out.chart_details = Object.assign(rec(out.chart_details), {
      mss: {
        status: first.length ? "PROBABLE" : "UNKNOWN", quality: first.length ? "MODERATE" : "UNKNOWN", timeframe,
        broken_swing_importance: !first.length ? "Not established: no setup-timeframe screenshot shows the broken swing."
          : htfIds.length ? "Not established: the supplied higher-timeframe screenshots do not mark where the swing sits in the larger structure."
            : "Not established: the swing's role in the higher-timeframe structure is outside the screenshot.",
        preceding_liquidity: "The sweep before the break is reported in the proposal and is not visible in the crop.",
        expansion: "Some expansion follows the break; its extent beyond the crop is not visible.",
        evidence_ids: first, uncertainties: ["Whether the broken swing was significant cannot be confirmed from the supplied crop."],
      },
      displacement: {
        status: "UNKNOWN", quality: "UNKNOWN", description: "The displacement is not readable with confidence from the supplied screenshots.",
        evidence_ids: [], uncertainties: ["Candle bodies after the break are partly outside the crop."],
      },
      liquidity_events: [],
      order_block: {
        candidate_present: first.length ? fact("YES", "OBSERVED", first, "A candidate zone is visible near the marked area of the screenshot.") : unknownFact(noSetupChart),
        direction: ["LONG", "SHORT"].includes(ctx.direction) ? ctx.direction : "UNKNOWN", timeframe, validity: "UNKNOWN",
        proximal_price_if_readable: noPrice(), distal_price_if_readable: noPrice(),
        reversal_candle_identified: unknownFact("The originating candle is not readable with confidence."),
        caused_displacement: unknownFact("The screenshot does not show whether this candle caused the displacement."),
        first_touch_status: "UNKNOWN", first_touch_evidence_ids: [],
        coverage_description: first.length ? "The crop covers the setup timeframe around the zone only; earlier history is not visible." : "No setup-timeframe screenshot shows the zone.",
        mitigation_status: "UNKNOWN", evidence_ids: first, uncertainties: ["Earlier touches of the zone may exist outside the visible history."],
      },
      ote: {
        leg_identified: unknownFact("No retracement leg is marked on the screenshots."),
        swing_high: noPrice(), swing_low: noPrice(), retracement_zone_low: noPrice(), retracement_zone_high: noPrice(),
        parameters_available: oteParameters,
        screenshot_support: unknownFact("The screenshots do not show OTE anchors."),
        strategy_consistency: "UNKNOWN", evidence_ids: [], uncertainties: [oteParameters ? "OTE anchors are not visible." : "The strategy supplies no OTE parameters."],
      },
      target: {
        type: "UNKNOWN", validity: "UNKNOWN", evidence_class: "UNKNOWN", contradictions: [], evidence_ids: [],
        uncertainties: ["The target liquidity is not visible in the supplied screenshots."],
      },
      evidence_quality: {
        level: setupChart ? "MEDIUM" : "LOW",
        rationale: !charts.length ? "No chart evidence is supplied."
          : !setupChart ? `The ${charts.length === 1 ? "screenshot shows" : "screenshots show"} the ${listOf(htfSupplied, "and")} context only; the setup timeframe is missing.`
            : !htfSupplied.length ? `The ${charts.length === 1 ? "screenshot shows" : "screenshots show"} the setup timeframe; higher-timeframe context and earlier history are missing.`
              : htfMissing.length ? `The screenshots show the setup timeframe and the ${listOf(htfSupplied, "and")} context; the ${listOf(htfMissing, "and")} context and earlier history are missing.`
                : "The screenshots show the setup timeframe and the daily, H4 and H1 context; earlier history and the target are outside the crops.",
        evidence_ids: observed.map(item => item.id),
      },
    });
  },
};

const GENERIC_PLAN = {};
const PLANS = Object.freeze({
  analyze_setup_v1: ANALYZE_SETUP,
  challenge_bias_v1: CHALLENGE_BIAS,
  weekly_review_v1: WEEKLY_REVIEW,
  recent_trades_v1: RECENT_TRADES,
  monthly_review_v1: MONTHLY_REVIEW,
  review_trade_v1: REVIEW_TRADE,
  review_trade_timeline_v1: REVIEW_TRADE_TIMELINE,
  ict_setup_v2: SETUP_V2,
});

/** json_schema names with contract-specific post-processing; any other schema gets the generic generator only. */
export const KNOWN_CONTRACTS = Object.freeze(Object.keys(PLANS));

/**
 * Output instance for one request. `schema` is the request's text.format.schema, `context`/`prior` the facts and prior
 * evaluations the provider sent, `seed` the request hash. Throws when the result would not satisfy the schema.
 */
export function generateOutput({ name, schema, context = null, prior = [], seed = "0" }) {
  if (!isRecord(schema)) throw new Error("mock-openai: the request has no json_schema");
  const plan = (typeof name === "string" && Object.hasOwn(PLANS, name) ? PLANS[name] : null) ?? GENERIC_PLAN;
  const g = createGeneration(schema, plan, { name, context, prior, seed });
  const output = generateNode(g, schema, []);
  if (typeof plan.finalize === "function") plan.finalize(output, g);
  const errors = schemaErrors(output, schema);
  if (errors.length) throw new Error(`mock-openai: generated output does not match ${name}: ${errors.slice(0, 3).join("; ")}`);
  return output;
}

// ---------------------------------------------------------------------------------------------------------------
// Failure scenarios that return JSON
// ---------------------------------------------------------------------------------------------------------------

function firstArray(value, key) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = firstArray(item, key);
      if (hit) return hit;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (Array.isArray(value[key])) return value[key];
  for (const item of Object.values(value)) {
    const hit = firstArray(item, key);
    if (hit) return hit;
  }
  return null;
}

function firstTextHolder(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = firstTextHolder(item);
      if (hit) return hit;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const key of ["text", "interpretation", "summary", "rationale"]) if (typeof value[key] === "string") return { holder: value, key };
  for (const item of Object.values(value)) {
    const hit = firstTextHolder(item);
    if (hit) return hit;
  }
  return null;
}

/** Applies a JSON failure scenario (schema_violation, foreign_source, hindsight_citation, trading_directive). */
export function violateOutput(output, scenarioName, request = {}) {
  const copy = structuredClone(output);
  if (scenarioName === "schema_violation" || !isRecord(copy)) {
    const entries = isRecord(copy) ? Object.entries(copy).slice(1) : [];
    return { ...Object.fromEntries(entries), unexpectedField: "This property is not part of the response schema." };
  }
  if (scenarioName === "hindsight_citation" && isRecord(copy.thesisCheck) && Array.isArray(copy.thesisCheck.sourceRefs)) {
    const sources = arr(rec(rec(request.context).sourceManifest).sources).filter(isRecord);
    const hindsight = sources.find(source => source.timing === "AFTER_CLOSE")?.id ?? "execution";
    copy.thesisCheck.sourceRefs = unique([...copy.thesisCheck.sourceRefs.slice(0, 1), hindsight]);
    return copy;
  }
  if (scenarioName === "foreign_source" || scenarioName === "hindsight_citation") {
    const refs = firstArray(copy, "sourceRefs");
    if (refs?.length) {
      refs[0] = FOREIGN_SOURCE_ID;
      return copy;
    }
    const evidence = firstArray(copy, "evidence_ids");
    if (evidence) {
      evidence.push("foreign-evidence");
      return copy;
    }
    return violateOutput(output, "schema_violation", request);
  }
  if (scenarioName === "trading_directive") {
    const target = firstTextHolder(copy);
    if (target) {
      target.holder[target.key] = DIRECTIVE_TEXT;
      return copy;
    }
    return violateOutput(output, "schema_violation", request);
  }
  return copy;
}

// ---------------------------------------------------------------------------------------------------------------
// Response bodies
// ---------------------------------------------------------------------------------------------------------------

function errorBody(message, type, code) {
  return { error: { message, type, param: null, code } };
}

const HTTP_SCENARIOS = Object.freeze({
  http_500: [500, errorBody("The server had an error while processing your request (local mock scenario http_500).", "server_error", null)],
  http_429: [429, errorBody("Rate limit reached for requests (local mock scenario http_429).", "requests", "rate_limit_exceeded")],
  http_401: [401, errorBody("Incorrect API key provided (local mock scenario http_401).", "invalid_request_error", "invalid_api_key")],
  http_403: [403, errorBody("The project does not have access to this model (local mock scenario http_403).", "invalid_request_error", "model_not_found")],
});

/** Body for POST /v1/responses/input_tokens: {"input_tokens": n} (or the count failure scenarios). */
export function buildInputTokensResult(bodyText, scenarioName = "ok") {
  if (scenarioName === "count_unavailable") {
    return { status: 503, body: errorBody("Token counting is unavailable (local mock scenario count_unavailable).", "server_error", "service_unavailable") };
  }
  if (scenarioName === "input_limit_exceeded") return { status: 200, body: { input_tokens: OVERSIZED_INPUT_TOKENS } };
  return { status: 200, body: { input_tokens: estimateInputTokens(bodyText) } };
}

/**
 * Body for POST /v1/responses in the Responses API shape src/ai/provider.ts parses. Usage: input_tokens equals the
 * count endpoint's estimate for the same request; output_tokens = ceil(output_text bytes / 4), capped at
 * max_output_tokens; no cached or reasoning tokens. Throws MockRequestError for bodies that are not provider requests.
 */
export function buildResponsesResult(bodyText, { scenario: scenarioName = "ok", responseId = "resp_mock_1", createdAt = 0 } = {}) {
  if (Object.hasOwn(HTTP_SCENARIOS, scenarioName)) {
    const [status, body] = HTTP_SCENARIOS[scenarioName];
    return { status, body };
  }
  const request = parseResponsesRequest(bodyText);
  const inputTokens = estimateInputTokens(countEquivalentBody(request.payload));
  const maxOutput = request.maxOutputTokens ?? Number.POSITIVE_INFINITY;
  const usage = outputTokens => ({
    input_tokens: inputTokens, input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: inputTokens + outputTokens,
  });
  const message = (status, content) => ({ id: `msg_${responseId.replace(/^resp_/, "")}`, type: "message", status, role: "assistant", content });
  const response = (status, content, outputTokens, extra = {}) => ({
    id: responseId, object: "response", created_at: createdAt, status, error: null, incomplete_details: null, model: request.model,
    output: [message(status === "completed" ? "completed" : "incomplete", content)], usage: usage(outputTokens), ...extra,
  });
  const outputText = text => ({ type: "output_text", text, annotations: [] });
  if (scenarioName === "refusal") {
    const refusal = "I'm sorry, but I can't help with that request.";
    return { status: 200, body: response("completed", [{ type: "refusal", refusal }], textTokens(refusal)) };
  }
  if (scenarioName === "invalid_json") {
    const text = "The local mock returned plain text instead of the requested JSON.";
    return { status: 200, body: response("completed", [outputText(text)], textTokens(text)) };
  }
  const seed = requestSeed(bodyText);
  const generated = generateOutput({ name: request.name, schema: request.schema, context: request.context, prior: request.prior, seed });
  if (scenarioName === "incomplete") {
    const full = JSON.stringify(generated);
    const partial = full.slice(0, Math.max(1, Math.floor(full.length * 0.6)));
    const charged = Number.isFinite(maxOutput) ? maxOutput : textTokens(full);
    return { status: 200, body: response("incomplete", [outputText(partial)], charged, { incomplete_details: { reason: "max_output_tokens" } }), output: generated };
  }
  const output = scenarioName === "ok" ? generated : violateOutput(generated, scenarioName, request);
  const text = JSON.stringify(output);
  return { status: 200, body: response("completed", [outputText(text)], Math.min(maxOutput, textTokens(text))), output };
}
