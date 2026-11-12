// VEGA relay: a small server-side proxy for the VEGA command deck.
//
// - Holds the OpenRouter key server-side (secret OPENROUTER_API_KEY) so the
//   public page never contains it.
// - Allows FREE models only; a paid model is refused before any upstream call.
// - Adds two web tools the browser cannot do itself: /search and /read.
// - Only answers browsers on the origins listed in ALLOWED_ORIGINS.
// - Runs timers, sentries and scheduled protocols in the background and
//   notifies the installed app through web push.
// - Stores the deck's end-to-end encrypted state so several devices can share it.
// - Uses a search API first when BRAVE_API_KEY or TAVILY_API_KEY is set.
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
const MAX_TOKENS = 4096, MAX_BODY = 8 * 1024 * 1024, PER_MIN = 120; // the deck asks several models at once

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
// music, speech and image generators are free too, but they cannot hold a conversation
function chatCapable(m) {
  const id = String(m.id || ""), out = m.architecture && m.architecture.output_modalities;
  if (/lyria|music|tts|whisper|embed|imagen|flux|sdxl|veo|sora|inkling/i.test(id)) return false;
  return !out || (out.includes("text") && !out.includes("audio"));
}
const MPREF = [/deepseek|qwen3|llama-4|gemini|gemma-4-31|nemotron-3-ultra|kimi|glm|gpt-oss/, /nemotron-3\.5-super|ernie|gemma|llama|qwen|mistral|grok|hermes/, /nemotron|dots|flint|north|phi/];
const TINY = /\b(lfm|1\.\db|2\.\db|3b|nano|lightning|mini|small)\b|lfm-/i;
const rankModel = (m) => { const i = MPREF.findIndex((p) => p.test(m.id)); return (i < 0 ? 1.5 : i) + (TINY.test(m.id) ? 5 : 0) + (m.id === "openrouter/free" ? 4 : 0); };

