// Markdown -> DOM, safely. No innerHTML, no raw HTML (angle brackets are always literal text), links limited to
// http/https/mailto, images never fetched (shown as a link), bounded recursion and input size.
//
//   renderMarkdown(text, opts?) -> DocumentFragment      opts: { breaks = true, copy = true, highlight = true }
//   parseMarkdown(text)         -> block AST (pure; no DOM, so it can be unit tested in Node)
//   safeUrl(url)                -> normalised http(s)/mailto URL or null
//   tokenizeCode(code, lang)    -> [[className|null, text], ...]  (pure syntax highlighter)
//   renderCode(code, lang, opts) -> HTMLElement                  (code block with language label and copy button)
//
// Styling lives in public/ui/ai.css (classes are prefixed ai-md / ai-code / ai-tok).

const MAX_INPUT = 400_000
const MAX_DEPTH = 8 // nested quotes / lists
const MAX_INLINE_DEPTH = 8
const LOOKAHEAD = 4000 // how far an emphasis opener searches for its closer (keeps pathological input linear-ish)

/* ----------------------------------------------------------------------------------------- urls */

/** Only absolute http, https and mailto URLs survive. Whitespace/control characters (used to disguise schemes) are rejected. */
export function safeUrl(raw) {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || s.length > 2000) return null
  if (/[\u0000-\u0020\u007f-\u009f\u2028\u2029\\]/.test(s)) return null
  let u
  try { u = new URL(s) } catch { return null }
  if (u.protocol === 'http:' || u.protocol === 'https:') return u.host ? u.href : null
  if (u.protocol === 'mailto:') return /^mailto:[^\s<>]+$/i.test(s) ? u.href : null
  return null
}

/* ----------------------------------------------------------------------------------------- inline parser */

const PUNCT = /[!-/:-@[-`{-~]/
const isAlnum = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c)

function findClosingBracket(s, i) {
  // s[i] === '[': index of the matching ']' (balanced, skipping escapes and code spans) or -1
  let depth = 0
  for (let j = i; j < Math.min(s.length, i + 2000); j++) {
    const c = s[j]
    if (c === '\\') { j++; continue }
    if (c === '`') {
      let n = 1
      while (s[j + n] === '`') n++
      const close = s.indexOf('`'.repeat(n), j + n)
      if (close === -1) { j += n - 1; continue }
      j = close + n - 1
      continue
    }
    if (c === '[') depth++
    else if (c === ']' && --depth === 0) return j
  }
  return -1
}

