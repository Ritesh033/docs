# AI assistant

Chat with Claude models (or an offline stub), with branching conversations, streaming, tools, attachments, projects, a prompt
library, artifacts (versioned deliverables with a sandboxed preview), full-text search and public share links.
Code: `src/ai.js` (routes, persistence, tenancy), `src/providers.js` (model providers), `public/markdown.js` (safe Markdown renderer),
`public/ui/{chat,projects,artifacts}.js` + `ai.css`/`chat.css` (views). Tests: `test/ai.test.js`.

## Providers

| Provider | When | What it is |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` is set (or `RD_AI_PROVIDER=anthropic`) | Real Anthropic Messages API over `fetch`: true SSE parsing, tool use, usage accounting. Retries `408/409/429/500/502/503/504/529` and network failures with exponential backoff + jitter, honours `retry-after`, never retries once output has started. Timeouts: first byte 30 s, stream stall 60 s, total 5 min. Aborts the HTTP request when the client disconnects or presses stop. |
| `stub` | no key (or `RD_AI_PROVIDER=stub`) | **Simulated.** Deterministic, offline, streams word by word. It does not understand anything: it echoes ("RD Cloude (offline mode) received: ..."), calls tools on trigger phrases (`calculate 2+2`, `what time is it in Europe/Paris`, `search my drive for X`), and emits sample artifacts for `html demo`, `svg example`, `markdown demo`, `python example`, `javascript`, `json`, `css`, `sql`. `__stub_error__`, `__stub_midstream_error__`, `__stub_long__`, `__stub_loop__` trigger failure/long/looping behaviour for tests. |

The UI states plainly when it is in offline mode (banner in the chat, `provider.live=false` in `GET /api/models`).

Both providers implement `provider.stream({model, system, messages, tools?, toolChoice?, temperature?, maxTokens?, signal?}) -> async iterator` of
`{type:'text'|'tool_use'|'usage'|'stop', ...}`. Errors are `ProviderError` with a `code` (`rate_limited|timeout|upstream|auth|bad_request|network|aborted|protocol`);
the API maps them to 429/504/502 and never forwards upstream bodies or keys.

### Configuration

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | unset, `https://api.anthropic.com` | live provider |
| `RD_AI_PROVIDER` | auto | `stub` forces the stub even with a key |
| `RD_AI_MODELS` | built-in three | JSON array `[{id,name?,description?,contextWindow?,maxOutputTokens?}]` or `id[:Label],id2` |
| `RD_AI_DEFAULT_MODEL` (alias `RD_MODEL`) | `claude-sonnet-5-5` | added to the catalogue if missing |
| `RD_AI_TIMEOUT_MS`, `RD_AI_IDLE_TIMEOUT_MS`, `RD_AI_TOTAL_TIMEOUT_MS`, `RD_AI_MAX_RETRIES` | 30000, 60000, 300000, 3 | provider resilience |
| `RD_AI_MAX_TOKENS` | 4096 | output tokens requested per reply (capped by the model) |
| `RD_AI_MAX_TOOL_ITERATIONS` | 5 | tool rounds per reply (0 disables the loop); the last round is forced to answer in text |
| `RD_AI_MAX_CONCURRENT` | 4 | simultaneous generations per user |
| `RD_AI_CONTEXT_TOKENS` | model window | lower the context window (testing / cost control) |
| `RD_AI_DAILY_OUTPUT_TOKENS` | 0 (off) | per-user daily output-token cap, resets 00:00 UTC (`429` + `Retry-After`) |
| `RD_AI_PREVIEW_ALLOW_HOSTS` | none | comma list of hosts HTML previews may load scripts/styles/images from (e.g. `cdnjs.cloudflare.com`) |
| `RD_AI_INDEX_USER_POSTINGS`, `RD_AI_INDEX_MAX_POSTINGS` | 2 000 000, 6 000 000 | search-index budget (term/message pairs, ~100-200 bytes each) per user and in total; least recently used indexes are dropped and rebuilt on demand |
| `RD_STUB_DELAY_MS` | 12 | per-word delay of the stub when streaming (0 in tests) |

If `ctx.quotas.check(userId, 'ai.output_tokens', 1)` exists (billing module) it is consulted before every generation; a falsy / `{allowed:false}` result or a thrown 4xx
becomes `429`. The assistant never requires `ctx.quotas`.

## API

