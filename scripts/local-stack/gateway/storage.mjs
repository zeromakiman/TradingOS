// /storage/v1/* - a Supabase Storage emulation backed by Postgres metadata (storage.objects) and
// files under .local/storage/{bucket}/{path}. Like supabase/storage, every object operation runs as
// SQL on storage.objects inside a transaction with the caller's role (anon / authenticated /
// service_role) and request.jwt.claims set, so RLS policies decide access. service_role has
// BYPASSRLS exactly as in Supabase. Bucket lookups for size/MIME limits use the gateway's own role.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { HttpError, header, iso, readBody, readJson, sendJson } from "./http.mjs";
import { JwtError, looksLikeJwt, nowSeconds, signJwt, verifyJwt } from "./jwt.mjs";

const GLOBAL_FILE_SIZE_LIMIT = 50 * 1024 * 1024; // Supabase's default global upload limit
const MULTIPART_OVERHEAD = 1024 * 1024;
const API_ROLES = new Set(["anon", "authenticated", "service_role"]);

// Supabase Storage (legacy API) renders errors with HTTP 400 unless the error is a 500; the
// semantic status is carried in the body's statusCode field.
function storageError(statusCode, code, error, message) {
  return new HttpError(statusCode === "500" ? 500 : 400, { statusCode, code, error, message });
}
const E = {
  noBucket: () => storageError("404", "NoSuchBucket", "Bucket not found", "Bucket not found"),
  noKey: () => storageError("404", "NoSuchKey", "not_found", "Object not found"),
  exists: () => storageError("409", "ResourceAlreadyExists", "Duplicate", "The resource already exists"),
  denied: message => storageError("403", "AccessDenied", "Unauthorized", message || "Access denied"),
  tooLarge: () => storageError("413", "EntityTooLarge", "Payload too large", "The object exceeded the maximum allowed size"),
  mime: type => storageError("415", "InvalidMimeType", "invalid_mime_type", `mime type ${type} is not supported`),
  invalidKey: key => storageError("400", "InvalidKey", "InvalidKey", `Invalid key: ${key}`),
  invalid: message => storageError("400", "InvalidRequest", "InvalidRequest", message),
  jwt: message => storageError("400", "InvalidJWT", "InvalidJWT", message),
  missingAuth: () => storageError("400", "InvalidRequest", "Error", "headers must have required property 'authorization'"),
  notImplemented: what => new HttpError(501, { statusCode: "501", code: "NotImplemented", error: "not_implemented", message: `${what} is not supported by the local stack` }),
};

function mapDbError(error) {
  if (error instanceof HttpError) return error;
  if (error?.code === "42501") return E.denied(error.message); // includes "new row violates row-level security policy"
  if (error?.code === "23505") return E.exists();
  if (error?.code === "23503") return E.noBucket();
  return error;
}

const validBucketId = id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id);
function validKey(name) {
  if (typeof name !== "string" || !name.length || name.length > 1024 || name.startsWith("/") || name.includes("\\")) return false;
  // Reject control characters and empty / relative path segments (no traversal outside the bucket).
  if ([...name].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) return false;
  return !name.split("/").some(s => s === "" || s === "." || s === "..");
}
// Reversible on-disk segment encoding: percent-encodes characters Windows forbids in file names,
// plus trailing dots/spaces and reserved device names. UUID-style keys stay readable.
function encodeSegment(segment) {
  let s = encodeURIComponent(segment).replace(/\*/g, "%2A");
  if (s.endsWith(".")) s = `${s.slice(0, -1)}%2E`;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `%${s.charCodeAt(0).toString(16).toUpperCase()}${s.slice(1)}`;
  return s;
}
function mimeAllowed(allowed, type) {
  if (!allowed?.length) return true;
  const base = String(type ?? "").split(";")[0].trim().toLowerCase();
  return allowed.some(pattern => {
    const p = pattern.toLowerCase();
    return p === base || (p.endsWith("/*") && base.startsWith(p.slice(0, -1)));
  });
}
const bucketJson = b => ({
  id: b.id, name: b.name, owner: b.owner ?? "", public: Boolean(b.public), type: b.type ?? "STANDARD",
  file_size_limit: b.file_size_limit === null || b.file_size_limit === undefined ? null : Number(b.file_size_limit),
  allowed_mime_types: b.allowed_mime_types ?? null, created_at: iso(b.created_at), updated_at: iso(b.updated_at),
});
const objectJson = o => ({
  name: o.name, id: o.id, bucket_id: o.bucket_id, owner: o.owner ?? undefined, owner_id: o.owner_id ?? undefined,
  version: o.version ?? undefined, updated_at: iso(o.updated_at), created_at: iso(o.created_at),
  last_accessed_at: iso(o.last_accessed_at), metadata: o.metadata ?? null, user_metadata: o.user_metadata ?? undefined,
});

