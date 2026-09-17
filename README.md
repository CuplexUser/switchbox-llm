# Switchbox

A local web app for chatting with LLMs and comparing their answers side by side. Send one message to up to
four models at once, each in its own pane with its own system prompt and settings, and watch the replies stream
in parallel.

- **Providers:** OpenRouter, OpenAI, Anthropic, Ollama, LM Studio, and any OpenAI-compatible endpoint
- **Comparison:** up to 4 panes per chat, each with its own stop button and a regenerate action; a
  single composer can target all panes or only some
- **History:** messages are saved to SQLite through [repolayer](https://www.npmjs.com/package/repolayer). A
  chat can also be temporary, in which case nothing is written
- **System prompts:** a reusable library with a default, plus custom instructions for each pane. Two
  starter prompts ("General assistant" and "Research analyst") are added on first run
- **Web search:** models can search the web and read pages, with Tavily, Brave, or the provider's own search.
  Each reply shows what was searched and which sources were used
- **Memory:** facts about you that are added to the system prompt. Models can save and forget facts when you
  ask them to, and a model you choose can suggest new ones for you to keep or dismiss
- **Stats:** time to first token, tokens per second, token counts, and cost where the provider reports it
- **Usage:** a page with token usage, cost and speed per model over time, so you don't need each provider's
  dashboard

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
| `TAVILY_API_KEY` | Web search through Tavily |
| `BRAVE_API_KEY` | Web search through Brave Search |
| `PORT` | API port, default `8787` |
| `DATABASE_FILE` | SQLite file, default `./data/switchbox.db` |

Everything else is configured on the Settings page and stored in the database: enabled providers, base URLs
for local servers, generation defaults, prompts, memory options, theme, and so on. Restart the server
after changing `.env`.

For local models, start Ollama or LM Studio and turn the provider on under Settings → Providers. The model
picker also accepts any model id typed directly, which helps when a server doesn't list its models.

## Web search

Choose how search runs under Settings → Web search. Each chat has its own Web on/off toggle.

| Mode | How it works |
| --- | --- |
| `auto` (default) | Tavily if `TAVILY_API_KEY` is set, else Brave if `BRAVE_API_KEY` is set, else native |
| `tavily` | A local `web_search` tool. Results come back as summarized passages, so models can often answer without opening every link |
| `brave` | A local `web_search` tool with ordinary web results. Cheaper and more neutral, but models open more pages |
| `native` | No local search tool. The model's provider searches on its servers: OpenRouter's web plugin, Anthropic's `web_search` server tool, or OpenAI's `web_search_options` (search-enabled models only). No extra key, but quality varies by provider, and Ollama, LM Studio and custom endpoints have none |
| `none` | No web search |

Separately, a `web_fetch` tool lets models read a page by URL; you can turn it off in the same settings tab. It
refuses localhost and private-network addresses, including redirects and hostnames that resolve to them.

With Tavily or Brave, the server runs a tool loop: the model calls a tool, the server runs it and sends back the
result, and this repeats up to the "Tool rounds per reply" limit. After that, the model is asked to answer with
what it has. Models that reject tool definitions, which is common with local models, automatically get a retry
without tools.

## Memory

Memories are facts about you, listed on the Memory page. In chats with memory turned on, the active ones are
added to the system prompt, and models get two tools:

| Tool | What it does |
| --- | --- |
| `memory_save` | Saves a fact, e.g. when you say "remember that I use metric units". It is active right away and marked "Saved by a model" |
| `memory_forget` | Removes the memory that matches the text it's given. When several match, nothing is removed and the model gets the candidates back |

Saving a fact that already exists does nothing, or turns it back on if it was paused or dismissed. The system
prompt tells the model it has long-term memory, so it uses these tools instead of saying it can't remember.

Under Settings → Memory you can also have a model read each exchange and suggest facts. Those wait in
Suggestions until you keep or dismiss them.

## Usage

The Usage page totals tokens, cost, replies and median speed for the last 7, 30 or 90 days or all time. It can
be filtered by provider, and it shows a chart per day (per week for long histories) and a table per model.

- Every saved reply writes a row to `usage_records`. The rows stay when a chat is deleted, including through
  Settings → Data, so totals include deleted chats. Temporary chats aren't recorded
- **Reported** cost is what OpenRouter charged for the reply
- **Estimated** cost uses list prices from OpenRouter's public model catalog, which needs no key. Anthropic and
  OpenAI models are matched by name, e.g. `claude-sonnet-4-5-20250929` to `anthropic/claude-sonnet-4.5`.
  Prices are cached for six hours
- Ollama and LM Studio models count as free. Models with no price show "no price" and are left out of the cost
- Replies saved before usage tracking existed are added on the first start, and so are replies from an import
- Use of the same API keys outside Switchbox doesn't show up

## Production

```bash
npm run build
npm start               # serves the built app and API on http://localhost:8787
```

The server binds to `127.0.0.1` only. It also refuses API requests that aren't addressed to `localhost` or
`127.0.0.1` (this blocks DNS rebinding) and requests sent from other websites. Request bodies must be
`application/json`, so a web page can't submit a form to the API either.

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
    providers/  OpenAI-compatible and Anthropic streaming adapters (tool calls, native search)
    web/        Tavily and Brave search, safe page fetching, tool definitions
    services/   chat runs, prompt assembly, memory tools and suggestions, usage reports, settings
    routes/     REST endpoints and the /api/chat/stream SSE endpoint
  client/    React 19, MUI 9, TanStack Query, Zustand
    features/   chat, memory, settings, usage
    stores/     live streaming state per pane
```

A send is one `POST /api/chat/stream`. The server streams every target pane concurrently and tags each SSE
event with its pane id. Every pane has its own abort controller, so `POST /api/chat/stop` can stop one pane
and leave the others running. Stopped replies keep their partial text.

Tables are created on startup with repolayer's `ensureTable()`, and `verifyTable()` checks them against the
schemas. repolayer doesn't do migrations. Instead, `src/server/db/migrate.ts` adds any column a newer schema
declares to an existing database, using repolayer's own column DDL. Any other schema change needs a manual
migration.

Settings → Data exports and imports everything except API keys as JSON.

## Roadmap

Planned work is tracked in [ROADMAP.md](ROADMAP.md).
