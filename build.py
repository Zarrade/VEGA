#!/usr/bin/env python3
"""Build the standalone index.html from src/vega.src.html.

The source is the page as published to a hosted viewer (no document wrapper).
The standalone build wraps it in a full document and drops the web-font link
so the page itself makes no third-party requests.

RELAY is the address of a deployed VEGA relay (see relay/README.md). When set,
the deck talks to the relay: no API key in the browser, free models only, and
web search plus page reading. When empty, the deck talks to OpenRouter directly
and each person pastes their own key in Settings.

No API key is ever written by this script.
"""
import json, os, pathlib, re

RELAY = os.environ.get("VEGA_RELAY", "https://evtagqjuqgsbvitbvzin.supabase.co/functions/v1/vega-relay").rstrip("/")

root = pathlib.Path(__file__).parent
src = (root / "src" / "vega.src.html").read_text(encoding="utf-8")
src = re.sub(r'<link rel="stylesheet" href="https://fonts\.googleapis\.com[^>]*>\n', "", src)
defaults = {"url": RELAY or "https://openrouter.ai/api/v1", "freeOnly": True}
if RELAY:
    defaults["relay"] = RELAY
head = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        '<style>body{margin:0}</style></head><body>\n'
        '<script>window.VEGA_DEFAULTS=' + json.dumps(defaults, separators=(",", ":")) + '</script>\n')
(root / "index.html").write_text(head + src + "\n</body></html>\n", encoding="utf-8")
print("built index.html" + (" with relay " + RELAY if RELAY else " (direct, no relay)"))