export function createStorage({ pool, tx, stack, storageRoot, logger }) {
  const root = path.resolve(storageRoot);
  function objectFile(bucketId, name) {
    if (!validBucketId(bucketId)) throw E.noBucket();
    if (!validKey(name)) throw E.invalidKey(name);
    const file = path.join(root, encodeSegment(bucketId), ...name.split("/").map(encodeSegment));
    if (!file.startsWith(root + path.sep)) throw E.invalidKey(name); // defense in depth
    return file;
  }

  /** Resolves the caller from the (already key-translated) bearer token. */
  function caller(creds) {
    if (!creds.bearer) throw E.missingAuth();
    if (!looksLikeJwt(creds.bearer)) throw E.jwt("Invalid Compact JWS");
    let claims;
    try { claims = verifyJwt(creds.bearer, stack.jwtSecret); } catch (error) {
      throw E.jwt(error instanceof JwtError ? (error.reason === "expired" ? "\"exp\" claim timestamp check failed" : error.message) : "Invalid JWT");
    }
    if (!API_ROLES.has(claims.role)) throw E.denied(`role "${claims.role}" is not allowed`);
    const sub = typeof claims.sub === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.sub) ? claims.sub : null;
    return { role: claims.role, claims, sub }; // sub becomes storage.objects.owner (uuid)
  }
  /** Runs fn inside a transaction impersonating the caller (as supabase/storage does). */
  function asCaller(ctx, operation, fn) {
    return tx(async db => {
      await db.query(
        `select set_config('role', $1, true), set_config('request.jwt.claim.role', $1, true),
                set_config('request.jwt.claims', $2, true), set_config('request.jwt.claim.sub', $3, true),
                set_config('storage.operation', $4, true)`,
        [ctx.role, JSON.stringify(ctx.claims), ctx.sub ?? "", operation],
      );
      return fn(db);
    }).catch(error => { throw mapDbError(error); });
  }
  async function findBucket(id) {
    if (!validBucketId(id)) throw E.noBucket();
    const { rows } = await pool.query("select * from storage.buckets where id = $1", [id]);
    if (!rows[0]) throw E.noBucket();
    return rows[0];
  }
  async function visibleObject(ctx, bucketId, name, operation) {
    const rows = await asCaller(ctx, operation, db => db.query("select * from storage.objects where bucket_id = $1 and name = $2", [bucketId, name]).then(r => r.rows));
    if (!rows[0]) throw E.noKey();
    return rows[0];
  }

  async function sendObject(req, res, row, url) {
    const file = objectFile(row.bucket_id, row.name);
    let stat;
    try { stat = await fsp.stat(file); } catch { throw E.noKey(); }
    const meta = row.metadata ?? {};
    const headers = {
      "Content-Type": meta.mimetype ?? "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": meta.cacheControl ?? "no-cache",
      ETag: meta.eTag ?? `"${row.version ?? row.id}"`,
      "Last-Modified": new Date(meta.lastModified ?? row.updated_at ?? stat.mtime).toUTCString(),
    };
    const download = url.searchParams.get("download");
    if (download !== null) headers["Content-Disposition"] = `attachment; filename="${(download || path.posix.basename(row.name)).replace(/["\\\r\n]/g, "_")}"`;
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
  }

  async function upload(req, res, ctx, bucketId, name, { upsert }) {
    const bucket = await findBucket(bucketId);
    objectFile(bucketId, name); // validates the key before reading the body
    const limit = Math.min(GLOBAL_FILE_SIZE_LIMIT, bucket.file_size_limit ? Number(bucket.file_size_limit) : GLOBAL_FILE_SIZE_LIMIT);
    const contentType = header(req, "content-type") ?? "application/octet-stream";
    let bytes, mimetype, cacheControl, userMetadata = null;
    if (/^multipart\/form-data/i.test(contentType)) {
      const raw = await readBody(req, limit + MULTIPART_OVERHEAD, E.tooLarge);
      let form;
      try { form = await new Response(raw, { headers: { "content-type": contentType } }).formData(); } catch { throw E.invalid("Invalid multipart body"); }
      let file = null;
      for (const [, value] of form) if (value && typeof value === "object" && typeof value.arrayBuffer === "function") { file = value; break; }
      if (!file) throw E.invalid("No file was found in the multipart body");
      bytes = Buffer.from(await file.arrayBuffer());
      mimetype = file.type || "text/plain;charset=UTF-8";
      const cc = form.get("cacheControl");
      cacheControl = typeof cc === "string" && cc ? (/^\d+$/.test(cc) ? `max-age=${cc}` : cc) : null;
      const md = form.get("metadata");
      if (typeof md === "string" && md) { try { userMetadata = JSON.parse(md); } catch { throw E.invalid("Invalid metadata"); } }
    } else {
      bytes = await readBody(req, limit, E.tooLarge);
      mimetype = contentType;
      cacheControl = header(req, "cache-control");
      const encoded = header(req, "x-metadata");
      if (encoded) { try { userMetadata = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); } catch { throw E.invalid("Invalid x-metadata header"); } }
    }
    if (bytes.length > limit) throw E.tooLarge();
    if (!mimeAllowed(bucket.allowed_mime_types, mimetype)) throw E.mime(mimetype);

    const id = randomUUID(), version = randomUUID();
    const metadata = {
      eTag: `"${createHash("md5").update(bytes).digest("hex")}"`, size: bytes.length, mimetype, cacheControl: cacheControl ?? "no-cache",
      lastModified: new Date().toISOString(), contentLength: bytes.length, httpStatusCode: 200,
    };
    const dest = objectFile(bucketId, name), temp = `${dest}.${version}.upload`;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(temp, bytes);
    try {
      const values = [id, bucketId, name, ctx.sub, ctx.sub, JSON.stringify(metadata), userMetadata === null ? null : JSON.stringify(userMetadata), version];
      const objectId = await asCaller(ctx, upsert ? "storage.object.upload_upsert" : "storage.object.upload", async db => {
        if (!upsert) {
          // Plain uploads need only an INSERT policy (no RETURNING, so no SELECT policy is required).
          await db.query("insert into storage.objects(id, bucket_id, name, owner, owner_id, metadata, user_metadata, version) values ($1, $2, $3, $4, $5, $6, $7, $8)", values);
          return id;
        }
        const { rows } = await db.query(
          `insert into storage.objects(id, bucket_id, name, owner, owner_id, metadata, user_metadata, version) values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (bucket_id, name) do update set owner = excluded.owner, owner_id = excluded.owner_id, metadata = excluded.metadata,
             user_metadata = excluded.user_metadata, version = excluded.version, last_accessed_at = now()
           returning id`, values);
        return rows[0].id;
      });
      await fsp.rename(temp, dest);
      sendJson(res, 200, { Id: objectId, Key: `${bucketId}/${name}` });
    } catch (error) {
      await fsp.rm(temp, { force: true });
      throw mapDbError(error);
    }
  }

  async function removeObjects(ctx, bucketId, names) {
    const rows = await asCaller(ctx, "storage.object.delete", db =>
      db.query("delete from storage.objects where bucket_id = $1 and name = any($2::text[]) returning *", [bucketId, names]).then(r => r.rows));
    for (const row of rows) {
      try { await fsp.rm(objectFile(row.bucket_id, row.name), { force: true }); } catch (error) { logger(`[storage] unable to delete bytes for ${row.bucket_id}/${row.name}: ${error.message}`); }
    }
    return rows;
  }

  async function list(ctx, bucketId, body) {
    await findBucket(bucketId);
    let prefix = typeof body.prefix === "string" ? body.prefix : "";
    if (prefix.length && !prefix.endsWith("/")) prefix = `${prefix}/`; // storage treats the prefix as a folder
    const limit = Math.min(1000, Math.max(1, Number(body.limit ?? 100) || 100));
    const offset = Math.max(0, Number(body.offset ?? 0) || 0);
    const search = typeof body.search === "string" ? body.search.toLowerCase() : "";
    const column = ["name", "created_at", "updated_at", "last_accessed_at"].includes(body.sortBy?.column) ? body.sortBy.column : "name";
    const descending = String(body.sortBy?.order ?? "asc").toLowerCase() === "desc";
    const like = `${prefix.replace(/[\\%_]/g, m => `\\${m}`)}%`;
    const rows = await asCaller(ctx, "storage.object.list", db =>
      db.query("select * from storage.objects where bucket_id = $1 and name like $2 order by name", [bucketId, like]).then(r => r.rows));
    const items = new Map();
    for (const row of rows) {
      const rest = row.name.slice(prefix.length);
      if (search && !rest.toLowerCase().startsWith(search)) continue;
      const slash = rest.indexOf("/");
      if (slash >= 0) {
        const folder = rest.slice(0, slash);
        if (!items.has(`d:${folder}`)) items.set(`d:${folder}`, { name: folder, id: null, updated_at: null, created_at: null, last_accessed_at: null, metadata: null });
      } else {
        items.set(`f:${rest}`, { name: rest, id: row.id, updated_at: iso(row.updated_at), created_at: iso(row.created_at), last_accessed_at: iso(row.last_accessed_at), metadata: row.metadata });
      }
    }
    const sorted = [...items.values()].sort((a, b) => {
      const x = a[column] ?? "", y = b[column] ?? "";
      return (x < y ? -1 : x > y ? 1 : 0) * (descending ? -1 : 1);
    });
    return sorted.slice(offset, offset + limit);
  }

  function signedPath(bucketId, name, expiresIn) {
    const seconds = Number(expiresIn);
    if (!Number.isFinite(seconds) || seconds < 1) throw E.invalid("expiresIn must be a positive number");
    const iat = nowSeconds();
    const token = signJwt({ url: `${bucketId}/${name}`, iat, exp: iat + Math.floor(seconds) }, stack.jwtSecret);
    return `/object/sign/${bucketId}/${name.split("/").map(encodeURIComponent).join("/")}?token=${token}`;
  }

  // -------------------------------------------------------------------------------------------
  // Router
  // -------------------------------------------------------------------------------------------
  return async function handleStorage(req, res, url, creds) {
    // "/storage/v1/object/<bucket>/<key...>" -> ["object", "<bucket>", ...key segments]. Empty
    // segments are kept so validKey() rejects keys such as "a//b" or a trailing slash.
    let segments;
    try { segments = url.pathname.slice("/storage/v1/".length).split("/").map(decodeURIComponent); } catch { throw E.invalid("Invalid URL encoding"); }
    const [area, first, ...rest] = segments;
    const method = req.method;
    const objectName = parts => parts.join("/");

    if (area === "version" || area === "status") return sendJson(res, 200, { version: "local-stack" });
    if (area === "render") throw E.notImplemented("Image transformation");

    if (area === "bucket") {
      const ctx = caller(creds);
      if (!first && method === "GET") {
        const rows = await asCaller(ctx, "storage.bucket.list", db => db.query("select * from storage.buckets order by name").then(r => r.rows));
        return sendJson(res, 200, rows.map(bucketJson));
      }
      if (!first && method === "POST") {
        const body = await readJson(req);
        const id = body.id ?? body.name;
        if (!validBucketId(id)) throw E.invalid("Bucket name invalid");
        await asCaller(ctx, "storage.bucket.create", db => db.query(
          "insert into storage.buckets(id, name, owner, owner_id, public, file_size_limit, allowed_mime_types) values ($1, $2, $3, $3, $4, $5, $6)",
          [id, body.name ?? id, ctx.sub, Boolean(body.public), body.file_size_limit ?? null, body.allowed_mime_types ?? null]));
        return sendJson(res, 200, { name: id });
      }
      if (first && rest.length === 0 && method === "GET") {
        const rows = await asCaller(ctx, "storage.bucket.get", db => db.query("select * from storage.buckets where id = $1", [first]).then(r => r.rows));
        if (!rows[0]) throw E.noBucket();
        return sendJson(res, 200, bucketJson(rows[0]));
      }
      if (first && rest.length === 0 && method === "PUT") {
        const body = await readJson(req);
        const rows = await asCaller(ctx, "storage.bucket.update", db => db.query(
          `update storage.buckets set public = coalesce($2, public), file_size_limit = case when $3::boolean then $4::bigint else file_size_limit end,
             allowed_mime_types = case when $5::boolean then $6::text[] else allowed_mime_types end, updated_at = now() where id = $1 returning id`,
          [first, typeof body.public === "boolean" ? body.public : null, "file_size_limit" in body, body.file_size_limit ?? null, "allowed_mime_types" in body, body.allowed_mime_types ?? null]).then(r => r.rows));
        if (!rows[0]) throw E.noBucket();
        return sendJson(res, 200, { message: "Successfully updated" });
      }
      if (first && rest.length === 0 && method === "DELETE") {
        const { rows: [{ count }] } = await pool.query("select count(*) from storage.objects where bucket_id = $1", [first]);
        if (Number(count) > 0) throw storageError("409", "InvalidRequest", "InvalidRequest", "The bucket you tried to delete is not empty");
        const rows = await asCaller(ctx, "storage.bucket.delete", db => db.query("delete from storage.buckets where id = $1 returning id", [first]).then(r => r.rows));
        if (!rows[0]) throw E.noBucket();
        return sendJson(res, 200, { message: "Successfully deleted" });
      }
      if (first && rest[0] === "empty" && method === "POST") {
        const names = await asCaller(ctx, "storage.bucket.empty", db => db.query("select name from storage.objects where bucket_id = $1", [first]).then(r => r.rows.map(x => x.name)));
        await removeObjects(ctx, first, names);
        return sendJson(res, 200, { message: "Successfully emptied" });
      }
      throw E.invalid("Unsupported bucket operation");
    }

    if (area !== "object") throw new HttpError(404, { statusCode: "404", error: "Not Found", message: `Route ${method}:${url.pathname} not found` });

    // Signed and public downloads do not require an Authorization header.
    if (first === "sign" && (method === "GET" || method === "HEAD") && rest.length >= 2) {
      const [bucketId, ...parts] = rest, name = objectName(parts);
      let payload;
      try { payload = verifyJwt(url.searchParams.get("token") ?? "", stack.jwtSecret); } catch (error) { throw E.jwt(error instanceof JwtError ? error.message : "Invalid JWT"); }
      if (payload.url !== `${bucketId}/${name}`) throw E.jwt("Invalid signature");
      const { rows } = await pool.query("select * from storage.objects where bucket_id = $1 and name = $2", [bucketId, name]);
      if (!rows[0]) throw E.noKey();
      return sendObject(req, res, rows[0], url);
    }
    if (first === "public" && (method === "GET" || method === "HEAD")) {
      const [bucketId, ...parts] = rest, name = objectName(parts);
      const bucket = await findBucket(bucketId);
      if (!bucket.public) throw E.noBucket();
      const { rows } = await pool.query("select * from storage.objects where bucket_id = $1 and name = $2", [bucketId, name]);
      if (!rows[0]) throw E.noKey();
      return sendObject(req, res, rows[0], url);
    }
    if (first === "upload" && rest[0] === "sign") throw E.notImplemented("Signed upload URLs");

    const ctx = caller(creds);
    if (first === "list" && method === "POST" && rest.length === 1) return sendJson(res, 200, await list(ctx, rest[0], await readJson(req)));
    if (first === "list-v2") throw E.notImplemented("list-v2");
    if (first === "move" && method === "POST") {
      const body = await readJson(req);
      const source = body.bucketId, target = body.destinationBucket ?? body.bucketId;
      if (!body.sourceKey || !body.destinationKey) throw E.invalid("sourceKey and destinationKey are required");
      await findBucket(source); await findBucket(target);
      const from = objectFile(source, body.sourceKey), to = objectFile(target, body.destinationKey);
      const rows = await asCaller(ctx, "storage.object.move", db => db.query(
        "update storage.objects set bucket_id = $3, name = $4, last_accessed_at = now() where bucket_id = $1 and name = $2 returning id",
        [source, body.sourceKey, target, body.destinationKey]).then(r => r.rows));
      if (!rows[0]) throw E.noKey();
      try {
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.rename(from, to);
      } catch (error) { logger(`[storage] metadata moved but bytes could not be moved for ${source}/${body.sourceKey}: ${error.message}`); }
      return sendJson(res, 200, { message: "Successfully moved" });
    }
    if (first === "copy" && method === "POST") {
      const body = await readJson(req);
      const source = body.bucketId, target = body.destinationBucket ?? body.bucketId;
      if (!body.sourceKey || !body.destinationKey) throw E.invalid("sourceKey and destinationKey are required");
      const targetBucket = await findBucket(target);
      const from = objectFile(source, body.sourceKey), to = objectFile(target, body.destinationKey);
      const upsert = String(header(req, "x-upsert") ?? "false") === "true";
      const id = randomUUID();
      const sourceRow = await visibleObject(ctx, source, body.sourceKey, "storage.object.copy");
      if (!mimeAllowed(targetBucket.allowed_mime_types, sourceRow.metadata?.mimetype)) throw E.mime(sourceRow.metadata?.mimetype);
      await asCaller(ctx, "storage.object.copy", db => db.query(
        `insert into storage.objects(id, bucket_id, name, owner, owner_id, metadata, user_metadata, version) values ($1, $2, $3, $4, $4, $5, $6, $7)
         ${upsert ? "on conflict (bucket_id, name) do update set metadata = excluded.metadata, user_metadata = excluded.user_metadata, version = excluded.version" : ""}`,
        [id, target, body.destinationKey, ctx.sub, JSON.stringify(body.metadata ? { ...sourceRow.metadata, ...body.metadata } : sourceRow.metadata), sourceRow.user_metadata ? JSON.stringify(sourceRow.user_metadata) : null, randomUUID()]));
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to);
      return sendJson(res, 200, { Id: id, Key: `${target}/${body.destinationKey}` });
    }
    if (first === "sign" && method === "POST") {
      const body = await readJson(req);
      if (rest.length === 1) { // createSignedUrls
        const bucketId = rest[0];
        if (!Array.isArray(body.paths)) throw E.invalid("paths must be an array");
        const visible = await asCaller(ctx, "storage.object.sign", db =>
          db.query("select name from storage.objects where bucket_id = $1 and name = any($2::text[])", [bucketId, body.paths]).then(r => new Set(r.rows.map(x => x.name))));
        return sendJson(res, 200, body.paths.map(p => visible.has(p)
          ? { error: null, path: p, signedURL: signedPath(bucketId, p, body.expiresIn) }
          : { error: "Either the object does not exist or you do not have access to it", path: p, signedURL: null }));
      }
      const [bucketId, ...parts] = rest, name = objectName(parts);
      await visibleObject(ctx, bucketId, name, "storage.object.sign");
      return sendJson(res, 200, { signedURL: signedPath(bucketId, name, body.expiresIn) });
    }
    if (first === "info") {
      const parts = rest[0] === "authenticated" || rest[0] === "public" ? rest.slice(1) : rest;
      const [bucketId, ...keyParts] = parts;
      const row = await visibleObject(ctx, bucketId, objectName(keyParts), "storage.object.info");
      const meta = row.metadata ?? {};
      return sendJson(res, 200, {
        id: row.id, version: row.version, name: row.name, bucket_id: row.bucket_id, size: meta.size, content_type: meta.mimetype,
        cache_control: meta.cacheControl, etag: meta.eTag, metadata: row.user_metadata ?? {}, last_modified: meta.lastModified,
        created_at: iso(row.created_at), updated_at: iso(row.updated_at),
      });
    }
    if ((method === "GET" || method === "HEAD") && first) {
      const parts = first === "authenticated" ? rest : [first, ...rest];
      const [bucketId, ...keyParts] = parts;
      await findBucket(bucketId);
      return sendObject(req, res, await visibleObject(ctx, bucketId, objectName(keyParts), "storage.object.get"), url);
    }
    if ((method === "POST" || method === "PUT") && first && rest.length) {
      // storage-js sends x-upsert on POST; PUT (update) overwrites an existing object (upsert semantics).
      const upsert = method === "PUT" || String(header(req, "x-upsert") ?? "false") === "true";
      return upload(req, res, ctx, first, objectName(rest), { upsert });
    }
    if (method === "DELETE" && first && rest.length === 0) {
      const body = await readJson(req);
      if (!Array.isArray(body.prefixes) || body.prefixes.some(p => typeof p !== "string")) throw E.invalid("prefixes must be an array of strings");
      await findBucket(first);
      return sendJson(res, 200, (await removeObjects(ctx, first, body.prefixes)).map(objectJson));
    }
    if (method === "DELETE" && first && rest.length) {
      await findBucket(first);
      const deleted = await removeObjects(ctx, first, [objectName(rest)]);
      if (!deleted.length) throw E.noKey();
      return sendJson(res, 200, { message: "Successfully deleted" });
    }
    throw new HttpError(404, { statusCode: "404", error: "Not Found", message: `Route ${method}:${url.pathname} not found` });
  };
}
