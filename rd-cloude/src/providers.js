// Model providers for the AI assistant: a real Anthropic Messages API client (true SSE streaming, retry/backoff,
// timeouts, abort, usage accounting) and a deterministic offline stub that works without any network.
//
// Provider contract (both providers):
//   provider.name  'anthropic' | 'stub'          provider.live  true when a real model answers
//   provider.stream({ model, system, messages, tools?, toolChoice?, temperature?, maxTokens?, signal?, delayMs? })
//       -> async generator of normalized events:
//          { type: 'text', text }                      incremental assistant text
//          { type: 'tool_use', id, name, input }       one complete tool call (arguments fully parsed)
//          { type: 'usage', inputTokens, outputTokens } emitted once, at the end of the stream
//          { type: 'stop', reason }                    'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal'
//   Messages use Anthropic-style content: a string, or blocks
//          { type: 'text', text } | { type: 'image', source: { type: 'base64', media_type, data } }
//          { type: 'tool_use', id, name, input } | { type: 'tool_result', tool_use_id, content, is_error? }
//   Failures are thrown as ProviderError (code: rate_limited | timeout | upstream | auth | bad_request | network | aborted | protocol).
//
// Nothing here touches the database or the HTTP layer; src/ai.js owns routing, persistence and tenancy.

/* ------------------------------------------------------------------------------------------ catalogue */

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/

export const DEFAULT_MODELS = Object.freeze([
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', tier: 'opus', description: 'Most capable model, best for hard reasoning and long, careful work.', contextWindow: 200000, maxOutputTokens: 16384 },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', tier: 'sonnet', description: 'Balanced speed and intelligence for everyday work.', contextWindow: 200000, maxOutputTokens: 16384 },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', tier: 'haiku', description: 'Fastest and cheapest, good for quick answers and simple tasks.', contextWindow: 200000, maxOutputTokens: 8192 },
])
export const FALLBACK_DEFAULT_MODEL = 'claude-sonnet-5-5'
/** Model used for cheap side tasks such as auto-titles (first catalogue entry whose tier is "haiku", else the default). */
const TITLE_TIER = 'haiku'

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : dflt
}

function normalizeModel(m) {
  if (typeof m === 'string') m = { id: m.trim() }
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !MODEL_ID_RE.test(m.id)) return null
  const known = DEFAULT_MODELS.find((d) => d.id === m.id)
  return {
    id: m.id,
    name: String(m.name ?? known?.name ?? m.id).slice(0, 80),
    tier: String(m.tier ?? known?.tier ?? '').slice(0, 20),
    description: String(m.description ?? known?.description ?? '').slice(0, 300),
    contextWindow: clampInt(m.contextWindow ?? known?.contextWindow, 1000, 10_000_000, 200000),
    maxOutputTokens: clampInt(m.maxOutputTokens ?? known?.maxOutputTokens, 16, 1_000_000, 8192),
  }
}

const catalogueMemo = { key: null, value: null }
/**
 * Model catalogue from the environment (read on every call, memoised on the raw strings):
 *   RD_AI_MODELS         JSON array of {id,name?,description?,contextWindow?,maxOutputTokens?} or a comma list "id[:Label],id2"
 *   RD_AI_DEFAULT_MODEL  default model id (legacy alias: RD_MODEL); added to the catalogue when missing
 * Returns { models, defaultModel, warnings }. Invalid configuration never throws: it falls back to the built-in models and
 * reports a warning (surfaced by GET /api/models).
 */
