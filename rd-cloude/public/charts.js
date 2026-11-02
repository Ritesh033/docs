// Tiny accessible SVG charts (no dependencies). Colours come from CSS classes in ui/charts.css so themes and CSP just work.
// Every chart is role="img" with <title>/<desc>; interactive marks are focusable and carry a <title> tooltip.
const NS = 'http://www.w3.org/2000/svg'
export const PALETTE_SIZE = 8

export function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v === true ? '' : String(v))
  el.append(...kids.flat().filter((x) => x != null && x !== false))
  return el
}
const text = (str) => document.createTextNode(String(str))
const niceMax = (v) => {
  if (!(v > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const n = v / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p
}
const fmt = (n) => (Math.abs(n) >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : `${+n.toFixed(Math.abs(n) < 1 ? 3 : 1)}`)

let uid = 0
function frame(width, height, title, desc, cls) {
  const n = ++uid
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', class: `ch ${cls ?? ''}`, preserveAspectRatio: 'xMidYMid meet', 'aria-labelledby': `cht${n} chd${n}` },
    s('title', { id: `cht${n}` }, text(title)), s('desc', { id: `chd${n}` }, text(desc ?? title)))
  return svg
}

/**
 * Stacked bars. data: [{label, parts: {seriesName: number}}]. opts: {title, desc, height, format}
 */
export function stackedBars(data, opts = {}) {
  const W = 640, H = opts.height ?? 220, m = { l: 44, r: 8, t: 8, b: 24 }
  const series = [...new Set(data.flatMap((d) => Object.keys(d.parts)))]
  const totals = data.map((d) => Object.values(d.parts).reduce((a, b) => a + b, 0))
  const max = niceMax(Math.max(0, ...totals))
  const f = opts.format ?? fmt
  const svg = frame(W, H, opts.title ?? 'Bar chart', opts.desc ?? `${data.length} bars`, 'ch-bars')
  const iw = W - m.l - m.r, ih = H - m.t - m.b
  for (let i = 0; i <= 4; i++) {
    const y = m.t + ih - (ih * i) / 4
    svg.append(s('line', { class: 'ch-grid', x1: m.l, x2: W - m.r, y1: y, y2: y }), s('text', { class: 'ch-axis', x: m.l - 6, y: y + 4, 'text-anchor': 'end' }, text(f((max * i) / 4))))
  }
  const bw = iw / Math.max(1, data.length)
  data.forEach((d, i) => {
    let y = m.t + ih
    const g = s('g', { class: 'ch-bar', tabindex: 0, role: 'group', 'aria-label': `${d.label}: ${f(totals[i])}` }, s('title', {}, text(`${d.label}\n${Object.entries(d.parts).map(([k, v]) => `${k}: ${f(v)}`).join('\n')}\nTotal: ${f(totals[i])}`)))
    for (const name of series) {
      const v = d.parts[name] ?? 0
      if (v <= 0) continue
      const h = (v / max) * ih
      y -= h
      const w = Math.min(bw * 0.7, 40) // single bars should not stretch across the chart
      g.append(s('rect', { class: `ch-c${series.indexOf(name) % PALETTE_SIZE}`, x: m.l + i * bw + (bw - w) / 2, y, width: w, height: Math.max(0.5, h), rx: 1.5 }))
    }
    svg.append(g)
    if (data.length <= 12 || i % Math.ceil(data.length / 8) === 0) svg.append(s('text', { class: 'ch-axis', x: m.l + i * bw + bw / 2, y: H - 6, 'text-anchor': 'middle' }, text(d.label)))
  })
  return svg
}

/** Line/area chart. series: [{name, points:[{x:label, y:number}]}] all same length. */
export function lineChart(series, opts = {}) {
  const W = 640, H = opts.height ?? 200, m = { l: 44, r: 10, t: 8, b: 24 }
  const n = Math.max(1, ...series.map((x) => x.points.length))
  const max = niceMax(opts.max ?? Math.max(0, ...series.flatMap((x) => x.points.map((p) => p.y))))
  const f = opts.format ?? fmt
  const svg = frame(W, H, opts.title ?? 'Line chart', opts.desc ?? series.map((x) => x.name).join(', '), 'ch-line')
  const iw = W - m.l - m.r, ih = H - m.t - m.b
  for (let i = 0; i <= 4; i++) {
    const y = m.t + ih - (ih * i) / 4
    svg.append(s('line', { class: 'ch-grid', x1: m.l, x2: W - m.r, y1: y, y2: y }), s('text', { class: 'ch-axis', x: m.l - 6, y: y + 4, 'text-anchor': 'end' }, text(f((max * i) / 4))))
  }
  const X = (i) => m.l + (n === 1 ? iw / 2 : (iw * i) / (n - 1)), Y = (v) => m.t + ih - (Math.min(v, max) / max) * ih
  series.forEach((ser, si) => {
    if (!ser.points.length) return
    const d = ser.points.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join('')
    if (opts.area) svg.append(s('path', { class: `ch-area ch-c${si % PALETTE_SIZE}`, d: `${d}L${X(ser.points.length - 1)},${m.t + ih}L${X(0)},${m.t + ih}Z` }))
    svg.append(s('path', { class: `ch-stroke ch-s${si % PALETTE_SIZE}`, d, fill: 'none' }))
    ser.points.forEach((p, i) => {
      if (ser.points.length > 60) return
      svg.append(s('circle', { class: `ch-dot ch-c${si % PALETTE_SIZE}`, cx: X(i), cy: Y(p.y), r: 3, tabindex: 0, 'aria-label': `${ser.name} ${p.x}: ${f(p.y)}` }, s('title', {}, text(`${ser.name} · ${p.x}: ${f(p.y)}`))))
    })
  })
  const labels = series[0]?.points ?? []
  labels.forEach((p, i) => { if (labels.length <= 10 || i % Math.ceil(labels.length / 7) === 0) svg.append(s('text', { class: 'ch-axis', x: X(i), y: H - 6, 'text-anchor': 'middle' }, text(p.x))) })
  return svg
}

/** Inline sparkline of numbers. */
export function sparkline(values, opts = {}) {
  const W = opts.width ?? 120, H = opts.height ?? 28
  const svg = frame(W, H, opts.title ?? 'Trend', opts.desc ?? `${values.length} values, last ${values.at(-1) ?? 0}`, 'ch-spark')
  if (values.length < 2) return svg
  const max = Math.max(...values, opts.min0 ? 0 : -Infinity), min = opts.min0 ? 0 : Math.min(...values)
  const span = max - min || 1
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((W * i) / (values.length - 1)).toFixed(1)},${(H - 2 - ((v - min) / span) * (H - 4)).toFixed(1)}`).join('')
  svg.append(s('path', { class: 'ch-stroke ch-s0', d, fill: 'none' }))
  return svg
}

/** Donut. items: [{label, value}] */
export function donut(items, opts = {}) {
  const S = opts.size ?? 160, R = S / 2 - 8, C = S / 2
  const total = items.reduce((a, b) => a + b.value, 0)
  const svg = frame(S, S, opts.title ?? 'Breakdown', opts.desc ?? items.map((i) => `${i.label} ${fmt(i.value)}`).join(', '), 'ch-donut')
  if (!(total > 0)) { svg.append(s('circle', { class: 'ch-grid', cx: C, cy: C, r: R, fill: 'none', 'stroke-width': 18 })); return svg }
  const live = items.filter((it) => it.value > 0)
  let a0 = -Math.PI / 2
  items.forEach((it, i) => {
    if (it.value <= 0) return
    if (live.length === 1) { // a single full ring (an arc from a point to itself would be invisible)
      svg.append(s('circle', { class: `ch-arc ch-s${i % PALETTE_SIZE}`, cx: C, cy: C, r: R, fill: 'none', 'stroke-width': 18, tabindex: 0, 'aria-label': `${it.label}: ${fmt(it.value)} (100%)` }, s('title', {}, text(`${it.label}: ${fmt(it.value)} (100%)`))))
      return
    }
    const a1 = a0 + (it.value / total) * Math.PI * 2 - (items.length > 1 ? 0.01 : 0)
    const large = a1 - a0 > Math.PI ? 1 : 0
    const p = (a) => `${(C + R * Math.cos(a)).toFixed(2)},${(C + R * Math.sin(a)).toFixed(2)}`
    svg.append(s('path', { class: `ch-arc ch-s${i % PALETTE_SIZE}`, d: `M${p(a0)}A${R},${R} 0 ${large} 1 ${p(a1)}`, fill: 'none', 'stroke-width': 18, tabindex: 0, 'aria-label': `${it.label}: ${fmt(it.value)} (${((it.value / total) * 100).toFixed(1)}%)` },
      s('title', {}, text(`${it.label}: ${fmt(it.value)} (${((it.value / total) * 100).toFixed(1)}%)`))))
    a0 = a1 + 0.01
  })
  if (opts.center) svg.append(s('text', { class: 'ch-center', x: C, y: C + 5, 'text-anchor': 'middle' }, text(opts.center)))
  return svg
}

/** Legend as DOM (h passed in to avoid a circular import). */
export function legend(h, names) {
  return h('ul', { class: 'ch-legend' }, names.map((n, i) => h('li', {}, h('span', { class: `ch-swatch ch-b${i % PALETTE_SIZE}`, 'aria-hidden': 'true' }), n)))
}