async function freeModels() {
  if (Date.now() - cache.t < 600000 && cache.data.length) return cache;
  const r = await fetch(OR + "/models");
  if (!r.ok) throw new Error("model list unavailable");
  const j = await r.json();
  const data = (j.data || []).filter((m) => m && m.pricing && +m.pricing.prompt === 0 && +m.pricing.completion === 0 && chatCapable(m));
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
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
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

async function news(q) {
  const out = [];
  try {
    const r = await fetch("https://news.google.com/rss/search?hl=en&q=" + encodeURIComponent(q), { headers: { "User-Agent": BROWSER_UA } });
    const xml = await r.text(), re = /<item>([\s\S]*?)<\/item>/g; let m;
    while ((m = re.exec(xml)) && out.length < 4) {
      const pick = (t) => decode(((m[1].match(new RegExp("<" + t + "[^>]*>([\\s\\S]*?)</" + t + ">")) || [])[1] || "").replace(/^<!\[CDATA\[|\]\]>$/g, ""));
      const title = pick("title"), url = pick("link"); if (!title || !/^https?:\/\//.test(url)) continue;
      out.push({ title, url, snippet: "News, " + pick("pubDate").replace(/ \d\d:\d\d:\d\d.*$/, "") + (pick("source") ? ", " + pick("source") : "") });
    }
  } catch { /* news is optional */ }
  return out;
}

const ddgUrl = (href) => {
  let url = href.replace(/&amp;/g, "&");
  const k = url.match(/[?&]uddg=([^&]+)/);
  if (k) url = decodeURIComponent(k[1]);
  if (url.startsWith("//")) url = "https:" + url;
  return /^https?:\/\//.test(url) && !/duckduckgo\.com\/y\.js/.test(url) ? url : null;
};
const getHtml = async (url) => {
  const r = await fetch(url, { headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9", "Accept": "text/html" } });
  return r.ok ? await r.text() : "";
};
const parseDdg = (html) => {
  const out = [], re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|$)/g; let m;
  while ((m = re.exec(html)) && out.length < 8) {
    const url = ddgUrl(m[1]); if (!url) continue;
    const sn = m[3].match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/);
    out.push({ title: decode(m[2]), url, snippet: sn ? decode(sn[1]) : "" });
  }
  return out;
};
const ENGINES = {
  // the search engine answers the database's network but not the function's, so ask the database to fetch
  async db(q) { return parseDdg(String((await db().rpc("vega_search_html", { q })) || "")); },
  async ddg(q) { return parseDdg(await getHtml("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q))); },
  async lite(q) {
    const html = await getHtml("https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q)), out = [];
    const re = /<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class=['"]result-link|$)/g; let m;
    while ((m = re.exec(html)) && out.length < 8) {
      const url = ddgUrl(m[1]); if (!url) continue;
      const sn = m[3].match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/);
      out.push({ title: decode(m[2]), url, snippet: sn ? decode(sn[1]) : "" });
    }
    return out;
  },
  // proper search APIs: used first when their key is set as a secret
  async brave(q) {
    const key = env("BRAVE_API_KEY"); if (!key) return [];
    const r = await fetch("https://api.search.brave.com/res/v1/web/search?count=8&q=" + encodeURIComponent(q), { headers: { "X-Subscription-Token": key, "Accept": "application/json" } });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.web?.results || []).slice(0, 8).map((x) => ({ title: decode(x.title || ""), url: x.url, snippet: decode(x.description || "") })).filter((x) => /^https?:\/\//.test(x.url || ""));
  },
  async tavily(q) {
    const key = env("TAVILY_API_KEY"); if (!key) return [];
    const r = await fetch("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key }, body: JSON.stringify({ api_key: key, query: q, max_results: 8 }) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.results || []).slice(0, 8).map((x) => ({ title: String(x.title || ""), url: x.url, snippet: String(x.content || "").replace(/\s+/g, " ").slice(0, 320) })).filter((x) => /^https?:\/\//.test(x.url || ""));
  },
  async wiki(q) {
    const r = await fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=" + encodeURIComponent(q), { headers: { "User-Agent": UA } });
    const j = await r.json();
    return (j.query?.search || []).map((p) => ({ title: p.title, url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(p.title.replace(/ /g, "_")), snippet: decode(p.snippet || "") }));
  },
};
const STOP = /^(what|when|where|which|with|from|that|this|have|does|about|latest|news|today|into|your|their|there)$/;
const relevant = (q, list) => {
  const terms = (q.toLowerCase().match(/[a-z0-9À-￿]{4,}/g) || []).filter((t) => !STOP.test(t));
  if (!terms.length) return list;
  return list.filter((r) => terms.some((t) => (r.title + " " + r.snippet + " " + r.url).toLowerCase().includes(t)));
};
let lastEngine = "db";
async function search(q) {
  const lead = /\b(news|latest|today|tonight|headlines?|breaking|this week|recent(ly)?|update[sd]?)\b/i.test(q) ? await news(q) : [];
  const keyed = [env("BRAVE_API_KEY") ? "brave" : "", env("TAVILY_API_KEY") ? "tavily" : ""].filter(Boolean);
  const order = [...keyed, ...[lastEngine, "db", "ddg", "lite", "wiki"].filter((e, i, a) => !keyed.includes(e) && a.indexOf(e) === i)];
  for (const name of order) {
    try {
      const got = relevant(q, await ENGINES[name](q));
      if (got.length) { if (name !== "wiki" && !keyed.includes(name)) lastEngine = name; return { engine: name, results: [...lead, ...got].slice(0, 9) }; }
    } catch { /* try the next engine */ }
  }
  return { engine: lead.length ? "news" : "none", results: lead };
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

// ---- background service: devices, scheduled jobs, inbox, web push ----
// The deck registers a device (a random id plus a browser push subscription) and
// syncs its timers, sentries and scheduled protocols as jobs. A database cron
// calls /cron every minute; due jobs are turned into inbox items and the device
// gets an empty "tickle" push, on which its service worker fetches the inbox.
const DEVICE = /^[a-f0-9-]{32,80}$/;
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/;
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const q = encodeURIComponent;

async function rest(method, path, body, prefer) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(env("SUPABASE_URL") + "/rest/v1/" + path, {
    method, headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error("db " + r.status + " " + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}
const db = () => g.__vegaDb || {
  get: (t, query) => rest("GET", t + "?" + query),
  insert: (t, rows) => rest("POST", t, rows, "return=representation"),
  upsert: (t, rows, on) => rest("POST", t + "?on_conflict=" + on, rows, "resolution=merge-duplicates,return=minimal"),
  update: (t, query, patch) => rest("PATCH", t + "?" + query, patch, "return=minimal"),
  del: (t, query) => rest("DELETE", t + "?" + query, undefined, "return=minimal"),
  rpc: (fn, args) => rest("POST", "rpc/" + fn, args),
  patch: (t, query, patch) => rest("PATCH", t + "?" + query, patch, "return=representation"),
};

let vapidCache = null, cronKey = null;
async function vapid() {
  if (vapidCache) return vapidCache;
  let rows = await db().get("vega_config", "key=eq.vapid&select=value");
  if (!rows.length) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const priv = await crypto.subtle.exportKey("jwk", kp.privateKey), pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
    try { await db().insert("vega_config", [{ key: "vapid", value: { priv, pub } }]); } catch { /* another instance won the race */ }
    rows = await db().get("vega_config", "key=eq.vapid&select=value");
  }
  return vapidCache = rows[0].value;
}
export async function vapidHeader(endpoint) {
  const v = await vapid();
  const key = await crypto.subtle.importKey("jwk", v.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = part({ typ: "JWT", alg: "ES256" }) + "." + part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env("VAPID_SUBJECT", "https://zarrade.github.io/vega/") });
  const sig = b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned)));
  return { header: "vapid t=" + unsigned + "." + sig + ", k=" + v.pub, token: unsigned + "." + sig, pub: v.pub };
}
async function pushSend(endpoint) {
  const { header } = await vapidHeader(endpoint);
  const r = await fetch(endpoint, { method: "POST", headers: { TTL: "86400", Urgency: "high", Authorization: header, "Content-Length": "0" } });
  return r.status;
}
const validEndpoint = (e) => { try { const u = new URL(e); return u.protocol === "https:" && PUSH_HOSTS.test(u.hostname); } catch { return false; } };
const textHash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h); };
const inbox = (device, item) => db().insert("vega_inbox", [{ device, title: item.title, body: item.body, tag: item.tag, data: item.data || {} }]);

// A scheduled protocol runs here, unattended, with the snapshot of the deck the device last synced.
const clip = (v, n) => String(v ?? "").slice(0, n);
const listOf = (v, n, each) => (Array.isArray(v) ? v : []).slice(0, n).map((x) => clip(x, each));
function cleanContext(c) {
  c = c && typeof c === "object" ? c : {};
  return { name: clip(c.name || "VEGA", 20), user: clip(c.user, 30), home: clip(c.home, 60), tz: clip(c.tz, 40),
    tasks: listOf(c.tasks, 25, 160), notes: listOf(c.notes, 10, 200), memory: listOf(c.memory, 25, 200), timers: listOf(c.timers, 10, 80) };
}
async function weatherLine(place) {
  try {
    const gj = await (await fetch("https://geocoding-api.open-meteo.com/v1/search?count=1&name=" + encodeURIComponent(place))).json();
    const l = gj.results && gj.results[0]; if (!l) return "";
    const f = await (await fetch("https://api.open-meteo.com/v1/forecast?latitude=" + l.latitude + "&longitude=" + l.longitude + "&current=temperature_2m,apparent_temperature,wind_speed_10m,precipitation&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1&timezone=auto")).json();
    const c = f.current || {}, d = f.daily || {};
    return l.name + ": " + c.temperature_2m + "°C now (feels " + c.apparent_temperature + "°C), wind " + c.wind_speed_10m + " km/h; today " + (d.temperature_2m_min || [])[0] + " to " + (d.temperature_2m_max || [])[0] + "°C, rain chance " + (d.precipitation_probability_max || [])[0] + "%.";
  } catch { return ""; }
}
export async function runProtocolJob(job, ctx) {
  const key = env("OPENROUTER_API_KEY"); if (!key) return null;
  const c = cleanContext(ctx), steps = clip(job.payload && job.payload.steps, 1500); if (!steps) return null;
  let when = new Date().toUTCString();
  try { if (c.tz) when = new Date().toLocaleString("en-GB", { timeZone: c.tz, dateStyle: "full", timeStyle: "short" }); } catch { /* keep UTC */ }
  const wx = c.home ? await weatherLine(c.home) : "";
  const system = "You are " + c.name + ", a refined British AI butler to a brilliant inventor: composed, impeccably polite, warm underneath and drily funny, with one light touch of wit at most. " +
    "Speak in natural sentences with British phrasing, lead with what matters, never say 'As an AI', never end with offers of further help, no exclamation marks. " +
    "You are running a scheduled protocol unattended; the user will read this as a notification and then in their deck. " +
    "Write the finished result directly, in plain sentences, under 130 words. You cannot use tools here: work only from the context below and do not invent facts. " +
    (c.user ? 'Address the user as "' + c.user + '" at most once.\n' : "\n") +
    "\nCONTEXT\nNow: " + when + "\nWeather: " + (wx || "unknown") +
    "\nOpen tasks: " + (c.tasks.join("; ") || "none") + "\nNotes: " + (c.notes.join("; ") || "none") +
    "\nActive timers: " + (c.timers.join("; ") || "none") + "\nLong-term memory: " + (c.memory.join("; ") || "empty");
  const all = [...(await freeModels()).data].sort((a, b) => rankModel(a) - rankModel(b) || (b.context_length || 0) - (a.context_length || 0));
  const models = all.filter((m) => m.id !== "openrouter/free").slice(0, 4).concat(all.filter((m) => m.id === "openrouter/free"));
  for (const m of models) {
    try {
      const r = await fetch(OR + "/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json", "X-Title": "VEGA" },
        body: JSON.stringify({ model: m.id, max_tokens: 1600, temperature: 0.6, reasoning: { effort: "low", exclude: true }, messages: [{ role: "system", content: system }, { role: "user", content: 'Run the "' + job.label + '" protocol: ' + steps }] }) });
      if (!r.ok) continue;
      const j = await r.json(), text = String(j.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<<act[\s\S]*?>>/g, "").trim();
      if (text.length > 12) return text.slice(0, 2400);
    } catch { /* try the next model */ }
  }
  return null;
}

async function syncJobs(device, jobs) {
  const have = await db().get("vega_jobs", "device=eq." + q(device) + "&select=id,kind,payload,hash");
  const clean = [];
  for (const j of (Array.isArray(jobs) ? jobs : []).slice(0, 30)) {
    const label = String(j.label || "").slice(0, 80);
    if (j.kind === "timer" || j.kind === "protocol") {
      const at = +j.at; if (!(at > Date.now() - 6e4) || at > Date.now() + 366 * 864e5) continue;
      clean.push({ device, kind: j.kind, label, payload: { tag: String(j.tag || "").slice(0, 40), ...(j.kind === "protocol" ? { steps: clip(j.steps, 1500) } : {}) }, next_at: new Date(at).toISOString(), every_min: j.kind === "protocol" ? 1440 : null, hash: null });
    } else if (j.kind === "watch") {
      const u = publicUrl(String(j.url || "")); if (!u) continue;
      const every = Math.max(5, Math.min(1440, Math.round(+j.every || 30)));
      const old = have.find((h) => h.kind === "watch" && h.payload && h.payload.url === u.href);
      clean.push({ device, kind: "watch", label, payload: { url: u.href }, next_at: new Date(Date.now() + (old ? every * 6e4 : 0)).toISOString(), every_min: every, hash: old ? old.hash : null });
    }
  }
  if (clean.filter((c) => c.kind === "watch").length > 8) throw new Error("too many sentries");
  await db().del("vega_jobs", "device=eq." + q(device));
  if (clean.length) await db().insert("vega_jobs", clean);
  await db().update("vega_devices", "id=eq." + q(device), { last_seen: new Date().toISOString() });
  return clean.length;
}

export async function runCron() {
  const now = Date.now();
  const due = await db().get("vega_jobs", "next_at=lte." + q(new Date(now).toISOString()) + "&order=next_at.asc&limit=40&select=*");
  const notify = new Set();
  for (const j of due) {
    try {
      if (j.kind === "timer") {
        await inbox(j.device, { title: "VEGA · timer", body: "Timer complete: " + j.label, tag: (j.payload && j.payload.tag) || "t" + j.id, data: { kind: "timer" } });
        await db().del("vega_jobs", "id=eq." + j.id); notify.add(j.device);
      } else if (j.kind === "protocol") {
        let next = Date.parse(j.next_at); while (next <= now) next += 864e5;
        await db().update("vega_jobs", "id=eq." + j.id, { next_at: new Date(next).toISOString() });
        let text = null;
        try { const dev = (await db().get("vega_devices", "id=eq." + q(j.device) + "&select=context"))[0]; text = await runProtocolJob(j, dev && dev.context); } catch { /* fall back to a prompt to run it */ }
        if (text) await inbox(j.device, { title: "VEGA · " + j.label, body: text.replace(/[*_#`]/g, "").slice(0, 240), tag: "p-" + j.label, data: { kind: "report", label: j.label, text } });
        else await inbox(j.device, { title: "VEGA · " + j.label + " protocol", body: "Scheduled for now. Open VEGA to run it.", tag: "p-" + j.label, data: { kind: "protocol", run: j.label } });
        notify.add(j.device);
      } else if (j.kind === "watch") {
        let h = null;
        try { h = textHash((await read(j.payload.url)).text.replace(/\d{1,2}:\d{2}(:\d{2})?/g, "")); } catch { /* unreachable this round */ }
        if (h != null && j.hash != null && h !== j.hash) {
          await inbox(j.device, { title: "VEGA · sentry", body: j.label + " has changed.", tag: "w-" + j.id, data: { kind: "watch", url: j.payload.url, label: j.label } }); notify.add(j.device);
        }
        await db().update("vega_jobs", "id=eq." + j.id, { next_at: new Date(now + (j.every_min || 30) * 6e4).toISOString(), hash: h ?? j.hash });
      }
    } catch { /* one bad job must not stop the rest */ }
  }
  let pushed = 0;
  for (const d of notify) {
    try {
      const dev = (await db().get("vega_devices", "id=eq." + q(d) + "&select=endpoint"))[0]; if (!dev) continue;
      const st = await pushSend(dev.endpoint);
      if (st === 404 || st === 410) await db().del("vega_devices", "id=eq." + q(d)); else if (st >= 200 && st < 300) pushed++;
    } catch { /* push service unavailable */ }
  }
  if (new Date(now).getUTCMinutes() === 7) {
    try { await db().del("vega_inbox", "created_at=lt." + q(new Date(now - 3 * 864e5).toISOString())); await db().del("vega_devices", "last_seen=lt." + q(new Date(now - 60 * 864e5).toISOString())); } catch { /* housekeeping can wait */ }
  }
  return { due: due.length, notified: notify.size, pushed };
}

// The deck encrypts its state in the browser; this stores only the ciphertext, keyed by a hash of the sync code.
const SYNC_ID = /^[a-f0-9]{64}$/, SYNC_MAX = 3000000;
async function state(req, url, origin) {
  if (req.method === "GET") {
    const id = url.searchParams.get("id") || "", have = +(url.searchParams.get("rev") || 0);
    if (!SYNC_ID.test(id)) return fail("Unknown sync id.", 400, origin);
    const row = (await db().get("vega_sync", "id=eq." + id + "&select=rev,blob"))[0];
    if (!row) return json({ rev: 0 }, 200, origin);
    return json(+row.rev === have ? { rev: +row.rev, same: true } : { rev: +row.rev, blob: row.blob }, 200, origin);
  }
  let body; try { body = await req.json(); } catch { return fail("Invalid JSON body.", 400, origin); }
  const id = String((body && body.id) || ""), base = +(body && body.base) || 0, blob = body && body.blob;
  if (!SYNC_ID.test(id) || typeof blob !== "string" || !blob) return fail("id and blob are required.", 400, origin);
  if (blob.length > SYNC_MAX) return fail("That is too much to sync. Remove some Library documents or saved conversations.", 413, origin);
  const now = new Date().toISOString();
  let saved = null;
  if (base === 0) { try { saved = (await db().insert("vega_sync", [{ id, blob, rev: 1, updated_at: now }]))[0]; } catch { /* someone else created it first */ } }
  else saved = (await db().patch("vega_sync", "id=eq." + id + "&rev=eq." + base, { blob, rev: base + 1, updated_at: now }))[0];
  if (saved) return json({ rev: +saved.rev }, 200, origin);
  const cur = (await db().get("vega_sync", "id=eq." + id + "&select=rev,blob"))[0];
  if (!cur) return fail("The sync record is missing. Turn sync off and on again.", 409, origin);
  return new Response(JSON.stringify({ conflict: true, rev: +cur.rev, blob: cur.blob }), { status: 409, headers: { "Content-Type": "application/json", ...cors(origin) } });
}

async function background(req, path, url, origin) {
  if (req.method === "GET" && path.endsWith("/push/key")) return json({ key: (await vapid()).pub }, 200, origin);
  if (req.method === "GET" && path.endsWith("/inbox")) {
    const device = url.searchParams.get("device") || ""; if (!DEVICE.test(device)) return fail("Unknown device.", 400, origin);
    const items = await db().get("vega_inbox", "device=eq." + q(device) + "&order=id.asc&limit=20&select=id,title,body,tag,data");
    if (items.length) await db().del("vega_inbox", "device=eq." + q(device) + "&id=lte." + items[items.length - 1].id);
    return json({ items }, 200, origin);
  }
  if (req.method !== "POST") return null;
  let body; try { body = await req.json(); } catch { return fail("Invalid JSON body.", 400, origin); }
  const device = String((body && body.device) || ""); if (!DEVICE.test(device)) return fail("Unknown device.", 400, origin);
  if (path.endsWith("/push/register")) {
    const ep = body.subscription && body.subscription.endpoint; if (!validEndpoint(ep)) return fail("That push address is not from a known browser push service.", 400, origin);
    await db().upsert("vega_devices", [{ id: device, endpoint: ep, last_seen: new Date().toISOString() }], "id");
    return json({ ok: true }, 200, origin);
  }
  if (path.endsWith("/push/unregister")) { await db().del("vega_devices", "id=eq." + q(device)); return json({ ok: true }, 200, origin); }
  if (path.endsWith("/jobs/sync")) {
    if (!(await db().get("vega_devices", "id=eq." + q(device) + "&select=id")).length) return fail("This device is not registered for background alerts.", 404, origin);
    try {
      const n = await syncJobs(device, body.jobs);
      if (body.context) await db().update("vega_devices", "id=eq." + q(device), { context: cleanContext(body.context) });
      return json({ ok: true, jobs: n }, 200, origin);
    } catch (e) { return fail(e.message || "The jobs could not be saved.", 400, origin); }
  }
  return null;
}

// ---- request handler ----
export async function handler(req) {
  const origin = (req.headers.get("origin") || "").replace(/\/+$/, "");
  if (req.method === "POST" && new URL(req.url).pathname.replace(/\/+$/, "").endsWith("/cron")) {
    // called by the database scheduler, not by a browser
    try {
      if (!cronKey) cronKey = ((await db().get("vega_config", "key=eq.cron&select=value"))[0] || {}).value?.key || null;
      if (!cronKey || req.headers.get("x-cron-key") !== cronKey) return fail("Not allowed.", 403);
      return json(await runCron(), 200);
    } catch (e) { return fail("cron failed: " + (e.message || e), 500); }
  }
  const ok = origins().includes(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: ok ? 204 : 403, headers: ok ? cors(origin) : {} });
  if (!ok) return fail("This relay only answers the VEGA deck.", 403);
  if (limited(req)) return fail("Too many requests. Wait a minute and try again.", 429, origin);
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, "");
  try {
    if (req.method === "GET" && path.endsWith("/health")) return json({ ok: true, tools: ["search", "read"], search: env("BRAVE_API_KEY") ? "brave" : env("TAVILY_API_KEY") ? "tavily" : "built-in" }, 200, origin);
    if (req.method === "GET" && path.endsWith("/models")) return json({ data: (await freeModels()).data }, 200, origin);
    if (req.method === "GET" && path.endsWith("/search")) {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 300);
      if (!q) return fail("Missing search text.", 400, origin);
      return json({ query: q, ...(await search(q)) }, 200, origin);
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
      // reasoning models: only the effort level passes through, nothing else from the client
      const eff = body.reasoning && body.reasoning.effort;
      if (["minimal", "low", "medium", "high"].includes(eff)) send.reasoning = { effort: eff };
      const up = await fetch(OR + "/chat/completions", {
        method: "POST", signal: req.signal,
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json", "X-Title": "VEGA" },
        body: JSON.stringify(send),
      });
      return new Response(up.body, { status: up.status, headers: { "Content-Type": up.headers.get("content-type") || "application/json", "Cache-Control": "no-store", ...cors(origin) } });
    }
    if (path.endsWith("/state") && (req.method === "GET" || req.method === "POST")) return await state(req, url, origin);
    if (/\/(push\/(key|register|unregister)|jobs\/sync|inbox)$/.test(path)) {
      const r = await background(req, path, url, origin);
      if (r) return r;
    }
    return fail("Not found.", 404, origin);
  } catch (e) {
    console.error("relay error", path, e && e.message);
    return fail("The relay could not complete that request.", 502, origin);
  }
}

if (g.Deno) g.Deno.serve(handler);