export function loadModelCatalogue(env = process.env) {
  const raw = env.RD_AI_MODELS ?? ''
  const def = env.RD_AI_DEFAULT_MODEL || env.RD_MODEL || ''
  const key = `${raw}\u0000${def}`
  if (catalogueMemo.key === key) return catalogueMemo.value
  const warnings = []
  let models = []
  if (raw.trim()) {
    try {
      const parsed = raw.trim().startsWith('[')
        ? JSON.parse(raw)
        : raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const i = s.indexOf(':'); return i > 0 ? { id: s.slice(0, i), name: s.slice(i + 1) } : { id: s } })
      if (!Array.isArray(parsed)) throw new Error('not an array')
      for (const p of parsed.slice(0, 50)) {
        const m = normalizeModel(p)
        if (m && !models.some((x) => x.id === m.id)) models.push(m)
        else if (!m) warnings.push(`ignored invalid model entry in RD_AI_MODELS: ${JSON.stringify(p).slice(0, 60)}`)
      }
    } catch (e) {
      warnings.push(`RD_AI_MODELS is invalid (${e.message}); using the built-in catalogue`)
    }
  }
  if (!models.length) models = DEFAULT_MODELS.map((m) => ({ ...m }))
  let defaultModel = FALLBACK_DEFAULT_MODEL
  if (def) {
    if (MODEL_ID_RE.test(def)) {
      defaultModel = def
      if (!models.some((m) => m.id === def)) models.push(normalizeModel(def))
    } else warnings.push('RD_AI_DEFAULT_MODEL is not a valid model id; ignored')
  } else if (!models.some((m) => m.id === defaultModel)) defaultModel = models[0].id
  const value = Object.freeze({ models: Object.freeze(models), defaultModel, warnings: Object.freeze(warnings) })
  catalogueMemo.key = key
  catalogueMemo.value = value
  return value
}

export const findModel = (cat, id) => cat.models.find((m) => m.id === id) ?? null
export function titleModel(cat) {
  return (cat.models.find((m) => m.tier === TITLE_TIER) ?? findModel(cat, cat.defaultModel) ?? cat.models[0]).id
}

/* ------------------------------------------------------------------------------------------ tokens */

/** Cheap, deterministic token estimate: ~4 chars per token for Latin text, 1 token per CJK/wide character. */
export function estimateTokens(text) {
  if (!text) return 0
  const s = String(text)
  let wide = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 0x2e80) wide++
  return Math.ceil((s.length - wide) / 4 + wide)
}
const IMAGE_TOKENS = 1600
export function estimateContentTokens(content) {
  if (typeof content === 'string') return estimateTokens(content)
  let n = 0
  for (const b of content ?? []) {
    if (b.type === 'text') n += estimateTokens(b.text)
    else if (b.type === 'image') n += IMAGE_TOKENS
    else if (b.type === 'tool_use') n += estimateTokens(b.name) + estimateTokens(JSON.stringify(b.input ?? {})) + 8
    else if (b.type === 'tool_result') n += estimateTokens(typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')) + 8
  }
  return n
}
export const estimateMessagesTokens = (messages) => messages.reduce((s, m) => s + estimateContentTokens(m.content) + 4, 0)

/* ------------------------------------------------------------------------------------------ errors */

export class ProviderError extends Error {
  constructor(message, { code = 'upstream', status = 502, retryable = false, retryAfterMs = null, cause } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.status = status // upstream status when known, else a sensible HTTP status for our API
    this.retryable = retryable
    this.retryAfterMs = retryAfterMs
    if (cause) this.cause = cause
  }
}
const abortError = () => new ProviderError('Generation was cancelled', { code: 'aborted', status: 499 })

/** Resolves after ms or rejects with an aborted ProviderError as soon as the signal fires. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(abortError()) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/* ------------------------------------------------------------------------------------------ SSE */

/**
 * Parses a Server-Sent-Events byte stream (async iterable of Buffer/Uint8Array/string) into { event, data, id } objects.
 * Handles CRLF/LF/CR line endings, multi-line data, comments, UTF-8 sequences split across chunks, and bounds the size of one event.
 */
export async function* parseSse(source, { maxEventChars = 8 * 1024 * 1024 } = {}) {
  const dec = new TextDecoder('utf-8')
  let buf = ''
  const dispatch = (block) => {
    let event = 'message'
    let id
    const data = []
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue
      const i = line.indexOf(':')
      const field = i === -1 ? line : line.slice(0, i)
      let value = i === -1 ? '' : line.slice(i + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
      else if (field === 'id') id = value
    }
    return data.length ? { event, data: data.join('\n'), id } : null
  }
  for await (const chunk of source) {
    buf += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true })
    // A trailing CR may be the first half of CRLF: hold it back until the next chunk decides.
    const hold = buf.endsWith('\r') ? '\r' : ''
    if (hold) buf = buf.slice(0, -1)
    buf = buf.replace(/\r\n?/g, '\n')
    let i
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const ev = dispatch(buf.slice(0, i))
      buf = buf.slice(i + 2)
      if (ev) yield ev
    }
    if (buf.length > maxEventChars) throw new ProviderError('Upstream sent an oversized event', { code: 'protocol' })
    buf += hold
  }
  buf += dec.decode()
  buf = buf.replace(/\r\n?/g, '\n')
  if (buf.trim()) {
    const ev = dispatch(buf)
    if (ev) yield ev
  }
}

