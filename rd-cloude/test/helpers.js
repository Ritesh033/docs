// Shared test helper: boots an in-memory app on an ephemeral port with strict module loading.
import { createApp } from '../src/app.js'

export async function startTestApp(opts = {}) {
  delete process.env.ANTHROPIC_API_KEY
  const { server, db, ctx } = await createApp({ strictModules: true, ...opts })
  await new Promise((r) => server.listen(0, r))
  const base = `http://localhost:${server.address().port}`

  /** call(method, path, {body, raw, headers, token}) -> {status, headers, data}; data is parsed JSON, text for text/*, else Buffer. */
  async function call(method, path, { body, raw, headers = {}, token } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    })
    const type = res.headers.get('content-type') || ''
    const data = type.includes('json') ? await res.json() : type.startsWith('text/') ? await res.text() : Buffer.from(await res.arrayBuffer())
    return { status: res.status, headers: res.headers, data }
  }
  /** Registers a user and returns { token, user, call: (method, path, opts) bound to this user }. */
  async function register(email = `u${Math.random().toString(36).slice(2, 8)}@rd.dev`, password = 'password123') {
    const r = await call('POST', '/api/auth/register', { body: { email, password } })
    if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.data)}`)
    const token = r.data.token
    return { token, user: r.data.user, call: (m, p, o = {}) => call(m, p, { token, ...o }) }
  }
  return { base, server, db, ctx, call, register, close: () => new Promise((r) => server.close(r)) }
}
