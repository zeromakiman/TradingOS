import { z } from "zod";
import type { AiOperation } from "./operations";
import { responsesWire } from "./provider";
import type { AiProviderRequest } from "./provider-contract";

/**
 * Conservative local pre-flight estimate of one provider request (spec §11.2 cost protection), computed from the
 * exact input-count body the adapter sends (`responsesWire`): the instructions, the facts, the response format with
 * its schema and citation enum, and the images, not only the facts. Callers refuse a request whose estimate is above
 * the operation's input limit before anything is written or reserved.
 *
 * Text is counted so that the reviewed models' tokenizer family (o200k) cannot plausibly count it higher: the text
 * the model reads is split exactly as the o200k pre-tokenizer splits it (tiktoken's published pattern; its contraction
 * rule only merges pieces and is left out), and the tokenizer never merges across pieces, so every piece is at least
 * one token. Each piece is counted as at least one token per started 4 UTF-8 bytes. Facts dense with ids, timestamps
 * and decimals (one token per 1.5–3 bytes, far above the common 4-bytes-per-token rule) are therefore counted at
 * least as high as the tokenizer counts them, while prose is overestimated a little. The estimate is never below
 * ceil(UTF-8 bytes / 4) of the whole count body, which is what the local mock provider counts. Images count by the
 * high-detail tile formula, an unreadable image as the maximum.
 *
 * The provider's exact count still runs after dispatch; a request it refuses is released before any generation,
 * without charge (src/ai/request-gate.ts).
 */

export const TEXT_BYTES_PER_TOKEN = 4;
/**
 * The o200k pre-tokenizer pattern (tiktoken `o200k_base` pat_str without the case-insensitive contraction suffix).
 * Its alternatives cover every character: letter runs, digit groups of at most three, symbol runs and whitespace.
 */
const O200K_PIECES =
  /[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n/]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
/** The parts of a count body the model reads as text: instructions, input texts and the response format. */
const countBody = z.object({
  instructions: z.string(),
  input: z.array(z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()) }).loose()),
  text: z.unknown(),
}).loose();
/** One high-detail image after fitting into 2048 × 2048 and scaling its short side to 768: 85 + 170 per 512px tile. */
export const MAX_IMAGE_TOKENS = 85 + 170 * 8;
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Pixel size of a PNG, JPEG or WebP image from its header, or null when it cannot be read. */
export function imageDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString("ascii", 12, 16) === "IHDR") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      // Start-of-frame markers carry the size; DHT (c4), JPG (c8) and DAC (cc) do not.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
      }
      i += 2 + bytes.readUInt16BE(i + 2);
    }
    return null;
  }
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
  }
  return null;
}

/** Input tokens of one image under the high-detail tile formula; an unreadable image counts as the maximum. */
export function imageTokens(dataUrl: string, detail: "high" | "low" = "high"): number {
  if (detail === "low") return 85;
  const match = IMAGE_DATA_URL.exec(dataUrl);
  const size = match ? imageDimensions(Buffer.from(match[1], "base64")) : null;
  if (!size || !(size.width > 0) || !(size.height > 0)) return MAX_IMAGE_TOKENS;
  let { width, height } = size;
  const fit = Math.min(1, 2048 / Math.max(width, height));
  width *= fit;
  height *= fit;
  const shrink = Math.min(1, 768 / Math.min(width, height));
  width *= shrink;
  height *= shrink;
  return Math.min(MAX_IMAGE_TOKENS, 85 + 170 * Math.ceil(width / 512) * Math.ceil(height / 512));
}

/** Conservative tokens of text: every o200k piece counts at least one token and one per started 4 UTF-8 bytes. */
export function textTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(O200K_PIECES)) tokens += Math.ceil(utf8Bytes(piece) / TEXT_BYTES_PER_TOKEN);
  return tokens;
}

/** ceil(UTF-8 bytes / 4): the rough estimate the local mock provider counts a body with. */
export function byteTokens(text: string): number {
  return Math.ceil(utf8Bytes(text) / TEXT_BYTES_PER_TOKEN);
}

export interface RequestEstimate {
  /** Estimated input tokens of the whole request: the larger text count plus the images. */
  tokens: number;
  /** The operation's reviewed input limit. */
  limit: number;
  /** Text bytes of the count body, images excluded. */
  textBytes: number;
  /** Conservative tokens of the text the model reads (`textTokens`). */
  textTokens: number;
  /** ceil(textBytes / 4): what the local mock counts for the text. */
  byteTokens: number;
  imageTokens: number;
}

type EstimateInput = Pick<AiProviderRequest, "context" | "images" | "prior"> & { config?: AiProviderRequest["config"] };

/** The request configuration every bounded operation uses (the runners pass exactly these values). */
export function operationRequestConfig(operation: AiOperation): AiProviderRequest["config"] {
  return {
    model: operation.model, reasoningEffort: operation.reasoningEffort, timeoutMs: operation.timeoutMs, maxOutputTokens: operation.maxOutputTokens,
    imageDetail: operation.imageDetail, deepEnabled: false,
  };
}

/** Estimate of the whole request; `config` defaults to the operation's own configuration. */
export function estimateRequest(operation: AiOperation, input: EstimateInput): RequestEstimate {
  const config = input.config ?? operationRequestConfig(operation);
  const { countWire } = responsesWire({ config, context: input.context, images: input.images, prior: input.prior }, operation);
  let images = 0;
  let body = countWire;
  for (const image of input.images) {
    images += imageTokens(image.dataUrl, config.imageDetail);
    // Image bytes are priced by tiles, never as text.
    body = body.replace(image.dataUrl, "");
  }
  const sent = countBody.parse(JSON.parse(countWire));
  const read = [
    sent.instructions,
    ...sent.input.flatMap(message => message.content.flatMap(part => (part.type === "input_text" && part.text !== undefined ? [part.text] : []))),
    JSON.stringify(sent.text),
  ];
  const text = read.reduce((sum, part) => sum + textTokens(part), 0);
  const bytes = byteTokens(body);
  return { tokens: Math.max(text, bytes) + images, limit: operation.maxInputTokens, textBytes: utf8Bytes(body), textTokens: text, byteTokens: bytes, imageTokens: images };
}

/** True when the estimate of the whole request is above the operation's input limit. */
export function exceedsInputLimit(operation: AiOperation, input: EstimateInput): boolean {
  return estimateRequest(operation, input).tokens > operation.maxInputTokens;
}
