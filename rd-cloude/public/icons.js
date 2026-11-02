// Tiny stroke-icon set (24x24 viewBox, currentColor). Built with createElementNS so it is CSP-safe (no innerHTML, no inline style).
// icon('compute') -> <svg aria-hidden="true">. Unknown names fall back to a generic dot-grid icon.
const NS = 'http://www.w3.org/2000/svg'
const P = {
  home: ['M3 11l9-8 9 8', 'M5 10v10h5v-6h4v6h5V10'],
  chat: ['M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z'],
  projects: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  prompts: ['M4 5h16v11H9l-5 4z', 'M8 9h8', 'M8 12h5'],
  artifacts: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M12 12l8-4.5', 'M12 12v9', 'M12 12L4 7.5'],
  compute: ['M4 5h16v6H4z', 'M4 13h16v6H4z', 'M8 8h.01', 'M8 16h.01'],
  network: ['M12 3v5', 'M5 21v-5h14v5', 'M12 8l-7 8', 'M12 8l7 8', 'M9 3h6v5H9z'],
  functions: ['M13 2L4 14h7l-1 8 9-12h-7z'],
  database: ['M4 6c0 1.7 3.6 3 8 3s8-1.3 8-3-3.6-3-8-3-8 1.3-8 3z', 'M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6', 'M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6'],
  sql: ['M4 6c0 1.7 3.6 3 8 3s8-1.3 8-3-3.6-3-8-3-8 1.3-8 3z', 'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6', 'M9 13l-2 2 2 2', 'M15 13l2 2-2 2'],
  drive: ['M3 15l3-9h12l3 9z', 'M3 15v4h18v-4', 'M17 17h.01'],
  storage: ['M3 8l9-5 9 5-9 5z', 'M3 8v8l9 5 9-5V8', 'M12 13v8'],
  monitoring: ['M3 12h4l3-8 4 16 3-8h4'],
  usage: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  security: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M9 12l2 2 4-4'],
  keys: ['M14.5 9.5a4.5 4.5 0 1 1-1.2-3', 'M13.3 9.7L21 17.4', 'M17 13.4l2 2', 'M20 16.4l1.5 1.5'].slice(0, 3).concat(['M7 8h.01']),
  team: ['M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1', 'M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M21 20v-1a4 4 0 0 0-3-3.9', 'M16 4.2a3.5 3.5 0 0 1 0 6.6'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
  bell: ['M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.7 21a2 2 0 0 1-3.4 0'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  sun: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
  moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
  auto: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 3v18', 'M12 3a9 9 0 0 1 0 18'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  plus: ['M12 5v14', 'M5 12h14'],
  x: ['M18 6L6 18', 'M6 6l12 12'],
  check: ['M20 6L9 17l-5-5'],
  action: ['M5 12h14', 'M13 6l6 6-6 6'],
  default: ['M5 5h4v4H5z', 'M15 5h4v4h-4z', 'M5 15h4v4H5z', 'M15 15h4v4h-4z'],
}

export function icon(name, size) {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  if (size) { svg.setAttribute('width', size); svg.setAttribute('height', size) }
  for (const d of P[name] ?? P.default) {
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}