/** Drain a provider stream into { text, toolUses, usage, stopReason }. */
export async function collect(stream) {
  const out = { text: '', toolUses: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: null }
  for await (const ev of stream) {
    if (ev.type === 'text') out.text += ev.text
    else if (ev.type === 'tool_use') out.toolUses.push(ev)
    else if (ev.type === 'usage') out.usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens }
    else if (ev.type === 'stop') out.stopReason = ev.reason
  }
  return out
}

/* ------------------------------------------------------------------------------------------ Anthropic */

const ANTHROPIC_VERSION = '2023-06-01'
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529])
const intEnv = (v, d, lo, hi) => (v === undefined || v === '' ? d : clampInt(v, lo, hi, d))

function parseRetryAfter(h) {
  if (!h) return null
  const secs = Number(h)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const t = Date.parse(h)
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null
}

function statusToError(status, bodyText, headers) {
  let type = ''
  try { type = JSON.parse(bodyText)?.error?.type ?? '' } catch { /* not JSON */ }
  const retryAfterMs = parseRetryAfter(headers?.get?.('retry-after'))
  if (status === 401 || status === 403) return new ProviderError(`Model provider rejected the API credentials (${status})`, { code: 'auth', status, retryAfterMs })
  if (status === 429) return new ProviderError('Model provider is rate limiting requests (429)', { code: 'rate_limited', status, retryable: true, retryAfterMs })
  if (status === 400 || status === 413 || status === 422) return new ProviderError(`Model provider rejected the request (${status}${type ? `: ${type}` : ''})`, { code: 'bad_request', status })
  if (status === 404) return new ProviderError(`Model provider does not know this model or endpoint (404${type ? `: ${type}` : ''})`, { code: 'bad_request', status })
  return new ProviderError(`Model provider error (${status})`, { code: 'upstream', status, retryable: RETRYABLE_STATUS.has(status), retryAfterMs })
}

function toApiMessages(messages) {
  return messages.map((m) => ({ role: m.role, content: m.content }))
}

/**
 * Real Anthropic Messages API provider.
 * options: { apiKey, baseUrl, fetch, timeoutMs (until response headers, 30s), idleTimeoutMs (between stream chunks, 60s),
 *            totalTimeoutMs (5min), maxRetries (3), retryBaseMs (500), retryMaxMs (8000), version }
 */
