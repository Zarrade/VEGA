// VEGA relay: a small server-side proxy for the VEGA command deck.
//
// - Holds the OpenRouter key server-side (secret OPENROUTER_API_KEY) so the
//   public page never contains it.
// - Allows FREE models only; a paid model is refused before any upstream call.
// - Adds two web tools the browser cannot do itself: /search and /read.
// - Only answers browsers on the origins listed in ALLOWED_ORIGINS.
//
// Written as plain JavaScript in a .ts file so it runs unchanged on Supabase
// Edge Functions (Deno) and can be unit-tested in Node.

const OR = "https://openrouter.ai/api/v1";
const g = globalThis;
const env = (k, d = "") => {
  try { return (g.Deno ? g.Deno.env.get(k) : g.process?.env?.[k]) ?? d; } catch { return d; }
};
const origins = () => env("ALLOWED_ORIGINS", "https://zarrade.github.io,http://localhost:8080")
  .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
const MAX_TOKENS = 4096, MAX_BODY = 8 * 1024 * 1024, PER_MIN = 40;

const cors = (origin) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
});
const json = (body, status, origin) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", ...(origin ? cors(origin) : {}) },
});
const fail = (message, status, origin) => json({ error: { message } }, status, origin);

// ---- free model list (cached 10 minutes) ----
let cache = { t: 0, ids: new Set(), data: [] };
async function freeModels() {
  if (Date.now() - cache.t < 600000 && cache.data.length) return cache;
  const r = await fetch(OR + "/models");
  if (!r.ok) throw new Error("model list unavailable");
  const j = await r.json();
  const data = (j.data || []).filter((m) => m && m.pricing && +m.pricing.prompt === 0 && +m.pricing.completion === 0);
  cache = { t: Date.now(), ids: new Set(data.map((m) => m.id)), data };
  return cache;
}

// ---- per-address rate limit (best effort: memory is per instance) ----
const hits = new Map();
function limited(req) {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const now = Date.now(), list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > PER_MIN;
}

// ---- web tools ----
const UA = "Mozilla/5.0 (compatible; VEGA-relay/1.0)";
const decode = (s) => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/\s+/g, " ").trim();

function publicUrl(raw) {
  let u; try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".") && !h.includes(":")) return null;
  if (/^(0|10|127)\./.test(h) || /^169\.254\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return null;
  if (h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe80/.test(h) || h.startsWith("::ffff:")) return null;
  return u;
}

async function search(q) {
  const out = [];
  try {
    const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), { headers: { "User-Agent": UA, "Accept-Language": "en" } });
    const html = await r.text();
    const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|$)/g;
    let m;
    while ((m = re.exec(html)) && out.length < 6) {
      let url = m[1].replace(/&amp;/g, "&");
      const k = url.match(/[?&]uddg=([^&]+)/);
      if (k) url = decodeURIComponent(k[1]);
      if (url.startsWith("//")) url = "https:" + url;
      if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
      const s = m[3].match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/);
      out.push({ title: decode(m[2]), url, snippet: s ? decode(s[1]) : "" });
    }
  } catch { /* fall through to the encyclopedia */ }
  if (!out.length) {
    try {
      const r = await fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=" + encodeURIComponent(q), { headers: { "User-Agent": UA } });
      const j = await r.json();
      for (const p of j.query?.search || []) out.push({ title: p.title, url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(p.title.replace(/ /g, "_")), snippet: decode(p.snippet || "") });
    } catch { /* nothing found */ }
  }
  return out;
}

async function read(raw) {
  let u = publicUrl(raw);
  if (!u) throw new Error("That address is not allowed.");
  let r;
  for (let hop = 0; hop < 4; hop++) {
    r = await fetch(u.href, { redirect: "manual", headers: { "User-Agent": UA, "Accept": "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" } });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      u = publicUrl(new URL(r.headers.get("location"), u).href);
      if (!u) throw new Error("That page redirects to an address that is not allowed.");
      continue;
    }
    break;
  }
  if (!r.ok) throw new Error("The page answered with status " + r.status + ".");
  const type = r.headers.get("content-type") || "";
  if (!/text\/|json|xml/.test(type)) throw new Error("That address is not a readable text page (" + (type.split(";")[0] || "unknown type") + ").");
  const rd = r.body.getReader(), dec = new TextDecoder(); let body = "", n = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; body += dec.decode(value, { stream: true }); if (n > 2000000) { try { await rd.cancel(); } catch { /* ignore */ } break; } }
  let title = "", text = body;
  if (/html/.test(type) || /^\s*<(!doctype|html)/i.test(body)) {
    title = decode((body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
    text = body.replace(/<(head|script|style|noscript|svg|template|iframe|nav|footer|header|form)\b[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
    text = text.split("\n").map(decode).filter(Boolean).join("\n");
  }
  return { url: u.href, title, text: text.slice(0, 12000), truncated: text.length > 12000 };
}

// ---- request handler ----
export async function handler(req) {
  const origin = (req.headers.get("origin") || "").replace(/\/+$/, "");
  const ok = origins().includes(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: ok ? 204 : 403, headers: ok ? cors(origin) : {} });
  if (!ok) return fail("This relay only answers the VEGA deck.", 403);
  if (limited(req)) return fail("Too many requests. Wait a minute and try again.", 429, origin);
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, "");
  try {
    if (req.method === "GET" && path.endsWith("/health")) return json({ ok: true, tools: ["search", "read"] }, 200, origin);
    if (req.method === "GET" && path.endsWith("/models")) return json({ data: (await freeModels()).data }, 200, origin);
    if (req.method === "GET" && path.endsWith("/search")) {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 300);
      if (!q) return fail("Missing search text.", 400, origin);
      return json({ query: q, results: await search(q) }, 200, origin);
    }
    if (req.method === "GET" && path.endsWith("/read")) {
      try { return json(await read(url.searchParams.get("url") || ""), 200, origin); }
      catch (e) { return fail(e.message || "The page could not be read.", 422, origin); }
    }
    if (req.method === "POST" && path.endsWith("/chat/completions")) {
      const key = env("OPENROUTER_API_KEY");
      if (!key) return fail("The relay has no OpenRouter key configured.", 500, origin);
      if (+(req.headers.get("content-length") || 0) > MAX_BODY) return fail("Request too large.", 413, origin);
      let body; try { body = await req.json(); } catch { return fail("Invalid JSON body.", 400, origin); }
      if (!body || typeof body.model !== "string" || !Array.isArray(body.messages)) return fail("model and messages are required.", 400, origin);
      if (!(await freeModels()).ids.has(body.model)) return fail("Only free models are allowed on this relay.", 403, origin);
      const send = { model: body.model, messages: body.messages, stream: !!body.stream, max_tokens: Math.min(+body.max_tokens || MAX_TOKENS, MAX_TOKENS) };
      if (typeof body.temperature === "number") send.temperature = Math.max(0, Math.min(2, body.temperature));
      const up = await fetch(OR + "/chat/completions", {
        method: "POST", signal: req.signal,
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json", "X-Title": "VEGA" },
        body: JSON.stringify(send),
      });
      return new Response(up.body, { status: up.status, headers: { "Content-Type": up.headers.get("content-type") || "application/json", "Cache-Control": "no-store", ...cors(origin) } });
    }
    return fail("Not found.", 404, origin);
  } catch (e) {
    return fail("The relay could not complete that request.", 502, origin);
  }
}

if (g.Deno) g.Deno.serve(handler);