All routes need auth unless marked public; everything is per user (other users' ids answer `404`). Lists take `?limit=&cursor=` and return `nextCursor`.
Bodies must be JSON objects. Aliases under `/api/ai/...` exist for `models`, `search`, `prompts`.

**Models** `GET /api/models` -> `{models:[{id,name,tier,description,contextWindow,maxOutputTokens,default}], default, provider:{name,live}, tools:[{name,description}], limits:{...}, warnings?}`

**Conversations**
`GET /api/conversations?projectId=&pinned=0|1&archived=0|1|all` · `POST /api/conversations {title?,projectId?,model?,system?,temperature?,tools?}` ·
`GET /api/conversations/:id[?all=1]` (active branch, or every message) -> `{conversation, messages, context:{estimatedTokens,contextWindow}, generating, project}` ·
`PATCH /api/conversations/:id {title?,pinned?,archived?,model?,system?,temperature?,tools?,projectId?}` · `DELETE /api/conversations/:id` (removes messages, blobs, artifacts, shares) ·
`POST .../stop` · `POST .../branch {messageId}` (switch to that message's branch) · `DELETE .../messages/:mid` (message and everything below it) ·
`POST .../messages/:mid/feedback {rating:'up'|'down'|null, comment?}` · `GET .../messages/:mid/attachments/:aid` ·
`GET .../export?format=markdown|json[&all=1]`.

**Generating** (all three stream when `?stream=1` or `Accept: text/event-stream`; otherwise JSON `201`):
`POST .../messages {content, attachments?, parentId?, model?, temperature?, tools?}` (also `POST .../stream`, always SSE) ·
`POST .../regenerate {messageId?}` (new sibling reply) · `POST .../messages/:mid/edit {content, attachments?}` (new sibling user message = branch).
Conversations are a tree (`parentId`); `activeLeafId` selects the visible path and `siblings:{index,count,ids}` on a message drives the branch switcher.
`attachments` is an array of `{type:'text',name,content}` · `{type:'image',name,data:<base64>}` · `{type:'drive',driveFileId}`.

**SSE events** (`event:` / JSON `data:`): `message_start` `{conversation,userMessage,assistantMessage,context}` · `delta` `{text}` · `tool_use` `{id,name,input}` ·
`tool_result` `{id,name,input,output,isError,ms}` · `retry` `{attempt,waitMs}` · `artifact` `{artifact,action:'created'|'updated'|'unchanged'}` · `usage` `{inputTokens,outputTokens}` ·
`error` `{message,code,retryable,...}` · `done` `{userMessage,assistantMessage,artifacts,usage,conversation,status,stopReason,context}` · `title` `{title}` (after `done`, live provider).
Problems found before streaming starts (bad body, 404, 409, 429...) are ordinary JSON errors, not a broken stream. A client disconnect aborts the model call and keeps the partial reply
(`status:'stopped'`); `POST .../stop` ends it with a normal `done`. One generation per conversation at a time (`409`).

**Search** `GET /api/search?q=&projectId=&archived=0&limit=` -> ranked chats with `snippet`, `highlights:[[start,end]]`, `matchedIn`. BM25 over a per-user in-memory inverted index (built lazily in event-loop-friendly slices, newest chats first, kept current on every
message change; bounded by a posting budget per user and across all users, `partial:true` when older messages did not fit; only the first 20 000 characters of a message are indexed), plus title matches. Supports `"phrases"`, `-exclude`, prefix on the last word, and falls back from AND to OR when nothing matches.

**Projects** `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id` (`name, description, instructions, knowledge`) · knowledge files `GET/POST /api/projects/:id/files` (`{name,content}` or `{driveFileId}`),
`GET/DELETE .../files/:fid`. Instructions and files are put in the system prompt (files as `<document>` reference data within 30 % of the context window).

**Prompt library** `GET/POST /api/prompts`, `GET/PUT/DELETE /api/prompts/:id`, `POST /api/prompts/:id/render {variables}` -> `{prompt}`. Variables are `{{name}}` or `{{name|default}}`; rendered values are never re-expanded.

**Artifacts** (`code|html|markdown|svg`) `GET/POST /api/artifacts`, `GET/PUT/PATCH/DELETE /api/artifacts/:id`, `GET .../versions[/:n]`, `POST .../restore {version}`, `GET .../diff?from=&to=`
(line diff: `hunks`, `stats`, unified text), `GET .../download[?version=]`, `POST .../preview` (HTML only), `POST .../share`.
A fenced block in a reply becomes an artifact when it has `title="..."`, is a 3+ line html/svg/markdown block, or has 8+ lines. A repeated *explicit* title revises that artifact (new version, 50 kept);
made-up titles (`Python snippet`) never merge, an identical block is not duplicated.

**Sharing** `POST /api/conversations/:id/share`, `POST /api/artifacts/:id/share {version?}` -> `{token,url:'/share/<token>'}` · `GET /api/ai/shares?kind=&targetId=` · `DELETE /api/ai/shares/:token` (revoke).
Public: `GET /share/:token` (page), `GET /api/shared/:token` (JSON: only the title, roles, timestamps, text, model and attachment *names* of the messages that existed on the shared branch at that moment; artifacts are a snapshot of the shared version),
`POST /api/shared/:token/preview`. Tokens are 192-bit random, revoked links are `404` at once, deleting a message, conversation or artifact removes its links, 200 links per user.

## Tools

`calculator` (a real recursive-descent parser: `+ - * / % ^ !`, constants, `sqrt sin log min max ...`; never `eval`), `datetime` (any IANA zone), `drive_search` and `drive_read` (the caller's own Drive files only;
text decoded with limits). Tool calls run with a 10 s timeout and a 20 000 character result cap; failures are reported to the model as errors. Other modules can add tools:
`ctx.ai.registerTool({name, description, input_schema, run(input, {userId, db, signal})})`. Tools can be switched off per request or per conversation.

## Context window

Each reply budgets `system + messages + output reserve` against the model window (token estimate: ~4 chars/token, 1 per CJK character, 1 600 per image). When the history does not fit, the oldest whole turns are dropped
and replaced by a short extractive outline prepended to the first kept user message; the UI meter shows the estimate. A single message that cannot fit is a `413`. There is no model-written summary.

## Web UI

`#chat` (streaming with a stop button, model picker, regenerate, edit-as-branch with a version switcher, per-message feedback/copy/delete, conversation sidebar grouped by date with pinned/archived and ranked search,
attachments from device / paste / drag-drop / Drive, prompt picker, per-chat instructions/temperature/tools, export, share, artifact side panel), `#projects` (+ `#projects/<id>`), `#prompts`, `#artifacts` (+ `#artifacts/<id>`),
and the public page `/share/<token>`.
Keys: `Enter` send · `Shift+Enter` newline · `Esc` stop / close panel · `Ctrl/Cmd+K` search · `Ctrl/Cmd+Shift+O` new chat. Layout adapts (drawer under 960 px, sheet under 1040 px); works at 360 px; light/dark via the
console's CSS variables. Leaving a chat while it streams does not cancel it: the server finishes and saves the reply.

## Security notes

* Markdown is rendered with DOM APIs only (`public/markdown.js`): raw HTML is never interpreted, links are limited to `http(s)`/`mailto` with `rel="noopener noreferrer nofollow"`, images are never fetched (shown as a link),
  recursion/size/look-ahead are bounded (pathological inputs parse in well under a second). `test/ai.test.js` asserts there are no HTML sinks (`innerHTML`, `eval`, inline handlers/styles) in the UI files and runs an adversarial corpus;
  the same corpus was exercised in headless Chromium against the real renderer.
* **HTML artifact previews** run in `<iframe sandbox="allow-scripts">` with **no** `allow-same-origin`: scripts run but the frame has an opaque origin (no cookies, storage or API access). The document is served from
  `/preview/<ticket>` (random 144-bit ticket, 5 min, 100 live tickets / 16 MB) with its own CSP (`sandbox allow-scripts; default-src 'none'; connect-src 'none'; form-action 'none'; frame-ancestors 'self'`, external hosts only via
  `RD_AI_PREVIEW_ALLOW_HOSTS`). The console's strict CSP blocks inline script/style in a `srcdoc` iframe (srcdoc inherits the parent CSP), so `srcdoc` is only the fallback when the ticket request fails. SVG artifacts are shown through `<img>`
  (scripts never run), Markdown through the renderer.
* Tenant isolation on every id (404, never 403); Drive attachments/knowledge/tools check `file.userId`; attachment text is wrapped as data (`<attachment>`/`<document>`), knowledge is labelled reference material.
* Bounded everything: body 16 MiB, 8 attachments, images sniffed by magic bytes (png/jpeg/gif/webp, 3.5 MB), text 200 kB and not binary, 4 concurrent generations/user, SSE backpressure cut-off, bounded search/diff/preview/tool work.
* Audit events: `ai.knowledge.add`, `ai.conversation.delete`, `ai.share.create`, `ai.share.revoke`. Event `ai.generation` `{userId,conversationId,messageId,model,provider,status,inputTokens,outputTokens,toolCalls,durationMs}` after each reply.
* Collections: `conversations`, `messages`, `artifacts`, `projects` (core) + `ai_knowledge`, `ai_prompts`, `ai_shares`; image attachments are blobs (`blobId` on the message). Metering: `ai.input_tokens`, `ai.output_tokens` (existing prices).

## Limits (defaults)

Message 100 000 chars · 2 000 messages and 10 000 conversations per user · title 200 · instructions/system prompt 20 000 · knowledge 50 files, 200 kB each, 1 MB total · 500 projects · 200 prompts ·
artifact 256 KiB, 50 versions, 5 000 per user, 10 per reply · shared conversation 2 MB · tool result 20 000 chars, 8 calls per round.

## Honest limitations

* The stub provider is a simulation, not a model. Everything involving real answer quality (and the auto-title written by the small model) needs `ANTHROPIC_API_KEY`; the live provider is tested against a mock server, not against api.anthropic.com.
* Token counts are estimates when the provider reports none; context trimming is extractive, not a model summary. Search is lexical (no embeddings, no stemming).
* State is in-process: generation locks, search indexes, preview tickets and the daily-token counter are per server process (single node); a restart marks in-flight replies `interrupted`.
* No audio/PDF/other binary attachments (text and common image types only), no web browsing or code-execution tools, no conversation import, no streaming of tool arguments, no collaborative (multi-user) chats.
* A shared conversation is a snapshot of one branch; new messages are not added to an existing link. Preview documents live 5 minutes (re-opened on demand).
