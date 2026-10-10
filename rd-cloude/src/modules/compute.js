// Compute service module (auto-loaded by src/app.js).
import { HttpError, required } from '../http.js'
import { INSTANCE_TYPES, instanceHours } from '../billing.js'

export function register(r, db, ctx) {
  const own = (col, id, user) => {
    const row = db.get(col, id)
    if (!row || row.userId !== user.id) throw new HttpError(404, 'Not found')
    return row
  }

  // ---- Compute (simulated VM lifecycle with real metering) ----
  const view = (i) => ({ ...i, hoursRunning: +instanceHours(i).toFixed(4) })
  r.get('/api/compute/instances', ({ user }) => ({
    instances: db.find('instances', (i) => i.userId === user.id && i.state !== 'terminated').map(view),
  }))
  r.post('/api/compute/instances', ({ user, body }) => {
    required(body, 'name')
    const type = body.type || 'small'
    if (!INSTANCE_TYPES[type]) throw new HttpError(400, `Unknown type. Use one of: ${Object.keys(INSTANCE_TYPES).join(', ')}`)
    const inst = db.insert('instances', {
      userId: user.id, name: body.name, type, ...INSTANCE_TYPES[type], region: body.region || 'rd-east-1',
      state: 'running', runningSince: new Date().toISOString(), accruedMs: 0,
      ip: `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 253)}`,
    })
    return [201, view(inst)]
  })
  const transition = (action, from, to) =>
    r.post(`/api/compute/instances/:id/${action}`, ({ user, params }) => {
      const i = own('instances', params.id, user)
      if (!from.includes(i.state)) throw new HttpError(409, `Cannot ${action} an instance that is ${i.state}`)
      const patch = { state: to }
      if (to === 'running') patch.runningSince = new Date().toISOString()
      else {
        patch.accruedMs = (i.accruedMs ?? 0) + (i.runningSince ? Date.now() - new Date(i.runningSince).getTime() : 0)
        patch.runningSince = null
      }
      return view(db.update('instances', i.id, patch))
    })
  transition('start', ['stopped'], 'running')
  transition('stop', ['running'], 'stopped')
  transition('terminate', ['running', 'stopped'], 'terminated')

}
