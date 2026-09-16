# Switchbox

A local web app for chatting with LLMs and comparing their answers side by side. Send one message to up to
four models at once, each in its own pane with its own system prompt and settings, and watch the replies stream
in parallel.

- **Providers:** OpenRouter, OpenAI, Anthropic, Ollama, LM Studio, and any OpenAI-compatible endpoint
- **Comparison:** up to 4 panes per chat, each with its own stop button and a regenerate action; a
  single composer can target all panes or only some
- **History:** messages are saved to SQLite through [repolayer](https://www.npmjs.com/package/repolayer). A
  chat can also be temporary, in which case nothing is written
- **System prompts:** a reusable library with a default, plus custom instructions for each pane
- **Memory:** facts about you that are added to the system prompt. A model you choose can suggest new ones
  for you to keep or dismiss
- **Stats:** time to first token, tokens per second, token counts, and cost where the provider reports it

## Requirements

Node 22.18 or newer. The server runs TypeScript directly through Node's type stripping, and repolayer needs
`node:sqlite`.

## Setup

```bash
npm install
cp .env.example .env    # then add the keys you have
npm run dev             # API on :8787, app on http://localhost:5173
```

API keys go in `.env` and stay on the local server:

| Variable | Used for |
| --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter |
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `CUSTOM_API_KEY` | Optional key for a custom OpenAI-compatible endpoint |
| `PORT` | API port, default `8787` |
| `DATABASE_FILE` | SQLite file, default `./data/switchbox.db` |

Everything else is configured on the Settings page and stored in the database: enabled providers, base URLs
for local servers, generation defaults, prompts, memory options, theme, and so on. Restart the server
after changing `.env`.

For local models, start Ollama or LM Studio and turn the provider on under Settings → Providers. The model
picker also accepts any model id typed directly, which helps when a server doesn't list its models.

## Production

```bash
npm run build
npm start               # serves the built app and API on http://localhost:8787
```

The server binds to `127.0.0.1` only.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | API server with watch mode, plus the Vite dev server |
| `npm run build` | Builds the client into `dist/` |
| `npm start` | Runs the API and serves `dist/` |
| `npm run lint` | Oxlint |
| `npm run typecheck` | TypeScript, no emit |
| `npm test` | Vitest |

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+K | Command palette: jump to a chat or page |
| Ctrl+Shift+O | New chat |
| Ctrl+\ | Show or hide the sidebar |
| Enter / Shift+Enter | Send / new line (switchable in Settings) |
| Esc | Stop all replies while streaming |

## How it fits together

```
src/
  shared/    Types, defaults and the SSE parser used by both sides
  server/    Hono API
    db/         repolayer schemas and repos (one table per repo)
    providers/  OpenAI-compatible and Anthropic streaming adapters
    services/   chat runs, prompt assembly, memory suggestions, settings
    routes/     REST endpoints and the /api/chat/stream SSE endpoint
  client/    React 19, MUI 9, TanStack Query, Zustand
    features/   chat, memory, settings
    stores/     live streaming state per pane
```

A send is one `POST /api/chat/stream`. The server streams every target pane concurrently and tags each SSE
event with its pane id. Every pane has its own abort controller, so `POST /api/chat/stop` can stop one pane
and leave the others running. Stopped replies keep their partial text.

Tables are created on startup with repolayer's `ensureTable()`, and `verifyTable()` checks them against the
schemas. Because repolayer is not a migration tool, changing a schema needs a manual migration or a fresh
database file.

Settings → Data exports and imports everything except API keys as JSON.
