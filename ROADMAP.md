# Roadmap

Planned improvements, grouped into phases. Sizes are rough: **S** is a few hours, **M** a day or two, **L**
longer. Check an item off when it lands, and add new ideas under the section they belong to. Items marked
_server done_ have their API and tests in place and are waiting for their UI.

## Status

- **Phase A (agents and tools):** done
- **Phase B (chat features):** done
- **Phase C (memory):** done
- **Phase D (security):** done
- **Phase E (quality):** done
- **Phase F (workspaces):** done
- **Phase G (image generation):** done

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
- [x] **B2. Edit a message and branch** (M). Editing a message rewrites it in every pane that has the same message
      and answers again (the `edit` stream action takes a message id per pane). Any reply can branch into a new chat.
- [x] **B3. Comparison tools** (M). "Compare replies" in the chat's menu shows each pane's speed, tokens and cost
      for an exchange, with totals for the exchange and the whole chat, and a word diff of two panes. One reply per
      exchange can be marked as the best, and "Send only to this pane" continues with one model.
- [x] **B4. Search across chats** (S–M). The Ctrl+K palette lists matching saved messages under chats and actions,
      and opens the chat at that message. Matching uses repolayer's `ilike` on every word, since repolayer has no
      full-text search.
- [x] **B5. Titles written by a model** (S). Settings → General → Title model; without one, the first line is used.
- [x] **B6. Reasoning controls** (S–M). Reasoning effort and thinking budget in generation settings, profiles and
      pane settings, sent in each provider's format following each Claude model's rules.
- [x] **B7. Export a chat** as Markdown, or as a static HTML page with replies side by side (S).
- [x] **B8. Retry with another model** when a reply fails (S). The pane keeps the model it was switched to.
- [x] **B9. Send while a reply streams** (S). A message typed while a pane is still answering is queued instead
      of blocked: it shows in the transcript right away and is sent once that reply finishes, so later ones see
      the completed reply as context. Queued messages can be cancelled before they're sent.

## C. Memory

- [x] **C1. Relevant facts first**: keyword ranking over the user's message when there are more facts than the
      limit. Embeddings could come later where a provider has them.
- [x] **C2. Scopes**. Each memory is used in all chats or only with one profile, picked on the Memory page when
      adding a memory or from its row.
- [x] **C3. Duplicates, conflicts and history**. The Memory page lists near-duplicates and runs a conflict check
      with the suggestion model; keeping one memory forgets the other. Each memory's history shows changes word by
      word, deleting an active memory moves it to Forgotten, and exports include history.

## D. Security and robustness

- [x] **D1. Refuse requests from other sites** (S). `src/server/security.ts` checks Host and Origin, and request
      bodies must be `application/json`.
- [x] **D2. Ownership checks**. Streams check every pane belongs to the chat, edits check the message belongs to
      the pane, and the unscoped `DELETE /messages/:id` is gone.
- [x] **D3. Prompt injection**: web and MCP output is wrapped in `<tool_output>` tags, with guidance in the
      system prompt.
- [x] **D4. Show memory suggestion failures** on the Memory page, from `GET /api/memories/suggestion-status`,
      until the next run works or the notice is dismissed.
- [x] **D5. Versioned migrations** in `src/server/db/migrations.ts`.
- [x] **D6. Recover from dropped connections** (S). The server writes an SSE heartbeat comment every 15 seconds
      so a slow tool call or long thinking step never looks like a dead connection; the client gives up after 45
      seconds of total silence and reports it as a normal error instead of leaving the reply stuck on Stop. A
      message that ends up with no reply at all can be retried directly, without editing it.

## E. Code quality and tooling

- [x] **E1. Client tests** with Vitest and Testing Library: `stores/chat.ts` (streaming, failures, regenerate,
      edit, best reply) and `ModelPicker` (ordering, filtering, keyboard, ids, favorites) under jsdom.
- [x] **E2. Tool loop tests** with a fake provider: approvals, stopping mid-tool, round limit, parallel limit,
      rejected tools, history replay, regenerate and edit, profiles and attachments.
- [x] **E3. CI**: GitHub Actions running lint, typecheck, test and build on Node 22 and 24.
- [x] **E4. Split `ChatService.runPane`** into `prepareTurn`, `streamStep` and `executeTools`.
- [x] **E5. Split large client files**: `UsagePage` into stats, model table and helpers; `Sidebar` into the chat
      item and footer; `ChatPage` into the header and the pane chips under the composer.
- [x] **E6. Structured logging** with run and pane ids (`LOG_LEVEL`, `LOG_FORMAT`).
- [x] **E7. Keep dates on import**. repolayer stamps `createdAt` and `updatedAt` on create, so imports write
      through a second set of repos over the same tables with timestamps off (`repos.undated`).

## F. Workspaces

- [x] **F1. Chat workspaces** (L). A chat's Files toggle gives it a folder under `WORKSPACE_DIR`, made on the
      first write. `list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`, `move_file` and
      `find_in_files` run inside it. Every path goes through `WorkspaceService.resolve`, and there are limits
      per chat and per file. Branching copies the folder and deleting a chat removes it.
- [x] **F2. Run commands** (M). `run_command` runs in the workspace with the system shell, PowerShell or bash. It
      asks first by default, gets an environment without API keys and no stdin, and kills its process tree at the
      timeout or on stop. It reports output and changed files, and the tool description names the toolchains
      found on the PATH.
- [x] **F3. Files panel** (M). Browse, preview, upload, download (one file or a ZIP of all) and delete a chat's
      files. The list reloads as tools change them.
- [x] **F4. ZIP exports** (M). Exports are ZIP archives with the rows in `switchbox.json` and attachments and
      workspace files as raw entries. Imports check each entry path, cap the unpacked size and still accept version 1 JSON.
- [x] **F5. Isolated commands** (L). `run_command` can run inside a WSL2 + bubblewrap jail instead (Settings →
      Tools → Workspaces → Sandbox commands; Docker Desktop isn't required). The jail sees only the workspace
      folder and a minimal read-only system, with no network unless allowed by default or per call. Toolchain
      detection runs inside the WSL distro rather than the Windows PATH when sandboxing is on, so the tool's
      description reflects what's actually installed there.
- [x] **F6. Bindable workspace root** (M). A chat's workspace can point at a real folder on this computer
      (the link icon next to Files) instead of only its own hidden folder, through the same path checks. A
      bound folder is exempt from the total quota, is never deleted when the chat is (only the chat's own
      unused folder is), isn't inherited by branches, and is never trusted from an import.

## G. Image generation

- [x] **G1. Image models as a pane type** (L). A pane whose model is tagged `kind: 'image'` (marked "Image" in
      the model picker) answers with a generated image instead of streamed text; the tool loop, budget fitting
      and history replay are otherwise unchanged, since an image reply is just a step with no tool calls. The
      image is stored through `AttachmentService` and shown on the reply exactly like a user-uploaded file, with
      a download button.
- [x] **G2. Three routes to Nano Banana**: OpenRouter (`modalities: ['image', 'text']` on the existing chat
      completions call), a new direct Google provider (`GEMINI_API_KEY`, Gemini's `generateContent`), and
      OpenAI's own `gpt-image-1`/`dall-e` models through `/images/generations` instead of `/chat/completions`.
- [ ] **G3. Chain edits automatically** (S–M). Feed a pane's own previously generated image back in as context
      for a follow-up prompt in the same pane, instead of requiring the user to re-attach it.
- [ ] **G4. Cost for direct Google and OpenAI image replies** (S). Today only OpenRouter reports real cost for
      image generation; Google and OpenAI image replies show "no price" on the Usage page.
