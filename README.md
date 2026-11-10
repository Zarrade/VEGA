# VEGA

A single-file AI command deck: a living holographic core, six personas, voice in and out, autonomous missions, timers, tasks, notes and long-term memory. No build step, no dependencies, no backend.

## Run it

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`, press the settings button, and paste your API key. The deck is preset to OpenRouter with **free models only**; a paid model is refused before any request is sent.

It also works with any OpenAI-style endpoint. For a fully private setup point it at a local server such as Ollama (`http://localhost:11434/v1`), LM Studio or llama.cpp.

## What it does

- **Core**: a particle sphere that reacts to listening, thinking and speaking.
- **Modes**: Concierge, Ops, Lens, Autonomous, Workshop, Deep. Each has its own personality and accent colour.
- **Actions**: ask in plain words to set timers, add or complete tasks, take notes, remember facts about you, or switch mode. Slash commands do the same: `/timer 5m tea`, `/task`, `/note`, `/remember`, `/mission`, `/mode`, `/clear`, `/export`.
- **Missions**: Autonomous mode plans an objective, works each step, then delivers the result.
- **Voice**: hold Space to talk; replies can be read aloud. Optional wake word.
- **Vision**: attach, paste or capture an image for a vision-capable model.
- **Command palette**: Ctrl+K.

## Privacy and keys

- Your key, conversation, tasks, notes and memory are stored only in your browser (localStorage). Nothing is written to this repository.
- **Never commit an API key.** The page runs entirely in the browser, so any key placed in the file is readable by anyone who can open it.
- With a hosted gateway such as OpenRouter, your messages go to that service and the model's provider. Free models may log prompts.
- The browser's built-in speech recognition (Chrome, Edge) sends audio to the browser vendor. Use a local Whisper endpoint for offline voice.

## Files

- `index.html` — the standalone deck. Open this.
- `src/vega.src.html` — the source. It is also what gets published as a hosted page, where it uses the host's built-in model and voice instead of an endpoint.
- `build.py` — regenerates `index.html` from the source.

## Limits

The assistant can reason, write, look at images and use the deck's own actions. It cannot browse the web, read files or control devices.
