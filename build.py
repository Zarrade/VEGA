#!/usr/bin/env python3
"""Build the standalone index.html from src/vega.src.html.

The source is the page as published to a hosted viewer (no document wrapper).
The standalone build wraps it in a full document, drops the web-font link so
the page makes no third-party requests, and presets the OpenRouter endpoint.
No API key is ever written by this script: enter yours in Settings.
"""
import pathlib, re

root = pathlib.Path(__file__).parent
src = (root / "src" / "vega.src.html").read_text(encoding="utf-8")
src = re.sub(r'<link rel="stylesheet" href="https://fonts\.googleapis\.com[^>]*>\n', "", src)
head = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        '<style>body{margin:0}</style></head><body>\n'
        '<script>window.VEGA_DEFAULTS={url:"https://openrouter.ai/api/v1",freeOnly:true}</script>\n')
(root / "index.html").write_text(head + src + "\n</body></html>\n", encoding="utf-8")
print("built index.html")