function parseLinkTail(s, i) {
  // s[i] === '(' : returns { href, title, end } or null
  let j = i + 1
  while (s[j] === ' ' || s[j] === '\n') j++
  let href = ''
  if (s[j] === '<') {
    const e = s.indexOf('>', j)
    if (e === -1 || s.slice(j, e).includes('\n')) return null
    href = s.slice(j + 1, e)
    j = e + 1
  } else {
    let depth = 0
    const start = j
    for (; j < s.length; j++) {
      const c = s[j]
      if (c === '\\') { j++; continue }
      if (c === ' ' || c === '\n') break
      if (c === '(') depth++
      else if (c === ')') { if (depth === 0) break; depth-- }
    }
    href = s.slice(start, j)
  }
  while (s[j] === ' ' || s[j] === '\n') j++
  let title = ''
  if (s[j] === '"' || s[j] === "'" || s[j] === '(') {
    const q = s[j] === '(' ? ')' : s[j]
    const e = s.indexOf(q, j + 1)
    if (e === -1) return null
    title = s.slice(j + 1, e)
    j = e + 1
    while (s[j] === ' ' || s[j] === '\n') j++
  }
  if (s[j] !== ')') return null
  return { href: href.replace(/\\([!-/:-@[-`{-~])/g, '$1'), title: title.slice(0, 300), end: j + 1 }
}

const trailingPunct = /[.,;:!?'")\]}>]+$/

export function parseInline(s, depth = 0) {
  const out = []
  let buf = ''
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = '' } }
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) {
      if (s[i + 1] === '\n') { flush(); out.push({ t: 'br' }); i += 2; continue }
      if (PUNCT.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue }
      buf += c; i++; continue
    }
    if (c === '`') {
      let n = 1
      while (s[i + n] === '`') n++
      const close = s.indexOf('`'.repeat(n), i + n)
      let end = close
      // the closing run must be exactly n backticks
      while (end !== -1 && s[end + n] === '`') { let k = n; while (s[end + k] === '`') k++; end = s.indexOf('`'.repeat(n), end + k) }
      if (end === -1) { buf += '`'.repeat(n); i += n; continue }
      flush()
      let v = s.slice(i + n, end).replace(/\n/g, ' ')
      if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ') && v.trim()) v = v.slice(1, -1)
      out.push({ t: 'code', v })
      i = end + n
      continue
    }
    if ((c === '[' || (c === '!' && s[i + 1] === '[')) && depth < MAX_INLINE_DEPTH) {
      const image = c === '!'
      const open = image ? i + 1 : i
      const close = findClosingBracket(s, open)
      if (close !== -1 && s[close + 1] === '(') {
        const tail = parseLinkTail(s, close + 1)
        if (tail) {
          flush()
          const label = s.slice(open + 1, close)
          const href = safeUrl(tail.href)
          if (image) out.push({ t: 'link', href, title: tail.title, image: true, c: [{ t: 'text', v: `${label || 'image'} (image)` }] })
          else if (href) out.push({ t: 'link', href, title: tail.title, c: parseInline(label, depth + 1) })
          else out.push(...parseInline(label, depth + 1)) // unsafe target: keep the label, drop the link
          i = tail.end
          continue
        }
      }
      buf += c; i++; continue
    }
    if (c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i, i + 2100))
      if (m) {
        const href = safeUrl(m[1])
        flush()
        if (href) out.push({ t: 'link', href, title: '', c: [{ t: 'text', v: m[1] }] })
        else out.push({ t: 'text', v: m[0] })
        i += m[0].length
        continue
      }
      const em = /^<([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24})>/.exec(s.slice(i, i + 400))
      if (em) { flush(); out.push({ t: 'link', href: `mailto:${em[1]}`, title: '', c: [{ t: 'text', v: em[1] }] }); i += em[0].length; continue }
      buf += c; i++; continue // raw HTML is never interpreted: '<' stays literal text
    }
    if ((c === '*' || c === '_' || c === '~') && depth < MAX_INLINE_DEPTH) {
      let n = 1
      while (s[i + n] === c) n++
      const prev = s[i - 1]
      const marker = c === '~' ? (n >= 2 ? 2 : 0) : Math.min(n, 3)
      if (marker && s[i + n] !== undefined && !/\s/.test(s[i + n]) && !(c === '_' && isAlnum(prev))) {
        // find a closer of the same length that is not preceded by whitespace
        const closer = c.repeat(marker)
        const limit = Math.min(s.length, i + n + LOOKAHEAD)
        let j = i + marker
        let found = -1
        while (j < limit) {
          const k = s.indexOf(closer, j)
          if (k === -1 || k >= limit) break
          const before = s[k - 1]
          const after = s[k + marker]
          if (before !== undefined && !/\s/.test(before) && before !== '\\' && !(c === '_' && isAlnum(after)) && s[k + marker] !== c && k > i + marker - 1) { found = k; break }
          j = k + 1
        }
        if (found !== -1) {
          flush()
          const inner = parseInline(s.slice(i + marker, found), depth + 1)
          out.push(c === '~' ? { t: 'del', c: inner } : marker === 1 ? { t: 'em', c: inner } : marker === 2 ? { t: 'strong', c: inner } : { t: 'strong', c: [{ t: 'em', c: inner }] })
          i = found + marker
          continue
        }
      }
      buf += c.repeat(n); i += n; continue
    }
    if (c === ' ' && s[i + 1] === ' ' && /^ +\n/.test(s.slice(i, i + 40))) { flush(); out.push({ t: 'br' }); i += s.slice(i).search(/\n/) + 1; continue }
    if ((c === 'h' || c === 'H') && !isAlnum(s[i - 1]) && depth < MAX_INLINE_DEPTH) {
      const m = /^https?:\/\/[^\s<]{1,2000}/i.exec(s.slice(i, i + 2100))
      if (m) {
        let url = m[0]
        let tail = ''
        const t = trailingPunct.exec(url)
        if (t) { tail = t[0]; url = url.slice(0, -tail.length) }
        // keep a closing paren that balances an opening one inside the URL
        while (tail.startsWith(')') && (url.match(/\(/g) || []).length > (url.match(/\)/g) || []).length) { url += ')'; tail = tail.slice(1) }
        const href = safeUrl(url)
        if (href) { flush(); out.push({ t: 'link', href, title: '', c: [{ t: 'text', v: url }] }); i += url.length; continue }
      }
    }
    if (c === '\n') { buf += '\n'; i++; continue }
    buf += c; i++
  }
  flush()
  return out
}

/* ----------------------------------------------------------------------------------------- block parser */

const RE = {
  fence: /^( {0,3})(`{3,}|~{3,})\s*(.*)$/,
  atx: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  quote: /^ {0,3}>/,
  list: /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*)$/,
  setext: /^ {0,3}(=+|-+)[ \t]*$/,
  tableDelim: /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/,
}
const blank = (l) => !/\S/.test(l)
const indentOf = (l) => { let n = 0; for (const ch of l) { if (ch === ' ') n++; else if (ch === '\t') n += 4; else break } return n }

function splitRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells = []
  let cur = ''
  let inCode = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue }
    if (c === '`') inCode = !inCode
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  cells.push(cur.trim())
  return cells
}

function startsBlock(line, nextLine) {
  if (RE.fence.test(line) && !/`/.test(RE.fence.exec(line)[3] || '') ) return true
  if (RE.atx.test(line) || RE.hr.test(line) || RE.quote.test(line)) return true
  const l = RE.list.exec(line)
  if (l && (/^[-*+]/.test(l[2]) || l[2].startsWith('1')) && (l[3] ?? '').trim()) return true
  if (nextLine !== undefined && line.includes('|') && RE.tableDelim.test(nextLine) && nextLine.includes('-')) return true
  return false
}

function parseList(lines, start, depth) {
  const first = RE.list.exec(lines[start])
  const ordered = /\d/.test(first[2])
  const base = first[1].length
  const items = []
  let i = start
  while (i < lines.length) {
    const m = RE.list.exec(lines[i])
    if (!m || /\d/.test(m[2]) !== ordered || m[1].length < base || m[1].length > base + 3 || RE.hr.test(lines[i])) break
    const markerEnd = m[1].length + m[2].length
    const spaces = lines[i].slice(markerEnd).match(/^[ \t]*/)[0].length
    const offset = (m[3] ?? '').trim() ? markerEnd + Math.min(Math.max(spaces, 1), 4) : markerEnd + 1
    const itemLines = [m[3] ?? '']
    i++
    let prevBlank = false
    while (i < lines.length) {
      const L = lines[i]
      if (blank(L)) {
        let j = i
        while (j < lines.length && blank(lines[j])) j++
        if (j < lines.length && indentOf(lines[j]) >= offset) { for (; i < j; i++) itemLines.push(''); prevBlank = true; continue }
        break
      }
      if (indentOf(L) >= offset) { itemLines.push(L.replace(/^(?: {1,4}|\t){0,1}/, '').slice(0).replace(new RegExp(`^ {0,${offset}}`), '')); i++; prevBlank = false; continue }
      if (!prevBlank && !startsBlock(L, lines[i + 1]) && !RE.list.test(L)) { itemLines.push(L.trim()); i++; continue } // lazy paragraph continuation
      break
    }
    let task = null
    const t = /^\[( |x|X)\][ \t]+/.exec(itemLines[0])
    if (t) { task = t[1] !== ' '; itemLines[0] = itemLines[0].slice(t[0].length) }
    items.push({ task, blocks: depth >= MAX_DEPTH ? [{ t: 'p', c: parseInline(itemLines.join('\n').trim()) }] : parseBlocks(itemLines, depth + 1) })
    let j = i
    while (j < lines.length && blank(lines[j])) j++
    const nm = j < lines.length ? RE.list.exec(lines[j]) : null
    if (nm && /\d/.test(nm[2]) === ordered && nm[1].length >= base && nm[1].length <= base + 3 && !RE.hr.test(lines[j])) i = j
    else break
  }
  return { node: { t: 'list', ordered, start: ordered ? Number(first[2].replace(/\D/g, '')) : 1, items }, next: i }
}

export function parseBlocks(lines, depth = 0) {
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (blank(line)) { i++; continue }
    let m
    if ((m = RE.fence.exec(line)) && !(m[2][0] === '`' && m[3].includes('`'))) {
      const indent = m[1].length
      const info = m[3].trim()
      const body = []
      let closed = false
      i++
      for (; i < lines.length; i++) {
        const t = lines[i].trim()
        if (t.length >= m[2].length && t[0] === m[2][0] && [...t].every((ch) => ch === m[2][0])) { closed = true; i++; break }
        body.push(indent ? lines[i].replace(new RegExp(`^ {0,${indent}}`), '') : lines[i])
      }
      const lang = (info.split(/\s+/)[0] || '').replace(/^\{?\.?/, '').replace(/[^\w+#.-]/g, '').slice(0, 24).toLowerCase()
      const title = /title\s*=\s*"([^"]{1,100})"/.exec(info)?.[1] ?? null
      blocks.push({ t: 'code', lang, title, text: body.join('\n'), closed })
      continue
    }
    if ((m = RE.atx.exec(line))) { blocks.push({ t: 'h', level: m[1].length, c: parseInline((m[2] ?? '').trim()) }); i++; continue }
    if (RE.hr.test(line)) { blocks.push({ t: 'hr' }); i++; continue }
    if (RE.quote.test(line)) {
      const inner = []
      while (i < lines.length && (RE.quote.test(lines[i]) || (!blank(lines[i]) && inner.length && !startsBlock(lines[i], lines[i + 1])))) {
        inner.push(RE.quote.test(lines[i]) ? lines[i].replace(/^ {0,3}> ?/, '') : lines[i])
        i++
      }
      blocks.push(depth >= MAX_DEPTH ? { t: 'p', c: parseInline(inner.join('\n')) } : { t: 'quote', blocks: parseBlocks(inner, depth + 1) })
      continue
    }
    if ((m = RE.list.exec(line)) && !RE.hr.test(line)) {
      const { node, next } = parseList(lines, i, depth)
      blocks.push(node)
      i = next
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && RE.tableDelim.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line)
      const delim = splitRow(lines[i + 1])
      if (head.length === delim.length && head.length <= 50) {
        const align = delim.map((d) => (d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? 'right' : d.startsWith(':') ? 'left' : null))
        const rows = []
        i += 2
        while (i < lines.length && !blank(lines[i]) && lines[i].includes('|') && rows.length < 500) {
          const cells = splitRow(lines[i])
          rows.push(head.map((_, k) => parseInline(cells[k] ?? '')))
          i++
        }
        blocks.push({ t: 'table', align, head: head.map((c) => parseInline(c)), rows })
        continue
      }
    }
    // paragraph (or setext heading)
    const para = [line.trim() === '' ? '' : line.replace(/^\s+/, '')]
    i++
    let heading = 0
    while (i < lines.length && !blank(lines[i])) {
      const s = RE.setext.exec(lines[i])
      if (s) { heading = s[1][0] === '=' ? 1 : 2; i++; break }
      if (startsBlock(lines[i], lines[i + 1])) break
      para.push(lines[i].replace(/^\s+/, ''))
      i++
    }
    const text = para.join('\n')
    blocks.push(heading ? { t: 'h', level: heading, c: parseInline(text) } : { t: 'p', c: parseInline(text) })
  }
  return blocks
}

/** Markdown source -> block AST. Inputs beyond 400 000 characters are cut. */
export function parseMarkdown(text) {
  let s = String(text ?? '')
  let cut = false
  if (s.length > MAX_INPUT) { s = s.slice(0, MAX_INPUT); cut = true }
  const blocks = parseBlocks(s.replace(/\r\n?/g, '\n').split('\n'))
  if (cut) blocks.push({ t: 'p', c: [{ t: 'em', c: [{ t: 'text', v: '[content truncated in this view]' }] }] })
  return blocks
}

/* ----------------------------------------------------------------------------------------- syntax highlighting */

const words = (s) => new Set(s.split(/\s+/).filter(Boolean))
const KW = {
  js: words('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await from as get set true false null undefined interface type enum implements private public protected readonly namespace declare abstract'),
  java: words('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record sealed permits'),
  c: words('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL nullptr class namespace template typename using new delete public private protected virtual override final constexpr noexcept operator this try catch throw'),
  cs: words('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await record'),
  go: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota make new len cap append panic recover'),
  rust: words('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err'),
  kotlin: words('abstract annotation as break by catch class companion const constructor continue crossinline data do else enum external false final finally for fun get if import in infix init inline inner interface internal is lateinit noinline null object open operator out override package private protected public reified return sealed set super suspend this throw true try typealias val var vararg when where while'),
  swift: words('associatedtype break case catch class continue default defer deinit do else enum extension fallthrough false fileprivate for func guard if import in init inout internal is let nil open operator private protocol public repeat rethrows return self Self static struct subscript super switch throw throws true try typealias var where while async await'),
  php: words('abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include instanceof insteadof interface isset list match namespace new null or print private protected public readonly require return static switch throw trait true false try unset use var while yield'),
  python: words('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self cls'),
  shell: words('if then else elif fi for while until do done case esac in function select return exit break continue local export readonly unset source alias echo cd set shift test true false'),
  sql: words('select from where and or not in is null like between join inner left right full outer cross on as group by order having limit offset union all distinct insert into values update set delete create table alter drop index view primary key foreign references default constraint unique check case when then else end exists asc desc with returning begin commit rollback transaction int integer text varchar char boolean date timestamp serial bigint float double decimal true false'),
}
const ALIAS = {
  js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', typescript: 'js', tsx: 'js', node: 'js',
  java: 'java', c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', hpp: 'c', cs: 'cs', csharp: 'cs', 'c#': 'cs', go: 'go', golang: 'go', rust: 'rust', rs: 'rust',
  kotlin: 'kotlin', kt: 'kotlin', swift: 'swift', php: 'php', dart: 'java', scala: 'java',
  python: 'python', py: 'python', python3: 'python', ruby: 'python', rb: 'python',
  bash: 'shell', sh: 'shell', shell: 'shell', zsh: 'shell', console: 'shell', fish: 'shell',
  sql: 'sql', pgsql: 'sql', mysql: 'sql', sqlite: 'sql', plsql: 'sql',
  html: 'markup', xml: 'markup', svg: 'markup', htm: 'markup', vue: 'markup', xhtml: 'markup',
  css: 'css', scss: 'css', less: 'css', json: 'json', jsonc: 'json', json5: 'json', yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml', diff: 'diff', patch: 'diff',
}
const FAMILY = (k) => (k === 'python' ? 'python' : k === 'shell' ? 'shell' : k === 'sql' ? 'sql' : 'clike')

const NUM = String.raw`0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[a-zA-Z]{0,3}`
const SCANNERS = {
  clike: new RegExp(String.raw`(?<com>\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(?<str>"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|` + '`(?:\\\\.|[^`\\\\])*`?' + String.raw`)|(?<num>\b(?:${NUM})\b)|(?<id>[A-Za-z_$][\w$]*)|(?<attr>@[A-Za-z_][\w.]*)`, 'y'),
  python: new RegExp(String.raw`(?<com>#[^\n]*)|(?<str>(?:[rbfuRBFU]{1,2})?(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'))|(?<num>\b(?:${NUM})\b)|(?<id>[A-Za-z_]\w*)|(?<attr>@[A-Za-z_][\w.]*)`, 'y'),
  shell: new RegExp(String.raw`(?<com>(?:^|(?<=\s))#[^\n]*)|(?<str>"(?:\\.|[^"\\])*"|'[^']*')|(?<var>\$(?:\{[^}\n]*\}|\w+|[@#?$!*-]))|(?<attr>(?<=\s|^)--?[A-Za-z][\w-]*)|(?<num>\b\d+\b)|(?<id>[A-Za-z_][\w-]*)`, 'y'),
  sql: new RegExp(String.raw`(?<com>--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(?<str>'(?:''|[^'])*'?)|(?<num>\b(?:${NUM})\b)|(?<id>[A-Za-z_]\w*)`, 'y'),
  css: new RegExp(String.raw`(?<com>\/\*[\s\S]*?(?:\*\/|$))|(?<str>"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(?<kw>@[\w-]+)|(?<num>#[\da-fA-F]{3,8}\b|-?\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|ch|s|ms|deg|fr)?\b)|(?<fn>[\w-]+(?=\())|(?<attr>[\w-]+(?=\s*:))|(?<ty>[.#][\w-]+)|(?<id>[\w-]+)`, 'y'),
  json: new RegExp(String.raw`(?<key>"(?:\\.|[^"\\\n])*"(?=\s*:))|(?<str>"(?:\\.|[^"\\\n])*")|(?<num>-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(?<kw>\b(?:true|false|null)\b)`, 'y'),
  yaml: new RegExp(String.raw`(?<com>(?:^|(?<=\s))#[^\n]*)|(?<key>(?<=^|\n)[ \t]*(?:- )?[\w."'/-]+(?=:(?:\s|$)))|(?<str>"(?:\\.|[^"\\\n])*"|'(?:''|[^'\n])*')|(?<num>-?\b\d+(?:\.\d+)?\b)|(?<kw>\b(?:true|false|null|yes|no|on|off)\b)`, 'y'),
}
const CLASS_OF = { com: 'com', str: 'str', num: 'num', attr: 'attr', var: 'var', key: 'key', kw: 'kw', fn: 'fn', ty: 'ty' }

function scan(code, re, keywords, family) {
  const out = []
  let plain = ''
  const push = (cls, text) => { if (cls) { if (plain) { out.push([null, plain]); plain = '' } out.push([cls, text]) } else plain += text }
  let pos = 0
  while (pos < code.length) {
    re.lastIndex = pos
    const m = re.exec(code)
    if (!m || m[0] === '') { plain += code[pos]; pos++; continue }
    const g = m.groups
    let cls = null
    for (const k of Object.keys(g)) if (g[k] !== undefined && k !== 'id') { cls = CLASS_OF[k]; break }
    if (!cls && g.id !== undefined) {
      const id = m[0]
      const next = code[pos + id.length]
      const isKw = keywords && (family === 'sql' ? keywords.has(id.toLowerCase()) : keywords.has(id))
      cls = isKw ? 'kw' : next === '(' ? 'fn' : /^[A-Z][a-z]/.test(id) && family !== 'shell' && family !== 'sql' && family !== 'css' ? 'ty' : null
    }
    push(cls, m[0])
    pos += m[0].length
  }
  if (plain) out.push([null, plain])
  return out
}

function tokenizeMarkup(code) {
  const out = []
  const add = (cls, text) => { if (text) out.push([cls, text]) }
  let i = 0
  while (i < code.length) {
    const lt = code.indexOf('<', i)
    if (lt === -1) { add(null, code.slice(i)); break }
    add(null, code.slice(i, lt))
    if (code.startsWith('<!--', lt)) {
      const e = code.indexOf('-->', lt + 4)
      const end = e === -1 ? code.length : e + 3
      add('com', code.slice(lt, end))
      i = end
      continue
    }
    const open = /^<\/?(?:[A-Za-z][\w:-]*|!doctype)/i.exec(code.slice(lt, lt + 80))
    if (!open) { add(null, '<'); i = lt + 1; continue }
    add('tag', open[0])
    let j = lt + open[0].length
    const tagName = open[0].replace(/^<\/?/, '').toLowerCase()
    // attributes until '>'
    for (;;) {
      const ws = /^\s+/.exec(code.slice(j, j + 200))
      if (ws) { add(null, ws[0]); j += ws[0].length }
      if (j >= code.length) break
      if (code[j] === '>' || (code[j] === '/' && code[j + 1] === '>')) { const t = code[j] === '/' ? '/>' : '>'; add('tag', t); j += t.length; break }
      const attr = /^[^\s=>/"'<]+/.exec(code.slice(j, j + 200))
      if (attr) { add('attr', attr[0]); j += attr[0].length; continue }
      if (code[j] === '=') { add(null, '='); j++; continue }
      const str = /^(?:"[^"]*"|'[^']*')/.exec(code.slice(j, j + 4000))
      if (str) { add('str', str[0]); j += str[0].length; continue }
      add(null, code[j]); j++
    }
    i = j
    if ((tagName === 'script' || tagName === 'style') && !open[0].startsWith('</')) {
      const close = code.toLowerCase().indexOf(`</${tagName}`, i)
      const end = close === -1 ? code.length : close
      for (const tok of tokenizeCode(code.slice(i, end), tagName === 'script' ? 'js' : 'css')) out.push(tok)
      i = end
    }
  }
  return out
}

function tokenizeDiff(code) {
  const out = []
  for (const line of code.split('\n')) {
    const cls = /^(\+\+\+|---)/.test(line) ? 'attr' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'attr' : null
    out.push([cls, line + '\n'])
  }
  if (out.length) out[out.length - 1][1] = out[out.length - 1][1].slice(0, -1)
  return out
}

/** Light syntax highlighting. Always returns a lossless tokenisation: concatenating the texts gives back `code`. */
export function tokenizeCode(code, lang = '') {
  const s = String(code)
  if (s.length > 100_000) return [[null, s]]
  const key = ALIAS[String(lang).toLowerCase()]
  if (!key) return [[null, s]]
  try {
    if (key === 'markup') return tokenizeMarkup(s)
    if (key === 'diff') return tokenizeDiff(s)
    if (key === 'css') return scan(s, SCANNERS.css, null, 'css')
    if (key === 'json') return scan(s, SCANNERS.json, null, 'json')
    if (key === 'yaml') return scan(s, SCANNERS.yaml, null, 'yaml')
    const fam = FAMILY(key)
    return scan(s, SCANNERS[fam], KW[key], fam)
  } catch {
    return [[null, s]]
  }
}

/* ----------------------------------------------------------------------------------------- DOM */

function el(tag, cls, ...kids) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  for (const k of kids) if (k != null) e.append(k)
  return e
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true } catch { /* fall through */ }
  try {
    const ta = el('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.className = 'ai-offscreen'
    document.body.append(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch { return false }
}

/** A code block: language label, copy button and highlighted <pre><code>. */
export function renderCode(code, lang = '', { copy = true, highlight = true, title = null } = {}) {
  const codeEl = el('code')
  if (lang) codeEl.className = `ai-lang-${lang.replace(/[^\w-]/g, '')}`
  if (highlight && lang) for (const [cls, text] of tokenizeCode(code, lang)) codeEl.append(cls ? el('span', `ai-tok ai-tok-${cls}`, text) : document.createTextNode(text))
  else codeEl.textContent = code
  const head = el('div', 'ai-code-head', el('span', 'ai-code-lang', title ? `${title}${lang ? ` · ${lang}` : ''}` : lang || 'text'))
  if (copy) {
    const btn = el('button', 'ai-code-copy', 'Copy')
    btn.type = 'button'
    btn.setAttribute('aria-label', 'Copy code to clipboard')
    btn.addEventListener('click', async () => {
      const ok = await copyText(code)
      btn.textContent = ok ? 'Copied' : 'Copy failed'
      setTimeout(() => { btn.textContent = 'Copy' }, 1500)
    })
    head.append(btn)
  }
  const pre = el('pre', 'ai-code-pre', codeEl)
  pre.tabIndex = 0 // keyboard users can scroll long lines
  return el('div', 'ai-code', head, pre)
}

function renderInline(nodes, opts) {
  const frag = document.createDocumentFragment()
  for (const n of nodes) {
    if (n.t === 'text') {
      if (!opts.breaks || !n.v.includes('\n')) frag.append(document.createTextNode(n.v))
      else n.v.split('\n').forEach((part, i) => { if (i) frag.append(el('br')); if (part) frag.append(document.createTextNode(part)) })
    } else if (n.t === 'code') frag.append(el('code', 'ai-md-code', n.v))
    else if (n.t === 'br') frag.append(el('br'))
    else if (n.t === 'strong') frag.append(el('strong', '', renderInline(n.c, opts)))
    else if (n.t === 'em') frag.append(el('em', '', renderInline(n.c, opts)))
    else if (n.t === 'del') frag.append(el('del', '', renderInline(n.c, opts)))
    else if (n.t === 'link') {
      const a = el('a', 'ai-md-link', renderInline(n.c, opts))
      a.href = n.href // already validated by safeUrl()
      a.target = '_blank'
      a.rel = 'noopener noreferrer nofollow'
      if (n.title) a.title = n.title
      frag.append(a)
    }
  }
  return frag
}

function renderBlocks(blocks, opts) {
  const frag = document.createDocumentFragment()
  for (const b of blocks) {
    switch (b.t) {
      case 'p': frag.append(el('p', 'ai-md-p', renderInline(b.c, opts))); break
      case 'h': frag.append(el(`h${Math.min(6, b.level + 1)}`, `ai-md-h ai-md-h${b.level}`, renderInline(b.c, opts))); break
      case 'hr': frag.append(el('hr', 'ai-md-hr')); break
      case 'quote': frag.append(el('blockquote', 'ai-md-quote', renderBlocks(b.blocks, opts))); break
      case 'code': {
        const node = renderCode(b.text, b.lang, { copy: opts.copy, highlight: opts.highlight, title: b.title })
        if (!b.closed) node.classList.add('ai-code-open')
        frag.append(node)
        break
      }
      case 'list': {
        const list = el(b.ordered ? 'ol' : 'ul', 'ai-md-list')
        if (b.ordered && b.start !== 1) list.start = b.start
        for (const it of b.items) {
          const li = el('li', it.task !== null ? 'ai-md-task' : '')
          if (it.task !== null) {
            const cb = el('input')
            cb.type = 'checkbox'
            cb.disabled = true
            cb.checked = it.task
            cb.setAttribute('aria-label', it.task ? 'done' : 'not done')
            li.append(cb, ' ')
          }
          li.append(renderBlocks(it.blocks, opts))
          list.append(li)
        }
        frag.append(list)
        break
      }
      case 'table': {
        const head = el('tr')
        b.head.forEach((c, i) => { const th = el('th', '', renderInline(c, opts)); th.scope = 'col'; if (b.align[i]) th.classList.add(`ai-align-${b.align[i]}`); head.append(th) })
        const body = el('tbody')
        for (const row of b.rows) {
          const tr = el('tr')
          row.forEach((c, i) => { const td = el('td', b.align[i] ? `ai-align-${b.align[i]}` : '', renderInline(c, opts)); tr.append(td) })
          body.append(tr)
        }
        frag.append(el('div', 'ai-md-table', el('table', '', el('thead', '', head), body)))
        break
      }
      default: break
    }
  }
  return frag
}

/** Render markdown text into a DocumentFragment (DOM APIs only; never HTML strings). */
export function renderMarkdown(text, opts = {}) {
  const o = { breaks: true, copy: true, highlight: true, ...opts }
  return renderBlocks(parseMarkdown(text), o)
}
