/* ============================================================
   Spec Load — turns raw API description text into an object and
   says what it is (OpenAPI 3.x or Swagger 2.0). Also finds the
   real spec URL behind a Swagger UI / Redoc / RapiDoc page, so
   "use the current tab" works on a docs page, not only on the
   raw openapi.json.
   ============================================================ */
(function (global) {
  /** JSON first (the common case, and exact), YAML otherwise. `yaml` is the js-yaml module
   *  (page global `jsyaml`), passed in so this file stays loadable in Node without it. */
  function parseSpecText(text, yaml) {
    const trimmed = String(text || "").replace(/^﻿/, "").trim();
    if (!trimmed) throw new Error("The API description is empty.");
    if (trimmed.startsWith("{")) {
      try {
        return JSON.parse(trimmed);
      } catch (e) {
        throw new Error(`The API description looks like JSON but could not be parsed: ${e.message}`);
      }
    }
    if (trimmed.startsWith("<")) {
      throw new Error("This is an HTML page, not an API description. Open the raw openapi.json / swagger.json (or .yaml) instead.");
    }
    if (!yaml) throw new Error("YAML support is not loaded.");
    let doc;
    try {
      doc = yaml.load(trimmed);
    } catch (e) {
      throw new Error(`The API description could not be parsed as YAML: ${e.message}`);
    }
    if (!doc || typeof doc !== "object") throw new Error("The API description is not a JSON/YAML object.");
    return doc;
  }

  function detectSpecVersion(doc) {
    if (doc && typeof doc.openapi === "string" && /^3\.[01]\./.test(doc.openapi)) {
      return { kind: "oas3", version: doc.openapi };
    }
    if (doc && String(doc.swagger) === "2.0") return { kind: "swagger2", version: "2.0" };
    if (doc && typeof doc.openapi === "string") {
      throw new Error(`OpenAPI ${doc.openapi} is not supported (3.0 and 3.1 are).`);
    }
    if (doc && doc.swagger) throw new Error(`Swagger ${doc.swagger} is not supported (2.0 is).`);
    if (doc && doc.info && doc.item) throw new Error("This is a Postman collection. Only OpenAPI 3.x and Swagger 2.0 are supported.");
    throw new Error("This is not an OpenAPI 3.x or Swagger 2.0 description (no `openapi` or `swagger` field).");
  }

  /** The spec URL a docs page loads, resolved against the page URL, or null. Covers the usual
   *  hosts: Swagger UI (`url: "..."` / `urls: [{url}]` in its init script, or `?url=` on the page
   *  itself), Redoc (`<redoc spec-url>` / `Redoc.init("...")`), RapiDoc (`<rapi-doc spec-url>`). */
  function findSpecUrlInHtml(html, pageUrl) {
    const text = String(html || "");
    const patterns = [
      /<redoc[^>]*\bspec-url\s*=\s*["']([^"']+)["']/i,
      /<rapi-doc[^>]*\bspec-url\s*=\s*["']([^"']+)["']/i,
      /Redoc\.init\(\s*["']([^"']+)["']/,
      /SwaggerUIBundle\(\s*\{[\s\S]*?\burl\s*:\s*["']([^"']+)["']/,
      /\burls\s*:\s*\[\s*\{[^}]*?\burl\s*:\s*["']([^"']+)["']/,
      /["']?(?:configUrl|url)["']?\s*:\s*["']([^"']+\.(?:json|ya?ml)(?:\?[^"']*)?)["']/i
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return resolveUrl(m[1], pageUrl);
    }
    try {
      const fromQuery = new URL(pageUrl).searchParams.get("url");
      if (fromQuery) return resolveUrl(fromQuery, pageUrl);
    } catch (e) { /* not a URL */ }
    return null;
  }

  /** Swagger UI 4+ keeps its config in a separate script (swagger-initializer.js). */
  function findInitializerScript(html, pageUrl) {
    const m = String(html || "").match(/<script[^>]+src\s*=\s*["']([^"']*(?:initializer|swagger-config)[^"']*)["']/i);
    return m ? resolveUrl(m[1], pageUrl) : null;
  }

  /** One fetched response on the way to the spec: `{ doc }` when it is the spec itself, `{ next }`
   *  when it only points at it (a docs page, Swagger UI's initializer script, springdoc's
   *  swagger-config JSON), or a thrown, readable error. */
  function resolveFetched({ text, url, contentType }, yaml) {
    const trimmed = String(text || "").replace(/^\uFEFF/, "").trim();
    let pathname = "";
    try { pathname = new URL(url).pathname; } catch (e) { /* keep "" */ }
    if (/javascript|ecmascript/i.test(contentType || "") || /\.m?js$/i.test(pathname)) {
      const next = findSpecUrlInHtml(trimmed, url);
      if (next) return { next };
      throw new Error(`The script ${url} does not name an API description URL.`);
    }
    if (trimmed.startsWith("<")) {
      const next = findSpecUrlInHtml(trimmed, url) || findInitializerScript(trimmed, url);
      if (next) return { next };
      throw new Error("This page does not point at an OpenAPI/Swagger description I can find. Open the raw openapi.json / swagger.json (or .yaml) and try again.");
    }
    const doc = parseSpecText(trimmed, yaml);
    if (doc.openapi || doc.swagger) return { doc };
    if (typeof doc.url === "string") return { next: resolveUrl(doc.url, url) };
    if (Array.isArray(doc.urls) && doc.urls[0] && typeof doc.urls[0].url === "string") return { next: resolveUrl(doc.urls[0].url, url) };
    detectSpecVersion(doc); // throws the readable "not an OpenAPI…" error
    return { doc };
  }

  function resolveUrl(url, base) {
    try {
      return new URL(url, base).href;
    } catch (e) {
      return url;
    }
  }

  const api = { parseSpecText, detectSpecVersion, findSpecUrlInHtml, findInitializerScript, resolveFetched };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof global !== "undefined") {
    global.ApiSpecLoad = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