export function createAnthropicProvider(options = {}) {
  const env = options.env ?? process.env
  const apiKey = options.apiKey ?? env.ANTHROPIC_API_KEY
  const baseUrl = String(options.baseUrl ?? env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, '')
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? intEnv(env.RD_AI_TIMEOUT_MS, 30_000, 100, 600_000)
  const idleTimeoutMs = options.idleTimeoutMs ?? intEnv(env.RD_AI_IDLE_TIMEOUT_MS, 60_000, 100, 600_000)
  const totalTimeoutMs = options.totalTimeoutMs ?? intEnv(env.RD_AI_TOTAL_TIMEOUT_MS, 300_000, 100, 3_600_000)
  const maxRetries = options.maxRetries ?? intEnv(env.RD_AI_MAX_RETRIES, 3, 0, 10)
  const retryBaseMs = options.retryBaseMs ?? 500
  const retryMaxMs = options.retryMaxMs ?? 8000
  const version = options.version ?? ANTHROPIC_VERSION

  async function* attempt(req, outerSignal, state) {
    if (!apiKey) throw new ProviderError('ANTHROPIC_API_KEY is not configured', { code: 'auth', status: 401 })
    const ac = new AbortController()
    let timedOutAs = null
    const killer = (why) => { timedOutAs = why; ac.abort() }
    const onOuter = () => ac.abort()
    outerSignal?.addEventListener('abort', onOuter, { once: true })
    if (outerSignal?.aborted) ac.abort()
    const total = setTimeout(() => killer('total'), totalTimeoutMs)
    let timer = setTimeout(() => killer('headers'), timeoutMs)
    const arm = (ms, why) => { clearTimeout(timer); timer = setTimeout(() => killer(why), ms) }
    const fail = (e) => {
      if (outerSignal?.aborted) return abortError()
      if (timedOutAs) return new ProviderError(`Model provider timed out (${timedOutAs === 'headers' ? 'no response' : timedOutAs === 'idle' ? 'stream stalled' : 'time limit'})`, { code: 'timeout', status: 504, retryable: timedOutAs === 'headers' && !state.yielded })
      if (e instanceof ProviderError) return e
      return new ProviderError('Could not reach the model provider', { code: 'network', status: 502, retryable: !state.yielded, cause: e })
    }
    try {
      const body = {
        model: req.model,
        max_tokens: req.maxTokens ?? 4096,
        messages: toApiMessages(req.messages),
        stream: true,
      }
      if (req.system) body.system = req.system
      if (req.temperature !== undefined && req.temperature !== null) body.temperature = req.temperature
      if (req.tools?.length) {
        body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
        if (req.toolChoice) body.tool_choice = typeof req.toolChoice === 'string' ? { type: req.toolChoice } : req.toolChoice
      }
      let res
      try {
        res = await doFetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': version, 'content-type': 'application/json', accept: 'text/event-stream', 'user-agent': 'rd-cloude/1' },
          body: JSON.stringify(body),
          signal: ac.signal,
        })
      } catch (e) { throw fail(e) }
      if (!res.ok) {
        let text = ''
        try { text = (await res.text()).slice(0, 8192) } catch { /* ignore */ }
        throw statusToError(res.status, text, res.headers)
      }
      if (!res.body) throw new ProviderError('Model provider returned no body', { code: 'protocol', retryable: true })
      arm(idleTimeoutMs, 'idle')

      let inputTokens = 0
      let outputTokens = 0
      let stopReason = null
      let ended = false
      const blocks = new Map() // index -> { type, id, name, json }
      try {
        for await (const sse of parseSse(res.body)) {
          arm(idleTimeoutMs, 'idle')
          if (sse.event === 'ping') continue
          let d
          try { d = JSON.parse(sse.data) } catch { throw new ProviderError('Model provider sent malformed stream data', { code: 'protocol' }) }
          switch (d.type) {
            case 'message_start': {
              const u = d.message?.usage ?? {}
              inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
              outputTokens = u.output_tokens ?? 0
              break
            }
            case 'content_block_start': {
              const cb = d.content_block ?? {}
              blocks.set(d.index, { type: cb.type, id: cb.id, name: cb.name, json: '' })
              if (cb.type === 'text' && cb.text) { state.yielded = true; yield { type: 'text', text: cb.text } }
              break
            }
            case 'content_block_delta': {
              const dl = d.delta ?? {}
              if (dl.type === 'text_delta' && dl.text) { state.yielded = true; yield { type: 'text', text: dl.text } }
              else if (dl.type === 'input_json_delta') {
                const b = blocks.get(d.index)
                if (b) {
                  b.json += dl.partial_json ?? ''
                  if (b.json.length > 1_000_000) throw new ProviderError('Tool input too large', { code: 'protocol' })
                }
              }
              break
            }
            case 'content_block_stop': {
              const b = blocks.get(d.index)
              if (b?.type === 'tool_use') {
                let input = {}
                if (b.json.trim()) {
                  try { input = JSON.parse(b.json) } catch { throw new ProviderError('Model produced invalid tool arguments', { code: 'protocol' }) }
                }
                state.yielded = true
                yield { type: 'tool_use', id: b.id, name: b.name, input }
              }
              blocks.delete(d.index)
              break
            }
            case 'message_delta': {
              if (d.delta?.stop_reason) stopReason = d.delta.stop_reason
              if (d.usage?.output_tokens !== undefined) outputTokens = d.usage.output_tokens
              if (d.usage?.input_tokens !== undefined && d.usage.input_tokens > 0) inputTokens = d.usage.input_tokens
              break
            }
            case 'message_stop':
              ended = true
              break
            case 'error': {
              const t = d.error?.type ?? ''
              const overloaded = t === 'overloaded_error' || t === 'api_error' || t === 'rate_limit_error'
              throw new ProviderError(`Model provider error${t ? ` (${t})` : ''}`, { code: t === 'rate_limit_error' ? 'rate_limited' : 'upstream', status: overloaded ? 529 : 502, retryable: overloaded && !state.yielded })
            }
            default:
              break
          }
          if (ended) break
        }
      } catch (e) { throw fail(e) }
      if (!ended) throw new ProviderError('Model provider closed the stream early', { code: 'protocol', retryable: !state.yielded })
      state.yielded = true
      yield { type: 'usage', inputTokens, outputTokens }
      yield { type: 'stop', reason: stopReason ?? 'end_turn' }
    } finally {
      clearTimeout(timer)
      clearTimeout(total)
      outerSignal?.removeEventListener('abort', onOuter)
      ac.abort() // cancels the HTTP body if the consumer stopped early
    }
  }

  return {
    name: 'anthropic',
    live: true,
    async *stream(req) {
      const state = { yielded: false }
      for (let n = 0; ; n++) {
        try {
          yield* attempt(req, req.signal, state)
          return
        } catch (e) {
          if (!(e instanceof ProviderError) || !e.retryable || state.yielded || n >= maxRetries || req.signal?.aborted) throw e
          const backoff = Math.min(retryMaxMs, retryBaseMs * 2 ** n)
          const wait = Math.min(30_000, Math.max(e.retryAfterMs ?? 0, backoff * (0.75 + Math.random() * 0.5)))
          req.onRetry?.({ attempt: n + 1, waitMs: wait, error: e })
          await sleep(wait, req.signal)
        }
      }
    },
  }
}

