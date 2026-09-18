# Switchbox

A local web app for chatting with LLMs and comparing their answers side by side. Send one message to up to
four models at once, each in its own pane with its own system prompt and settings, and watch the replies stream
in parallel.

- **Providers:** OpenRouter, OpenAI, Anthropic, Ollama, LM Studio, and any OpenAI-compatible endpoint
- **Comparison:** up to 4 panes per chat, each with its own stop button and a regenerate action; a
  single composer can target all panes or only some. "Compare replies" shows each exchange's speed, tokens and
  cost with totals, and a word-level diff of any two panes. One reply per exchange can be marked as the best
- **Editing:** edit a message you sent and every pane that has it answers again; branch any reply into a new
  chat; a failed reply can be retried or sent to another model
- **Export:** a chat as Markdown, or as a single HTML page with the replies side by side
- **History:** messages are saved to SQLite through [repolayer](https://www.npmjs.com/package/repolayer). A
  chat can also be temporary, in which case nothing is written. Ctrl+K searches saved messages, and a model you
  choose can write chat titles
- **Profiles:** reusable system prompts that can also limit tools and set their own tool round limit and
  generation settings, plus custom instructions for each pane. Starter profiles are added once: General
  assistant, Research analyst, Coding assistant, Data analyst, Writing editor and Tutor. Deleted ones don't come back
- **Web search:** models can search the web and read pages, with Tavily, Brave, or the provider's own search.
  Each reply shows what was searched and which sources were used
- **Tools:** besides the web, a JavaScript sandbox, the current time, search across earlier chats, memory, and
  any tools from MCP servers you add. Each tool can run automatically, ask you first, or be off
- **Workspaces:** a chat can have a folder of files that models create, read and edit, and, if you allow it, a
  model can compile and run code there. A Files panel in the chat shows, previews, uploads and downloads them
- **Attachments:** images, PDFs and text files can be attached to a message
- **Memory:** facts about you that are added to the system prompt. Models can save, update and forget facts
  when you ask them to, and a model you choose can suggest new ones for you to keep or dismiss
- **Generation settings:** temperature, top P, output limit, reasoning effort and thinking budget, as defaults,
  per profile or per pane. Each provider gets the nearest setting it supports
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
| `WORKSPACE_DIR` | Folder for chat workspaces, default `./data/workspaces` |
| `LOG_LEVEL` | `debug`, `info` (default), `warn` or `error` |
| `LOG_FORMAT` | `json` for one JSON object per line instead of text |

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

With Tavily or Brave, `web_search` is a tool like `web_fetch`, and both follow the tool loop described next.

## Tools

Models call tools, the server runs them and sends back the results, and this repeats up to the "Tool rounds per
reply" limit under Settings → Tools. After that, the model is asked to answer with what it has.

| Tool | Group | What it does |
| --- | --- | --- |
| `web_search`, `web_fetch` | Web | See [Web search](#web-search). Follows each chat's Web toggle |
| `memory_save`, `memory_update`, `memory_forget`, `memory_list` | Memory | See [Memory](#memory). Follows each chat's Memory toggle |
| `run_js` | Run JavaScript | Runs JavaScript for arithmetic, dates and data processing, and returns console output and the last value |
| `current_time` | Current time | The date and time in any time zone |
| `conversation_search` | Search earlier chats | Finds messages in other saved chats that contain all the given words |
| `read_attachment` | Read attached files | Reads the rest of a long text file attached to the chat |
| `list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`, `move_file`, `find_in_files` | Workspace files | See [Workspaces](#workspaces). Follows each chat's Files toggle |
| `run_command` | Run commands | Runs a command in the chat's workspace folder and returns its exit code, output and changed files. Asks first by default |
| `mcp_<server>_<tool>` | One per MCP server | Tools from the MCP servers you add |

- **Chat toggles:** the Tools menu in a chat's header turns optional groups on or off for that chat. Web and
  memory keep their own toggles
- **Policies:** each tool is **Auto** (runs without asking), **Ask** (the reply pauses and shows the call's
  arguments until you allow or decline it) or **Off** (not offered). MCP tools default to Ask, the others to
  Auto, except `run_command`, which asks. A declined call tells the model you declined, and stopping a reply declines anything still waiting
- **Profiles:** a profile can limit its panes to some tool groups and set its own round limit
- **Parallel calls:** calls from one round run a few at a time, set by "Tool calls at once"
- **Later messages:** follow-up questions see earlier tool calls and their results, shortened by default, so a
  model can refer to a page it read without fetching it again. Settings → Tools can keep them in full or leave
  them out. The history is built on the server from saved messages; temporary chats keep theirs in memory
- **Context window:** when a request gets close to the model's context window, long tool results are shortened
  first, then the earliest exchanges are left out, and the reply says so
- **Outside content:** results from web pages and MCP servers are wrapped in `<tool_output>` tags, and the
  system prompt tells the model to treat them as information, not instructions
- **Models without tools:** local models often reject tool definitions. They get a retry without tools, and for
  the next hour that model is sent requests without tools

The `run_js` sandbox runs in a worker thread with a memory cap and a 5 second limit, inside a V8 context with no
Node globals (no `require`, `process`, network or file access) where compiling code from strings is disabled.

### Workspaces

Turn on **Files** in a chat's header, or on the new chat page, to give the chat a workspace. It is a folder of
its own under `WORKSPACE_DIR`, made the first time a file is written, so chats that never use it leave nothing
on disk. Every pane in the chat shares it. The system prompt lists the files already there, and the folder
button next to the switch opens the Files panel. The panel previews text and images, and you can upload by
button or drag and drop, download one file or all of them as a ZIP archive, and delete files.

- **Paths:** every path is checked to stay inside the chat's folder. Absolute paths, `..`, Windows device names
  and alternate data streams are refused, and so are symbolic links or junctions that lead out of it
- **Limits:** 100 MB per chat and 20 MB per file by default, under Settings → Tools → Workspaces
- **Lifecycle:** turning Files off keeps the files. Branching a chat copies them, and deleting a chat deletes
  them. Temporary chats lose theirs on restart, like their messages
- **Serving:** the panel serves files as images or plain text, sandboxed and never sniffed, so an HTML or SVG
  file a model wrote can't run scripts in the app

**Run commands** is a separate tool group, off in new chats and turned on in a chat's Tools menu. It only works
while Files is on. `run_command` starts the system shell (cmd.exe on Windows, `/bin/sh` elsewhere; PowerShell
or bash can be chosen) in the workspace folder, so models can use whatever compilers and runtimes you have
installed. The tool's description tells the model which common ones are on the PATH.

Commands are **not sandboxed**. They run as ordinary programs with your user account, and an approved command
can read or change any file you can. What Switchbox does:

- `run_command` defaults to Ask, and the approval card shows the command line itself
- API keys and other variables from `.env` are left out of a command's environment. Only what shells and
  compilers need (such as `PATH`, `SYSTEMROOT` and `HOME`) is passed on, and `TEMP` points into the workspace
- stdin is closed, so a program waiting for input can't hang forever. It runs until the timeout (60 seconds by
  default), and then it and everything it started are killed. Stopping the reply kills it too
- output is capped at 20,000 characters per stream, keeping the start and the end
- an import never changes the Run commands policy

For real isolation, run Switchbox itself inside a container or VM.

### MCP servers

Add servers under Settings → Tools → MCP servers, either as a command Switchbox starts (stdio) or as a
Streamable HTTP URL with optional headers. "Test connection" lists a server's tools before you save it. Servers
connect the first time their tools are needed and stay connected. A server that fails to start is tried again
after a minute, and the error shows in Settings and in the chat's Tools menu.

Stdio servers run with your user account, so only add servers you trust. Servers in an imported export start
switched off.

## Memory

Memories are facts about you, listed on the Memory page. In chats with memory turned on, the active ones are
added to the system prompt, up to "Most memories per prompt". When there are more, the ones that share the most
words with your message are sent. Models get these tools:

| Tool | What it does |
| --- | --- |
| `memory_save` | Saves a fact, e.g. when you say "remember that I use metric units". It is active right away and marked "Saved by a model" |
| `memory_update` | Rewrites a fact that changed, e.g. after you move |
| `memory_forget` | Moves the matching memory to Forgotten on the Memory page, where you can restore it. When several match, nothing changes and the model gets the candidates back |
| `memory_list` | Lists everything in memory, including facts left out of the prompt |

Saving a fact that already exists does nothing, or turns it back on if it was paused, dismissed or forgotten.
The system prompt tells the model it has long-term memory, so it uses these tools instead of saying it can't
remember.

Under Settings → Memory you can also have a model read each exchange and suggest facts. Those wait in
Suggestions until you keep or dismiss them. If the suggestion model fails, the Memory page shows the error until
the next run works or you dismiss it.

On the Memory page:

- **Scope:** each memory is used in all chats, or only in panes that use one profile. Deleting a profile moves
  its memories back to all chats
- **Forgetting:** the delete button on a memory moves it to Forgotten, where it can be restored or deleted for good
- **History:** every memory keeps a record of when it was added, changed, forgotten or restored, and by whom,
  with changes shown word by word. History is included in Settings → Data exports
- **Duplicates:** memories that say nearly the same thing are listed for review; keep one and the other is
  forgotten, or keep both and the pair stops coming back in this browser
- **Conflicts:** "Check for conflicts" asks the suggestion model which memories contradict each other, such as
  two home cities

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
| `npm test` | Vitest: server tests, plus client tests for the chat store and components (jsdom and Testing Library) |

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+K | Command palette: jump to a chat or page, or search saved messages |
| Ctrl+Shift+O | New chat |
| Ctrl+\ | Show or hide the sidebar |
| Enter / Shift+Enter | Send / new line (switchable in Settings) |
| Esc | Stop all replies while streaming |

## How it fits together

```
src/
  shared/    Types, defaults and the SSE parser used by both sides
  server/    Hono API
    db/         repolayer schemas and repos (one table per repo), column additions, versioned migrations
    providers/  OpenAI-compatible and Anthropic streaming adapters (tool calls, native search, attachments,
                reasoning settings, prompt caching, retries)
    tools/      tool registry, argument checks, approval policies, built-in tools and MCP servers
    web/        Tavily and Brave search, safe page fetching
    services/   chat runs and the tool loop, message storage and history, attachments, workspaces and
                commands, ZIP archives, memory, search, usage reports, settings
    routes/     REST endpoints and the /api/chat/stream SSE endpoint
  client/    React 19, MUI 9, TanStack Query, Zustand
    features/   chat, memory, settings, usage
    stores/     live streaming state per pane
```

A send is one `POST /api/chat/stream` with the pane ids and the new message, and the server builds each pane's
history from its stored messages. It streams every target pane concurrently and tags each SSE event with its
pane id. Every pane has its own abort controller, so `POST /api/chat/stop` can stop one pane and leave the
others running. Stopped replies keep their partial text. A tool call waiting for approval is answered with
`POST /api/chat/approve`.

Each saved reply keeps its tool loop in the `messages.trace` column: the model's calls, provider blocks such as
thinking signatures, and tool results cut to 20,000 characters each. It is used to build later history and is
never sent to the browser.

Tables are created on startup with repolayer's `ensureTable()`, and `verifyTable()` checks them against the
schemas. repolayer doesn't do migrations, so there are two steps of our own. `src/server/db/migrate.ts` adds
any column a newer schema declares to an existing database, using repolayer's own column DDL. Changes to data
that already exists go in `src/server/db/migrations.ts` as numbered steps; each runs once, and the version
reached is stored in the settings table.

Server logs have one line per event, with fields such as the run and pane id, so a reply can be followed from
start to finish.

Settings → Data exports everything except API keys as a ZIP archive. The rows, tool traces included, are in
`switchbox.json`, each attachment's bytes are under `attachments/<id>`, and each saved chat's workspace is under
`workspaces/<chat id>/`. Files keep their raw bytes instead of becoming base64 text, and already-compressed
formats are stored as they are. Imports take these archives and the JSON files earlier versions exported.
Imported chats, profiles and memories keep their original dates, workspace files already present are left alone,
and archive entries go through the same path checks as the workspace tools.

## Roadmap

Planned work is tracked in [ROADMAP.md](ROADMAP.md).
