// Small HTTP helpers shared by the gateway modules.

/** An error that maps directly onto an HTTP response. */
export class HttpError extends Error {
  constructor(status, body, headers = {}) {
    super(typeof body === "object" && body ? body.message ?? body.msg ?? JSON.stringify(body) : String(body));
    this.status = status; this.body = body; this.headers = headers;
  }
}

export function sendJson(res, status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

export function redirect(res, location, status = 303) {
  res.writeHead(status, { Location: location, "Cache-Control": "no-store", "Content-Length": 0 });
  res.end();
}

export async function readBody(req, limit, tooLarge = () => new HttpError(413, { message: "Request body too large" })) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) { req.resume(); throw tooLarge(); }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { req.resume(); throw tooLarge(); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = 1024 * 1024, invalid = () => new HttpError(400, { message: "Request body is not valid JSON" })) {
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try {
    const value = JSON.parse(raw.toString("utf8"));
    return value && typeof value === "object" ? value : {};
  } catch { throw invalid(); }
}

export function header(req, name) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value ?? null;
}

// Hop-by-hop headers are never forwarded by proxies (RFC 9110 section 7.6.1).
export const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "proxy-connection"]);

export const iso = value => (value ? new Date(value).toISOString() : undefined);