/* ------------------------------------------------------------------------------------------ offline stub */

const WORD_CHUNK = /\s*\S+\s*|\s+/g

const lastUserText = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    // the typed text is the last text block; earlier ones are attachment wrappers
    const texts = m.content.filter((b) => b.type === 'text')
    if (texts.length) return texts.at(-1).text
  }
  return ''
}
const hasToolResults = (m) => m?.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')

const DEMOS = {
  html: (v) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>RD Cloude demo</title>
  <style>body{font-family:system-ui,sans-serif;margin:2rem}button{padding:.5rem 1rem}</style>
</head>
<body>
  <h1>Hello from RD Cloude${v ? ' (v2)' : ''}</h1>
  <button id="b">Click me</button>
  <p id="out"></p>
  <script>document.getElementById('b').onclick = () => { document.getElementById('out').textContent = 'Clicked!' }</script>
</body>
</html>`,
  svg: (v) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">
  <rect width="120" height="120" rx="16" fill="${v ? '#2b6dd9' : '#d9622b'}"/>
  <circle cx="60" cy="60" r="34" fill="none" stroke="#fff" stroke-width="8"/>
  <path d="M42 62l14 14 24-30" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round"/>
</svg>`,
  markdown: (v) => `# Meeting notes${v ? ' (revised)' : ''}

## Agenda

- Review the roadmap
- Decide on the launch date
- Assign owners

| Owner | Task | Due |
| ----- | ---- | --- |
| Sam | Draft spec | Friday |
| Alex | Review | Monday |`,
  python: (v) => `def fib(n: int) -> int:
    """Return the n-th Fibonacci number."""
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a

if __name__ == "__main__":
    print([fib(i) for i in range(${v ? 20 : 10})])`,
  javascript: (v) => `export function debounce(fn, ms = 200) {
  let t
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms${v ? ' * 2' : ''})
  }
}

console.log(typeof debounce)`,
  json: () => `{
  "name": "demo",
  "version": "1.0.0",
  "private": true,
  "tags": ["example", "offline"]
}`,
  css: () => `:root {
  --accent: #d9622b;
}
.card {
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 1rem;
}`,
  sql: () => `SELECT u.id, u.email, COUNT(o.id) AS orders
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
GROUP BY u.id, u.email
ORDER BY orders DESC
LIMIT 10;`,
}
const DEMO_ALIASES = { js: 'javascript', md: 'markdown', py: 'python' }

