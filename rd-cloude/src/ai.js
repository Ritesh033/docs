// AI assistant: projects, conversations, messages, artifacts. Uses the Anthropic API when
// ANTHROPIC_API_KEY is set, otherwise a local stub so the platform works offline.
import { HttpError, required } from './http.js'
import { record } from './billing.js'

const MODEL = process.env.RD_MODEL || 'claude-sonnet-5-5'

async function callModel(system, history) {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return localModel(history)
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, messages: history.map(({ role, content }) => ({ role, content })) }),
  })
  if (!res.ok) throw new HttpError(502, `Model provider error (${res.status})`)
  const j = await res.json()
  return { text: j.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 }
}

function localModel(history) {
  const last = history.at(-1).content
  const text = `RD Cloude (offline mode) received: "${last.slice(0, 200)}"\n\nSet ANTHROPIC_API_KEY to connect a real model.`
  return { text, inputTokens: Math.ceil(history.reduce((s, m) => s + m.content.length, 0) / 4), outputTokens: Math.ceil(text.length / 4) }
}

const FENCE = /```(\w*)\n([\s\S]*?)```/g
export function extractArtifacts(text) {
  return [...text.matchAll(FENCE)].filter((m) => m[2].trim().split('\n').length >= 3).map((m) => ({ language: m[1] || 'text', content: m[2] }))
}

export function aiRoutes(r, db) {
  const own = (col, id, user) => {
    const row = db.get(col, id)
    if (!row || row.userId !== user.id) throw new HttpError(404, 'Not found')
    return row
  }

  // Projects: group conversations and share custom instructions + knowledge
  r.get('/api/projects', ({ user }) => ({ projects: db.find('projects', (p) => p.userId === user.id) }))
  r.post('/api/projects', ({ user, body }) => {
    required(body, 'name')
    return [201, db.insert('projects', { userId: user.id, name: body.name, instructions: body.instructions ?? '', knowledge: body.knowledge ?? '' })]
  })
  r.patch('/api/projects/:id', ({ user, params, body }) => {
    own('projects', params.id, user)
    const { name, instructions, knowledge } = body
    return db.update('projects', params.id, Object.fromEntries(Object.entries({ name, instructions, knowledge }).filter(([, v]) => v !== undefined)))
  })
  r.delete('/api/projects/:id', ({ user, params }) => {
    own('projects', params.id, user)
    for (const c of db.find('conversations', (c) => c.projectId === params.id)) db.update('conversations', c.id, { projectId: null })
    db.remove('projects', params.id)
    return { ok: true }
  })

  // Conversations
  r.get('/api/conversations', ({ user, query }) => ({
    conversations: db.find('conversations', (c) => c.userId === user.id && (!query.get('projectId') || c.projectId === query.get('projectId'))),
  }))
  r.post('/api/conversations', ({ user, body }) => {
    if (body.projectId) own('projects', body.projectId, user)
    return [201, db.insert('conversations', { userId: user.id, title: body.title || 'New chat', projectId: body.projectId ?? null })]
  })
  r.get('/api/conversations/:id', ({ user, params }) => ({
    conversation: own('conversations', params.id, user),
    messages: db.find('messages', (m) => m.conversationId === params.id),
  }))
  r.delete('/api/conversations/:id', ({ user, params }) => {
    own('conversations', params.id, user)
    db.removeWhere('messages', (m) => m.conversationId === params.id)
    db.removeWhere('artifacts', (a) => a.conversationId === params.id)
    db.remove('conversations', params.id)
    return { ok: true }
  })

  r.post('/api/conversations/:id/messages', async ({ user, params, body }) => {
    required(body, 'content')
    const convo = own('conversations', params.id, user)
    const userMsg = db.insert('messages', { conversationId: convo.id, role: 'user', content: String(body.content) })
    if (convo.title === 'New chat') db.update('conversations', convo.id, { title: String(body.content).slice(0, 50) })
    const project = convo.projectId ? db.get('projects', convo.projectId) : null
    const system = ['You are RD Cloude, a helpful assistant.', project?.instructions, project?.knowledge && `Project knowledge:\n${project.knowledge}`].filter(Boolean).join('\n\n')
    const history = db.find('messages', (m) => m.conversationId === convo.id)
    const out = await callModel(system, history)
    const reply = db.insert('messages', { conversationId: convo.id, role: 'assistant', content: out.text })
    record(db, user.id, 'ai.input_tokens', out.inputTokens)
    record(db, user.id, 'ai.output_tokens', out.outputTokens)
    const artifacts = extractArtifacts(out.text).map((a, i) =>
      db.insert('artifacts', { userId: user.id, conversationId: convo.id, messageId: reply.id, title: `Artifact ${i + 1}`, ...a, versions: [] }),
    )
    return [201, { userMessage: userMsg, assistantMessage: reply, artifacts, usage: { inputTokens: out.inputTokens, outputTokens: out.outputTokens } }]
  })

  // Artifacts (editable, versioned)
  r.get('/api/artifacts', ({ user }) => ({ artifacts: db.find('artifacts', (a) => a.userId === user.id) }))
  r.post('/api/artifacts', ({ user, body }) => {
    required(body, 'title', 'content')
    return [201, db.insert('artifacts', { userId: user.id, conversationId: null, title: body.title, language: body.language || 'text', content: body.content, versions: [] })]
  })
  r.get('/api/artifacts/:id', ({ user, params }) => own('artifacts', params.id, user))
  r.put('/api/artifacts/:id', ({ user, params, body }) => {
    const a = own('artifacts', params.id, user)
    required(body, 'content')
    return db.update('artifacts', a.id, { content: body.content, title: body.title ?? a.title, versions: [...a.versions, { content: a.content, at: new Date().toISOString() }] })
  })
  r.delete('/api/artifacts/:id', ({ user, params }) => (own('artifacts', params.id, user), db.remove('artifacts', params.id), { ok: true }))
}
