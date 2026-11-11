# VEGA relay

A small server-side proxy so the public VEGA page never contains an API key.

- `GET  /models` — OpenRouter's free models only.
- `POST /chat/completions` — forwards to OpenRouter with the server-side key. A model that is not free is refused before any upstream call. `max_tokens` is capped at 4096.
- `GET  /search?q=` — web search results (title, address, snippet).
- `GET  /read?url=` — the readable text of a public web page. Private and local addresses are refused, including through redirects.
- `GET  /health`
- `GET  /push/key`, `POST /push/register`, `POST /push/unregister`, `POST /jobs/sync`, `GET /inbox` — the background service: a device registers a browser push subscription and syncs its timers, sentries and protocol schedules.
- `POST /cron` — called every minute by the database scheduler with a secret header. Due jobs become inbox items and the device gets an empty push, on which its service worker fetches the inbox.

## Guard rails

- Only browsers on the origins in `ALLOWED_ORIGINS` are answered (default: `https://zarrade.github.io,http://localhost:8080`). This stops other websites from using your relay. It does not stop a determined person with a script, because an origin can be forged outside a browser.
- 40 requests per minute per address, best effort.
- Free models only, so abuse costs rate limit, not money.

## Background service setup

It needs four tables (`vega_config`, `vega_devices`, `vega_jobs`, `vega_inbox`, all with row level security on and no policies, so only the relay's service role can touch them), the `pg_cron` and `pg_net` extensions, and a `pg_cron` job that posts to `/cron` every minute with the `x-cron-key` stored in `vega_config`. The relay creates its own web push signing keys on first use and stores them in `vega_config`. Push notifications carry no content; the text is fetched from the inbox by the device.

## Deploy on Supabase

1. Deploy `index.ts` as an Edge Function named `vega-relay` with JWT verification **off** (the page is public and has no login).
2. Add the secret `OPENROUTER_API_KEY` in the Supabase dashboard under Edge Functions → Secrets.
3. Optional: add the secret `ALLOWED_ORIGINS` as a comma-separated list if your page lives elsewhere.
4. Build the deck against it:

```bash
VEGA_RELAY=https://YOUR-PROJECT.supabase.co/functions/v1/vega-relay python3 build.py
```

The file is plain JavaScript in a `.ts` file, so it also runs on any Deno host that supports `Deno.serve`.
