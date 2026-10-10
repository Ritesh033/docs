// Usage metering + simple pricing shared by every service.
export const PRICES = {
  'ai.input_tokens': { unit: 'per 1M tokens', price: 3 },
  'ai.output_tokens': { unit: 'per 1M tokens', price: 15 },
  'storage.gb_month': { unit: 'per GB-month', price: 0.023 },
  'compute.small': { unit: 'per hour', price: 0.01 },
  'compute.medium': { unit: 'per hour', price: 0.04 },
  'compute.large': { unit: 'per hour', price: 0.16 },
}

export const INSTANCE_TYPES = {
  small: { vcpu: 1, memGb: 2 },
  medium: { vcpu: 2, memGb: 8 },
  large: { vcpu: 8, memGb: 32 },
}

export function record(db, userId, kind, qty) {
  db.insert('usage', { userId, kind, qty })
}

const GB = 1024 ** 3

function cost(kind, qty) {
  const p = PRICES[kind]?.price ?? 0
  if (kind.startsWith('ai.')) return (qty / 1e6) * p
  return qty * p
}

export function instanceHours(inst, now = Date.now()) {
  let ms = inst.accruedMs ?? 0
  if (inst.state === 'running' && inst.runningSince) ms += now - new Date(inst.runningSince).getTime()
  return ms / 36e5
}

export function summarize(db, userId) {
  const lines = {}
  const add = (kind, qty) => {
    lines[kind] ??= { kind, qty: 0, cost: 0, ...PRICES[kind] }
    lines[kind].qty += qty
  }
  for (const u of db.find('usage', (x) => x.userId === userId)) add(u.kind, u.qty)
  for (const i of db.find('instances', (x) => x.userId === userId)) {
    const h = instanceHours(i)
    if (h > 0) add(`compute.${i.type}`, h)
  }
  const bytes =
    db.find('objects', (o) => o.userId === userId).reduce((s, o) => s + o.size, 0) +
    db.find('files', (f) => f.userId === userId).reduce((s, f) => s + f.versions.reduce((a, v) => a + v.size, 0), 0)
  if (bytes) add('storage.gb_month', bytes / GB)
  const out = Object.values(lines).map((l) => ({ ...l, cost: +cost(l.kind, l.qty).toFixed(6) }))
  return { lines: out, total: +out.reduce((s, l) => s + l.cost, 0).toFixed(6), storageBytes: bytes }
}

export function billingRoutes(r, db) {
  r.get('/api/billing/usage', ({ user }) => summarize(db, user.id))
  r.get('/api/billing/prices', () => ({ prices: PRICES, instanceTypes: INSTANCE_TYPES }))
}
