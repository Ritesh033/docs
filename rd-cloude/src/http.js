// Minimal router + helpers on top of node:http.
export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export class Router {
  routes = []
  add(method, pattern, handler, opts = {}) {
    const keys = []
    const re = new RegExp(
      '^' + pattern.replace(/\/\*(\w+)|:(\w+)/g, (m, splat, name) => (keys.push(splat ?? name), splat ? '/(.+)' : '([^/]+)')) + '/?$',
    )
    this.routes.push({ method, re, keys, handler, public: !!opts.public })
  }
  get = (p, h, o) => this.add('GET', p, h, o)
  post = (p, h, o) => this.add('POST', p, h, o)
  put = (p, h, o) => this.add('PUT', p, h, o)
  patch = (p, h, o) => this.add('PATCH', p, h, o)
  delete = (p, h, o) => this.add('DELETE', p, h, o)
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue
      const m = r.re.exec(pathname)
      if (m) {
        const params = {}
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])))
        return { route: r, params }
      }
    }
    return null
  }
}

export const MAX_BODY = 25 * 1024 * 1024

export function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new HttpError(413, 'Payload too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function readJson(buf) {
  if (!buf.length) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new HttpError(400, 'Invalid JSON body')
  }
}

export function sendJson(res, status, body) {
  const out = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(out) })
  res.end(out)
}

export function sendBuffer(res, status, buf, type = 'application/octet-stream', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'content-length': buf.length, ...extra })
  res.end(buf)
}

export function required(body, ...fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') throw new HttpError(400, `Missing field: ${f}`)
  }
}
