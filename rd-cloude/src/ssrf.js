// Shared SSRF protection for platform-initiated outbound requests (uptime checks, webhooks, function ctx.fetch).
// Rules: http/https only, no URL credentials, DNS resolved by us and EVERY address must be public, the connection is pinned to the vetted
// address (no DNS rebinding between check and connect), redirects are re-validated hop by hop, size/time capped.
import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

function v4Private(a, b) {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
}
/** True for loopback, RFC 1918, link-local/metadata, CGNAT, multicast, reserved, ULA and IPv4-mapped/NAT64 forms of those (and for anything that is not an IP). */
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) { const [a, b, c] = ip.split('.').map(Number); return v4Private(a, b) || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase()
    const mapped = /^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/.exec(l) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(l)
    if (mapped) return isPrivateIp(mapped[1])
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l)
    if (hex) { const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16); return isPrivateIp([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')) }
    return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff') || l.startsWith('2001:db8') || l.startsWith('100::')
  }
  return true
}

export class SsrfError extends Error {}

/**
 * GET/POST an external URL safely. opts: { method, headers, body, timeoutMs, maxBytes, maxRedirects, allowPrivate, ports }
 * Returns { status, headers, body(string, truncated to maxBytes), url, ms, redirects }.
 */
export async function safeRequest(rawUrl, opts = {}) {
  const { method = 'GET', headers = {}, timeoutMs = 10_000, maxBytes = 256 * 1024, maxRedirects = 3, allowPrivate = false, ports = [80, 443] } = opts
  let body = opts.body
  let current = rawUrl, m = method
  const started = Date.now()
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let url
    try { url = new URL(current) } catch { throw new SsrfError('Invalid URL') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new SsrfError('Only http and https URLs are allowed')
    if (url.username || url.password) throw new SsrfError('URLs with credentials are not allowed')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    if (!ports.includes(port) && !allowPrivate) throw new SsrfError(`Port ${port} is not allowed`)
    const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true, verbatim: true }).catch(() => { throw new SsrfError('Host did not resolve') })
    if (!addrs.length) throw new SsrfError('Host did not resolve')
    if (!allowPrivate && addrs.some((a) => isPrivateIp(a.address))) throw new SsrfError('Requests to private, loopback or link-local addresses are blocked')
    const pin = addrs[0]
    const res = await new Promise((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http
      const hdrs = { 'user-agent': 'RD-Cloude-Monitor/1', ...Object.fromEntries(Object.entries(headers).filter(([k, v]) => /^[a-z0-9-]{1,64}$/i.test(k) && !/^(host|connection|content-length|transfer-encoding|expect|upgrade|proxy-.*)$/i.test(k) && !/[\r\n]/.test(String(v)))) }
      if (body !== undefined && body !== null) hdrs['content-length'] = Buffer.byteLength(body)
      const req = mod.request({ protocol: url.protocol, hostname: host, port, path: url.pathname + url.search, method: m, headers: hdrs, timeout: timeoutMs, servername: net.isIP(host) ? undefined : host, lookup: (_h, _o, cb) => cb(null, pin.address, pin.family) }, (resp) => {
        const chunks = []; let size = 0
        resp.on('data', (c) => { size += c.length; if (size <= maxBytes) chunks.push(c); else resp.destroy() })
        resp.on('close', () => resolve({ status: resp.statusCode, headers: Object.fromEntries(Object.entries(resp.headers).filter(([k]) => k !== 'set-cookie').map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)])), body: Buffer.concat(chunks).toString('utf8') }))
        resp.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new SsrfError('Request timed out')))
      req.on('error', (e) => reject(e instanceof SsrfError ? e : new SsrfError(e.code ? `${e.code}: ${e.message}` : e.message)))
      if (body !== undefined && body !== null) req.write(body)
      req.end()
    })
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      current = new URL(res.headers.location, url).toString()
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && m === 'POST')) { m = 'GET'; body = undefined }
      continue
    }
    return { ...res, url: url.toString(), ms: Date.now() - started, redirects: hop }
  }
  throw new SsrfError('Too many redirects')
}
