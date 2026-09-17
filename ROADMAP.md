# Roadmap

Planned improvements, grouped into phases. Sizes are rough: **S** is a few hours, **M** a day or two, **L**
longer. Check an item off when it lands, and add new ideas under the section they belong to. Items marked
_server done_ have their API and tests in place and are waiting for their UI.

## Status

- **Phase A (agents and tools):** done
- **Phase B (chat features):** attachments done; edit and branch, search, titles and reasoning settings have
  server support and need UI; comparison tools, export and retry are open
- **Phase C (memory):** relevance done; scopes, history, duplicates and conflicts have server support and need UI
- **Phase D (security):** done except the Memory page notice for suggestion failures
- **Phase E (quality):** CI, loop tests, the chat service split and structured logs done; client tests and
  splitting large client files are open

## A. Agents and tools

- [x] **A1. Tool registry** (M). `src/server/tools/registry.ts` offers tools by group, chat toggle, profile and
      policy, checks arguments against each tool's JSON schema, and reports activity. The round limit moved to
      Settings → Tools.
- [x] **A2. Keep tool results in history** (M). Replies store their tool loop in `messages.trace`, history is
      built on the server, and Settings → Tools keeps results shortened, in full, or not at all.
- [x] **A3. More built-in tools** (S–M each)
  - [x] `run_js` in a sandboxed worker
  - [x] `current_time`
  - [x] `conversation_search`
  - [x] `memory_update` and `memory_list`
  - [x] `read_attachment`
- [x] **A4. MCP client** (L). Stdio and Streamable HTTP servers under Settings → Tools, with a connection test,
      per-chat toggles in the Tools menu, and imported servers switched off.
- [x] **A5. Tool approval** (M). Auto, Ask or Off per tool; Ask pauses the reply with an approval card; a general
      `tool` activity item shows arguments and results.
- [x] **A6. Loop hardening** (S–M)
  - [x] Limit how many tool calls run at once
  - [x] Shorten tool results, then drop early exchanges, near the context window
  - [x] Anthropic prompt caching
  - [x] Retry with backoff on 408/429/5xx/529 before the first streamed byte
  - [x] Remember for an hour when a model rejects tools
- [x] **A7. Agent profiles** (M). System prompts gained tool groups, a round limit and generation settings, edited
      under Settings → Profiles.

## B. Chat features

- [x] **B1. Attachments and images** (L). Upload by button, drag and drop or paste; images, PDFs and text files
      are stored in the database and sent in each provider's format.
- [ ] **B2. Edit a message and branch** (M). _Server done:_ the `edit` stream action,
      `POST /api/conversations/:id/branch`, and `edit` in the chat store. Needs the edit and branch buttons.
- [ ] **B3. Comparison tools** (M). Diff two panes, mark the best reply (_server done:_ `messages.preferred`),
      continue with only that pane, and show totals per run across panes.
- [ ] **B4. Search across chats** (S–M). _Server done:_ `GET /api/search`, which matches every word with
      repolayer's `ilike` (repolayer has no full-text search). Needs results in the Ctrl+K palette.
- [ ] **B5. Titles written by a model** (S). _Server done:_ `settings.general.titleModel`. Needs the setting on
      the General tab.
- [ ] **B6. Reasoning controls** (S–M). _Server done:_ effort and thinking budget in both adapters, following each
      Claude model's rules. Needs the fields in generation settings.
- [ ] **B7. Export a chat** as Markdown, or a comparison as a static HTML file (S).
- [ ] **B8. Retry with another model** when a reply fails (S).

## C. Memory

- [x] **C1. Relevant facts first**: keyword ranking over the user's message when there are more facts than the
      limit. Embeddings could come later where a provider has them.
- [ ] **C2. Scopes** (_server done:_ `memories.scope` limits a fact to one profile). Needs a scope picker on the
      Memory page.
- [ ] **C3. Duplicates, conflicts and history**. Forgotten memories can be restored from the Memory page.
      _Server done:_ `GET /api/memories/duplicates`, `POST /api/memories/conflicts` and
      `GET /api/memories/:id/history`. Needs UI.

## D. Security and robustness

- [x] **D1. Refuse requests from other sites** (S). `src/server/security.ts` checks Host and Origin, and request
      bodies must be `application/json`.
- [x] **D2. Ownership checks**. Streams check every pane belongs to the chat, edits check the message belongs to
      the pane, and the unscoped `DELETE /messages/:id` is gone.
- [x] **D3. Prompt injection**: web and MCP output is wrapped in `<tool_output>` tags, with guidance in the
      system prompt.
- [ ] **D4. Show memory suggestion failures** on the Memory page. _Server done:_
      `GET /api/memories/suggestion-status`.
- [x] **D5. Versioned migrations** in `src/server/db/migrations.ts`.

## E. Code quality and tooling

- [ ] **E1. Client tests** with Vitest and Testing Library, starting with `stores/chat.ts` and `ModelPicker`.
- [x] **E2. Tool loop tests** with a fake provider: approvals, stopping mid-tool, round limit, parallel limit,
      rejected tools, history replay, regenerate and edit, profiles and attachments.
- [x] **E3. CI**: GitHub Actions running lint, typecheck, test and build on Node 22 and 24.
- [x] **E4. Split `ChatService.runPane`** into `prepareTurn`, `streamStep` and `executeTools`.
- [ ] **E5. Split large client files** (`UsagePage`, `Sidebar`, `ChatPage`) when they are next changed.
- [x] **E6. Structured logging** with run and pane ids (`LOG_LEVEL`, `LOG_FORMAT`).
