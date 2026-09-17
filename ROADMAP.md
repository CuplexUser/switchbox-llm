# Roadmap

Planned improvements, roughly in the order they should be built. Sizes are rough: **S** is a few hours,
**M** a day or two, **L** longer. Check an item off when it lands, and add new ideas under the section they
belong to.

## Next up

1. ~~Refuse requests from other sites~~ (D1) and CI (E3)
2. Tool registry (A1), then tool loop tests (E2)
3. Tool results kept in history, built on the server (A2), with migrations (D5) and ownership checks (D2)
4. Loop hardening (A6), then reasoning controls (B6)
5. New tools (A3), then tool approval (A5), then MCP (A4)
6. Attachments (B1), editing and branching (B2), full-text search (B4), agent profiles (A7), memory relevance (C1)

## A. Agents and tools

- [ ] **A1. Tool registry** (M). Web and memory tools are picked with an `if` in `ChatService.runPane`, and
      each has its own argument parsing. Add `src/server/tools/registry.ts` with a `ToolDefinition`
      (spec, when it's enabled, run) and argument checking against the JSON schema in one place. Move
      `maxToolRounds` from `settings.web` to a new `agent` section, since it limits every tool.
- [ ] **A2. Keep tool results in history** (M). `ChatTurn` is only role and text, so on the next turn the
      model has lost the pages it read and must search again. Save the reply's tool loop (capped in size) in
      a `messages.trace` column, keep Anthropic thinking blocks, and build history on the server from the
      database. Setting: keep tool results in full, as a summary, or not at all.
- [ ] **A3. More built-in tools** (S–M each)
  - [ ] `run_js` / calculator in a sandbox (`node:vm` or a worker with a timeout)
  - [ ] `current_time` with the user's time zone
  - [ ] `conversation_search` over earlier chats (needs B4)
  - [ ] `memory_update` and `memory_list`
  - [ ] `read_attachment` (needs B1)
- [ ] **A4. MCP client** (L). Add MCP servers (stdio or streamable HTTP) under Settings → Tools. Their tools
      join the registry with a name prefix and can be turned on or off per chat.
- [ ] **A5. Tool approval** (M). Each tool is set to auto, ask or off. "Ask" pauses the loop with an
      `approval` stream event and waits for `POST /api/chat/approve`. Add a general `tool` activity item
      that shows arguments and a preview of the result.
- [ ] **A6. Loop hardening** (S–M)
  - [ ] Limit how many tool calls run at once
  - [ ] Shorten older tool results when the loop nears the model's context length
  - [ ] Anthropic prompt caching (`cache_control` on the system prompt and the latest tool result)
  - [ ] Retry with backoff on 429/529 before the first streamed byte
  - [ ] Remember per model when a local model rejects tools, instead of failing on every reply
- [ ] **A7. Agent profiles** (M). A named bundle of system prompt, tools, round limit and params, chosen per
      pane, so the same model can be compared with different tool sets.

## B. Chat features

- [ ] **B1. Attachments and images** (L). Message content parts, changes in both provider adapters, drag and
      drop and paste in the composer, files stored under `data/attachments/`.
- [ ] **B2. Edit a message and branch** (M). Edit an earlier user message and send it again from there.
- [ ] **B3. Comparison tools** (M). Diff two panes, mark the best reply, continue with only that pane, and
      show totals per run across panes.
- [ ] **B4. Full-text search** (S–M). SQLite FTS5 over messages, shown in the Ctrl+K palette.
- [ ] **B5. Titles written by a model** (S), using a cheap model chosen in settings.
- [ ] **B6. Reasoning controls** (S–M). Reasoning effort and thinking budget for Anthropic, OpenAI and
      OpenRouter.
- [ ] **B7. Export a chat** as Markdown, or a comparison as a static HTML file (S).
- [ ] **B8. Retry with another model** when a reply fails (S).

## C. Memory

- [ ] **C1. Relevant facts first** instead of the most recently updated ones: keyword ranking over the user's
      message, and embeddings later where a provider has them.
- [ ] **C2. Scopes**: facts for all chats, one profile, or one project.
- [ ] **C3. Duplicates and conflicts** flagged on the Memory page, and a history of changes instead of
      permanent deletes.

## D. Security and robustness

- [x] **D1. Refuse requests from other sites** (S). The API checks the Host (against DNS rebinding) and the
      Origin, and request bodies must be `application/json`. See `src/server/security.ts`.
- [ ] **D2. Ownership checks**: `DELETE /messages/:id` and `/chat/stream` should confirm that panes and
      messages belong to the conversation in the request.
- [ ] **D3. Prompt injection**: mark tool output clearly in the prompt and tell the model it is data, not
      instructions. Matters more once A4 and A5 exist.
- [ ] **D4. Show memory suggestion failures** on the Memory page instead of only in the log.
- [ ] **D5. Versioned migrations** in `src/server/db/migrate.ts`, before A2 and B1 change the schema.

## E. Code quality and tooling

- [ ] **E1. Client tests** with Vitest and Testing Library, starting with `stores/chat.ts` and `ModelPicker`.
- [ ] **E2. Tool loop tests** with a fake provider sending scripted tool calls: round limit, fallback when
      tools aren't supported, stopping mid-tool.
- [ ] **E3. CI**: GitHub Actions running lint, typecheck, test and build on Node 22 and 24.
- [ ] **E4. Split `ChatService.runPane`** into a streaming step and a tool step (mostly done by A1).
- [ ] **E5. Split large client files** (`UsagePage`, `Sidebar`, `ChatPage`) when they are next changed.
- [ ] **E6. Structured logging** with a run id.
