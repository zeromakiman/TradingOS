// /rest/v1/* -> PostgREST. Mirrors the Supabase API gateway: the apikey header must be a valid
// project key and the Authorization header is rewritten (see credentials() in index.mjs).
import http from "node:http";
import { HOP_BY_HOP, sendJson } from "./http.mjs";

export function createRestProxy({ host, port }) {
  return function proxyRest(req, res, url, creds) {
    const upstreamPath = url.pathname.slice("/rest/v1".length) || "/";
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(name) || name === "host" || name === "authorization") continue;
      headers[name] = value;
    }
    headers.host = `${host}:${port}`;
    if (creds.bearer) headers.authorization = `Bearer ${creds.bearer}`;
    headers["x-forwarded-host"] = req.headers.host ?? "";
    headers["x-forwarded-proto"] = "http";

    const upstream = http.request({ host, port, method: req.method, path: `${upstreamPath}${url.search}`, headers }, response => {
      const out = {};
      for (const [name, value] of Object.entries(response.headers)) if (!HOP_BY_HOP.has(name)) out[name] = value;
      res.writeHead(response.statusCode ?? 502, out);
      response.on("error", () => res.destroy());
      response.pipe(res);
    });
    res.on("close", () => { if (!res.writableFinished) upstream.destroy(); }); // client went away
    upstream.on("error", () => {
      if (!res.headersSent) sendJson(res, 502, { message: "An invalid response was received from the upstream server" });
      else res.destroy();
    });
    req.pipe(upstream);
  };
}