/**
 * Deterministic offline "model". It never talks to the network: it echoes, calls tools on simple trigger phrases and emits
 * canned fenced code for "<language> demo" requests, so every feature can be exercised without an API key.
 * Triggers (case-insensitive):  "calculate 2+2" -> calculator tool;  "what time is it [in Europe/Paris]" -> datetime tool;
 * "search my drive for foo" -> drive_search;  "read file <id>" -> drive_read;  "html demo" / "svg example" / ... -> artifact block
 * (add "update" for a second version);  __stub_error__ / __stub_midstream_error__ / __stub_long__ / __stub_loop__ for failure tests.
 */
export function createStubProvider(options = {}) {
  const defaultDelay = options.delayMs ?? 0
  return {
    name: 'stub',
    live: false,
    async *stream(req) {
      const delayMs = req.delayMs ?? defaultDelay
      const signal = req.signal
      const tools = new Set((req.tools ?? []).map((t) => t.name))
      const messages = req.messages
      const last = messages.at(-1)
      const userText = lastUserText(messages)
      const inputTokens = estimateTokens(req.system) + estimateMessagesTokens(messages)
      const maxOut = req.maxTokens ?? 4096
      let outTokens = 0
      let reason = 'end_turn'
      let toolCall = null
      let text

      if (/__stub_error__/.test(userText) && !hasToolResults(last)) throw new ProviderError('Stub provider failure (requested by __stub_error__)', { code: 'upstream', status: 502 })

      if (hasToolResults(last)) {
        // Second leg of a tool loop: summarise what the tools returned.
        const names = new Map()
        for (const m of messages) if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_use') names.set(b.id, b.name)
        const parts = last.content.filter((b) => b.type === 'tool_result').map((b) => {
          const out = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
          return `${names.get(b.tool_use_id) ?? 'tool'} ${b.is_error ? 'failed' : 'returned'}: ${out.slice(0, 600)}`
        })
        text = `RD Cloude (offline mode) used tools. ${parts.join(' | ')}`
        if (/__stub_loop__/.test(userText) && req.toolChoice !== 'none' && tools.has('calculator')) {
          text = 'Looping again.'
          toolCall = { name: 'calculator', input: { expression: '1+1' } }
        }
      } else if (/__stub_long__/.test(userText)) {
        text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ')
      } else {
        let m
        if (tools.has('calculator') && (m = /^\s*(?:calc(?:ulate)?|compute|evaluate)\s*[:-]?\s+([^\n]+)$/i.exec(userText))) {
          text = 'Let me use the calculator.'
          toolCall = { name: 'calculator', input: { expression: m[1].trim() } }
        } else if (tools.has('datetime') && /\b(?:what(?:'s| is) the (?:current )?(?:time|date)|what time is it|current (?:time|date)|today'?s date)\b/i.test(userText)) {
          const tz = /\bin ([A-Za-z_]+\/[A-Za-z_]+)/.exec(userText)?.[1]
          text = 'Let me check the clock.'
          toolCall = { name: 'datetime', input: tz ? { timezone: tz } : {} }
        } else if (tools.has('drive_search') && (m = /\b(?:search|find|look(?:\s+up)?)\b.*\b(?:drive|files?)\b.*?\b(?:for|about|named)\s+([^\n]+)$/i.exec(userText))) {
          text = 'Searching your Drive.'
          toolCall = { name: 'drive_search', input: { query: m[1].trim().replace(/[?.!]+$/, '') } }
        } else if (tools.has('drive_read') && (m = /\bread (?:drive )?file\s+([A-Za-z0-9_.-]+)/i.exec(userText))) {
          text = 'Reading that file.'
          toolCall = { name: 'drive_read', input: { id: m[1] } }
        } else if (/__stub_loop__/.test(userText) && tools.has('calculator')) {
          text = 'Starting a loop.'
          toolCall = { name: 'calculator', input: { expression: '1+1' } }
        } else if ((m = /\b(html|svg|markdown|md|python|py|javascript|js|json|css|sql)\b/i.exec(userText)) && /\b(demo|example|sample|artifact|snippet)\b/i.test(userText)) {
          const key = DEMO_ALIASES[m[1].toLowerCase()] ?? m[1].toLowerCase()
          const v2 = /\b(update|revise|v2|again|change)\b/i.test(userText)
          const title = `${key} demo`
          text = `Here is a ${key} example.\n\n\`\`\`${key} title="${title}"\n${DEMOS[key](v2)}\n\`\`\`\n\nLet me know what to change.`
        } else {
          text = `RD Cloude (offline mode) received: "${userText.slice(0, 200)}"\n\nSet ANTHROPIC_API_KEY to connect a real model.`
          if (/__stub_midstream_error__/.test(userText)) text += '\n\n(interrupted)'
        }
      }

      const chunks = text.match(WORD_CHUNK) ?? []
      for (const chunk of chunks) {
        if (signal?.aborted) throw abortError()
        if (outTokens >= maxOut) { reason = 'max_tokens'; toolCall = null; break }
        if (delayMs) await sleep(delayMs, signal)
        outTokens += Math.max(1, estimateTokens(chunk))
        yield { type: 'text', text: chunk }
        if (/__stub_midstream_error__/.test(userText) && !hasToolResults(last) && outTokens >= 8) throw new ProviderError('Stub provider failure mid-stream', { code: 'upstream', status: 502 })
      }
      if (toolCall) {
        reason = 'tool_use'
        outTokens += estimateTokens(JSON.stringify(toolCall.input)) + 6
        yield { type: 'tool_use', id: `toolu_stub_${Math.random().toString(36).slice(2, 12)}`, name: toolCall.name, input: toolCall.input }
      }
      yield { type: 'usage', inputTokens, outputTokens: outTokens }
      yield { type: 'stop', reason }
    },
  }
}

/* ------------------------------------------------------------------------------------------ selection */

const stubSingleton = createStubProvider()
const anthropicCache = new Map()

/**
 * Pick the provider for this environment: the Anthropic provider when ANTHROPIC_API_KEY is set (or RD_AI_PROVIDER=anthropic),
 * otherwise the offline stub. RD_AI_PROVIDER=stub forces the stub even when a key is present.
 */
export function selectProvider(env = process.env) {
  const forced = String(env.RD_AI_PROVIDER ?? '').toLowerCase()
  if (forced === 'stub' || (forced !== 'anthropic' && !env.ANTHROPIC_API_KEY)) return stubSingleton
  const key = `${env.ANTHROPIC_API_KEY}|${env.ANTHROPIC_BASE_URL ?? ''}`
  let p = anthropicCache.get(key)
  if (!p) {
    if (anthropicCache.size > 4) anthropicCache.clear()
    p = createAnthropicProvider({ env })
    anthropicCache.set(key, p)
  }
  return p
}
