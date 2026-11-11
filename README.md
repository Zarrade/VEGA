# VEGA

A single-file AI command deck: a living holographic core, one adaptive assistant, voice in and out, autonomous missions, timers, tasks, notes and long-term memory. No build step, no dependencies, no backend.

## Run it

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`, press the settings button, and paste your API key. The deck is preset to OpenRouter with **free models only**; a paid model is refused before any request is sent.

It also works with any OpenAI-style endpoint. For a fully private setup point it at a local server such as Ollama (`http://localhost:11434/v1`), LM Studio or llama.cpp.

## What it does

- **Core**: a particle sphere that reacts to listening, thinking and speaking.
- **One adaptive assistant**: VEGA reads each request and picks its own approach (conversation, operations, visual analysis, hands-on steps, deep reasoning or a full mission). The deck's accent colour follows.
- **Real tools, used on its own judgement**:
  - **Web search and page reading** through the relay, with source links on the reply.
  - **Encyclopedia and weather** lookups.
  - **Exact calculation** and **sandboxed code** for analysis and simulations (no network or page access inside the sandbox).
  - **Library**: drop in text files and VEGA can read and search them; long work it writes is saved there to copy or download.
  - **Timers, clock-time reminders, tasks, notes and long-term memory.**
- **Presence**: VEGA speaks as it thinks (sentence by sentence), answers simple commands instantly without a model call, and speaks up on its own: a daily arrival briefing, low power, a lost connection.
- **Conversation mode**: hands-free back and forth. Say "conversation mode" to start and "that will be all" to end.
- **Protocols**: named routines ("run the morning protocol"), which you can define in plain words and schedule daily.
- **Displays**: charts, tables and weather panels put on screen alongside the answer, plus one-tap follow-up suggestions.
- **Sentries**: ask it to keep an eye on a web page and it reports when the page changes (needs the relay, and the deck open).
- **Screen awareness**: say "look at my screen" to share a capture with a vision-capable model.
- **Resilience**: if a free model is busy, VEGA reroutes to another one on its own.
- **Desktop app**: install it from the browser (Chrome or Edge: the install icon in the address bar, or Settings → Desktop app) and it opens in its own window and still starts offline.
- **Background alerts**: turn them on in Settings and the relay keeps your timers, sentries and protocol schedules, notifying the device through web push even when VEGA is closed.
- **Wake word**: say the assistant's name to wake it. It tolerates common mishearings and pauses while VEGA itself is speaking.
- **Missions**: for a big objective VEGA plans it, works each step with its tools, delivers the result and files it in the Library. It starts one on its own, or use `/mission`.
- **Voice**: hold Space to talk; replies can be read aloud. Optional wake word.
- **Vision**: attach, paste or capture an image for a vision-capable model.
- **Command palette**: Ctrl+K. Slash commands: `/timer 5m tea`, `/task`, `/note`, `/remember`, `/mission`, `/clear`, `/export`.

## Privacy and keys

- Your key, conversation, tasks, notes and memory are stored only in your browser (localStorage). Nothing is written to this repository.
- **Never commit an API key.** The page runs entirely in the browser, so any key placed in the file is readable by anyone who can open it.
- With a hosted gateway such as OpenRouter, your messages go to that service and the model's provider. Free models may log prompts.
- The browser's built-in speech recognition (Chrome, Edge) sends audio to the browser vendor. Use a local Whisper endpoint for offline voice.

## Files

- `index.html` — the standalone deck. Open this.
- `src/vega.src.html` — the source. It is also what gets published as a hosted page, where it uses the host's built-in model and voice instead of an endpoint.
- `build.py` — regenerates `index.html` from the source.
- `sw.js`, `manifest.webmanifest`, `icon-*.png` — the installable app shell.
- `relay/` — optional server-side relay: keeps the API key off the page, enforces free models, and adds web search and page reading. See `relay/README.md`.

## Limits

Web search and page reading need the relay. Wikipedia and weather lookups go straight from your browser to those services, only when VEGA uses them; turn off "Allow web tools" in Settings to stop all of it. The Library reads text files only (no PDF or Office files). VEGA cannot control other apps or devices.
